//! Local encrypted credentials. No Keychain, plaintext config, or frontend DB-password read API.
use crate::{
    error::{AppError, AppResult},
    models::ConnectionConfig,
};
use ring::{
    aead, digest,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
static LOCK: Mutex<()> = Mutex::new(());
#[derive(Serialize, Deserialize)]
struct Sealed {
    nonce: [u8; 12],
    data: Vec<u8>,
}
type Vault = BTreeMap<String, Sealed>;

pub fn account(config: &ConnectionConfig) -> String {
    let identity = serde_json::to_vec(&(
        &config.id,
        &config.kind,
        &config.host,
        config.port,
        &config.username,
        &config.database,
        &config.ssl_mode,
    ))
    .expect("serializable connection identity");
    digest::digest(&digest::SHA256, &identity)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn directory(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| AppError::msg("无法定位凭据目录"))?
        .join("credentials"))
}
fn plain_file(path: &Path) -> AppResult<()> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(AppError::msg("凭据路径不能是符号链接"));
        }
    }
    Ok(())
}
fn private_dir(dir: &Path) -> AppResult<()> {
    plain_file(dir)?;
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn key(dir: &Path, create: bool) -> AppResult<[u8; 32]> {
    let path = dir.join("local.key");
    plain_file(&path)?;
    if !path.exists() && create {
        let mut bytes = [0u8; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| AppError::msg("无法生成凭据密钥"))?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(&bytes)?;
                file.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    fs::read(path)?
        .try_into()
        .map_err(|_| AppError::msg("本地凭据密钥损坏"))
}
fn read_vault(dir: &Path) -> AppResult<Vault> {
    plain_file(dir)?;
    let path = dir.join("credentials.json");
    plain_file(&path)?;
    if !path.exists() {
        return Ok(Vault::new());
    }
    serde_json::from_slice(&fs::read(path)?)
        .map_err(|_| AppError::msg("本地凭据文件损坏，未覆盖原文件"))
}
fn cipher(key: &[u8; 32]) -> AppResult<aead::LessSafeKey> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key)
        .map(aead::LessSafeKey::new)
        .map_err(|_| AppError::msg("凭据加密初始化失败"))
}
fn write_vault(dir: &Path, vault: &Vault) -> AppResult<()> {
    let target = dir.join("credentials.json");
    plain_file(&target)?;
    let tmp = dir.join(format!(".credentials-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&serde_json::to_vec(vault)?)?;
        file.sync_all()?;
        fs::rename(&tmp, &target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
fn load_at(dir: &Path, id: &str) -> AppResult<Option<String>> {
    let vault = read_vault(dir)?;
    let Some(sealed) = vault.get(id) else {
        return Ok(None);
    };
    let mut bytes = sealed.data.clone();
    let cipher = cipher(&key(dir, false)?)?;
    let plain = cipher
        .open_in_place(
            aead::Nonce::assume_unique_for_key(sealed.nonce),
            aead::Aad::from(id.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| AppError::msg("本地凭据无法解密或校验失败"))?;
    String::from_utf8(plain.to_vec())
        .map(Some)
        .map_err(|_| AppError::msg("本地凭据格式无效"))
}
fn save_at(dir: &Path, id: &str, password: &str) -> AppResult<()> {
    private_dir(dir)?;
    let mut vault = read_vault(dir)?;
    // A missing key must not replace one that encrypted existing records.
    let encryption_key = key(dir, vault.is_empty())?;
    let mut nonce = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| AppError::msg("无法生成凭据随机数"))?;
    let mut data = password.as_bytes().to_vec();
    cipher(&encryption_key)?
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(id.as_bytes()),
            &mut data,
        )
        .map_err(|_| AppError::msg("凭据加密失败"))?;
    vault.insert(id.to_owned(), Sealed { nonce, data });
    write_vault(dir, &vault)
}
pub fn load(app: &AppHandle, config: &ConnectionConfig) -> AppResult<Option<String>> {
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    load_at(&directory(app)?, &account(config))
}
pub fn save(app: &AppHandle, config: &ConnectionConfig, password: &str) -> AppResult<()> {
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    save_at(&directory(app)?, &account(config), password)
}
pub fn remove(app: &AppHandle, config: &ConnectionConfig) -> AppResult<()> {
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    let dir = directory(app)?;
    let mut vault = read_vault(&dir)?;
    if vault.remove(&account(config)).is_some() {
        write_vault(&dir, &vault)?;
    }
    Ok(())
}

// Service settings have a separate namespace and cannot retrieve DB passwords.
fn service_account(key: &str) -> AppResult<String> {
    match key {
        "ai.config" => Ok(format!("service:{key}")),
        _ => Err(AppError::msg("不支持的服务配置")),
    }
}
#[tauri::command]
pub fn load_service_config(app: AppHandle, key: String) -> AppResult<Option<String>> {
    let account = service_account(&key)?;
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    load_at(&directory(&app)?, &account)
}
#[tauri::command]
pub fn save_service_config(app: AppHandle, key: String, value: String) -> AppResult<()> {
    let account = service_account(&key)?;
    let _: serde_json::Value = serde_json::from_str(&value)?;
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    save_at(&directory(&app)?, &account, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_identity_tracks_endpoint_not_display_name() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "fixture", "name": "Original", "kind": "mysql", "host": "one",
            "port": 3306, "username": "tester", "database": "example"
        }))
        .unwrap();
        let mut changed = config.clone();
        changed.name = "Renamed".into();
        assert_eq!(account(&config), account(&changed));
        changed.host = "other".into();
        assert_ne!(account(&config), account(&changed));
        changed = config.clone();
        changed.username = "other".into();
        assert_ne!(account(&config), account(&changed));
        changed = config.clone();
        changed.ssl_mode = Some("require".into());
        assert_ne!(account(&config), account(&changed));
    }
    #[test]
    fn encrypted_roundtrip_update_permissions_and_tamper() {
        let dir =
            std::env::temp_dir().join(format!("sonde-vault-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_at(&dir, "one").unwrap(), None);
        save_at(&dir, "one", "test-secret-123").unwrap();
        save_at(&dir, "two", "").unwrap();
        assert_eq!(
            load_at(&dir, "one").unwrap().as_deref(),
            Some("test-secret-123")
        );
        assert_eq!(load_at(&dir, "two").unwrap().as_deref(), Some(""));
        assert!(
            !String::from_utf8(fs::read(dir.join("credentials.json")).unwrap())
                .unwrap()
                .contains("test-secret-123")
        );
        save_at(&dir, "one", "replacement").unwrap();
        assert_eq!(
            load_at(&dir, "one").unwrap().as_deref(),
            Some("replacement")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for file in ["local.key", "credentials.json"] {
                assert_eq!(
                    fs::metadata(dir.join(file)).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        let mut vault = read_vault(&dir).unwrap();
        vault.get_mut("one").unwrap().data[0] ^= 1;
        write_vault(&dir, &vault).unwrap();
        assert!(load_at(&dir, "one").is_err());
        fs::remove_file(dir.join("local.key")).unwrap();
        assert!(save_at(&dir, "three", "new").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
