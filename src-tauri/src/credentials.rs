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
/// Whether a sealed record exists. Does not decrypt, so the password never leaves the vault.
fn stored_at(dir: &Path, id: &str) -> AppResult<bool> {
    Ok(read_vault(dir)?.contains_key(id))
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
pub fn has_saved(app: &AppHandle, config: &ConnectionConfig) -> AppResult<bool> {
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    stored_at(&directory(app)?, &account(config))
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
/// Cloud base URL and API key. Only the Rust proxy may read this; IPC uses
/// [`present_service_config`], which replaces the key with `hasKey`.
pub struct CloudEndpoint {
    pub base_url: String,
    pub api_key: String,
}

/// Decrypted AI settings. The cloud API key is still in this string; only the
/// model proxy may read it.
pub fn ai_config_raw(app: &AppHandle) -> AppResult<Option<String>> {
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    load_at(&directory(app)?, &service_account("ai.config")?)
}

pub fn cloud_endpoint_from_config(raw: &str) -> AppResult<CloudEndpoint> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| AppError::msg("云端模型配置无效"))?;
    let cloud = value.get("cloud");
    let base_url = cloud
        .and_then(|item| item.get("baseUrl"))
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if base_url.is_empty() {
        return Err(AppError::msg("云端模型尚未配置接口地址"));
    }
    let api_key = clean_api_key(
        cloud
            .and_then(|item| item.get("apiKey"))
            .and_then(|item| item.as_str())
            .unwrap_or(""),
    )?;
    Ok(CloudEndpoint { base_url, api_key })
}

fn clean_api_key(key: &str) -> AppResult<String> {
    let key = key.trim().to_string();
    if key.contains(['\r', '\n', '\0']) {
        return Err(AppError::msg("API Key 无效"));
    }
    Ok(key)
}

/// What `load_service_config` is allowed to send across IPC.
pub fn present_service_config(key: &str, raw: &str) -> AppResult<String> {
    if key != "ai.config" {
        return Ok(raw.to_string());
    }
    let mut value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| AppError::msg("本地凭据文件损坏，未覆盖原文件"))?;
    let has_key = value
        .get("cloud")
        .and_then(|item| item.get("apiKey"))
        .and_then(|item| item.as_str())
        .is_some_and(|secret| !secret.trim().is_empty());
    if let Some(cloud) = value.get_mut("cloud").and_then(|item| item.as_object_mut()) {
        cloud.insert("apiKey".into(), serde_json::Value::String(String::new()));
        cloud.insert("hasKey".into(), serde_json::Value::Bool(has_key));
    }
    Ok(serde_json::to_string(&value)?)
}

/// Scheme, host, and port. Default ports are omitted, so `:443` on https matches
/// a URL that left the port out. An unparseable URL has no origin.
fn http_origin(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return None;
    }
    let text = url.origin().ascii_serialization();
    if text == "null" {
        None
    } else {
        Some(text)
    }
}

fn same_http_origin(left: &str, right: &str) -> bool {
    match (http_origin(left), http_origin(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn cloud_field(value: Option<&serde_json::Value>, field: &str) -> String {
    value
        .and_then(|item| item.get("cloud"))
        .and_then(|item| item.get(field))
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Empty `apiKey` plus `hasKey: true` keeps the stored secret only when the
/// base URL origin (scheme, host, and port) is unchanged. A path-only edit
/// keeps the key. A different origin drops it unless this save supplies a new
/// key, so the renderer cannot retarget the stored secret at another host.
/// `hasKey: false` clears it. The sealed record never stores `hasKey`.
pub(crate) fn merge_ai_config(existing: Option<&str>, incoming: &str) -> AppResult<String> {
    let mut value: serde_json::Value = serde_json::from_str(incoming)?;
    let incoming_key = clean_api_key(&cloud_field(Some(&value), "apiKey"))?;
    let keep_existing = value
        .get("cloud")
        .and_then(|item| item.get("hasKey"))
        .and_then(|item| item.as_bool())
        .unwrap_or(false);
    let existing_json =
        existing.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let stored_key = clean_api_key(&cloud_field(existing_json.as_ref(), "apiKey"))?;
    let same_origin = same_http_origin(
        &cloud_field(existing_json.as_ref(), "baseUrl"),
        &cloud_field(Some(&value), "baseUrl"),
    );
    let final_key = if !incoming_key.is_empty() {
        incoming_key
    } else if keep_existing && same_origin {
        stored_key
    } else {
        String::new()
    };
    if let Some(cloud) = value.get_mut("cloud").and_then(|item| item.as_object_mut()) {
        cloud.insert("apiKey".into(), serde_json::Value::String(final_key));
        cloud.remove("hasKey");
    }
    Ok(serde_json::to_string(&value)?)
}

fn load_service_value(dir: &Path, key: &str) -> AppResult<Option<String>> {
    let account = service_account(key)?;
    match load_at(dir, &account)? {
        Some(raw) => Ok(Some(present_service_config(key, &raw)?)),
        None => Ok(None),
    }
}

fn save_service_value(dir: &Path, key: &str, value: &str) -> AppResult<()> {
    let account = service_account(key)?;
    let _: serde_json::Value = serde_json::from_str(value)?;
    let stored = if key == "ai.config" {
        merge_ai_config(load_at(dir, &account)?.as_deref(), value)?
    } else {
        value.to_string()
    };
    save_at(dir, &account, &stored)
}

#[tauri::command]
pub fn load_service_config(app: AppHandle, key: String) -> AppResult<Option<String>> {
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    load_service_value(&directory(&app)?, &key)
}
#[tauri::command]
pub fn save_service_config(app: AppHandle, key: String, value: String) -> AppResult<()> {
    let _lock = LOCK.lock().map_err(|_| AppError::msg("凭据存储不可用"))?;
    save_service_value(&directory(&app)?, &key, &value)
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
        let dir = std::env::temp_dir().join(format!("sonde-vault-test-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_at(&dir, "one").unwrap(), None);
        save_at(&dir, "one", "test-secret-123").unwrap();
        save_at(&dir, "two", "").unwrap();
        assert_eq!(
            load_at(&dir, "one").unwrap().as_deref(),
            Some("test-secret-123")
        );
        assert_eq!(load_at(&dir, "two").unwrap().as_deref(), Some(""));
        assert!(stored_at(&dir, "one").unwrap());
        assert!(stored_at(&dir, "two").unwrap());
        assert!(!stored_at(&dir, "missing").unwrap());
        let flag = stored_at(&dir, "one").unwrap().to_string();
        assert_eq!(flag, "true");
        assert!(!flag.contains("test-secret"));
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

    #[test]
    fn load_service_config_does_not_return_the_api_key() {
        let secret = "sk-test-UNIQUE-9f3a-not-a-url";
        let replacement = "sk-replacement-UNIQUE-77c1";
        let dir = std::env::temp_dir().join(format!("sonde-ai-key-{}", uuid::Uuid::new_v4()));
        let incoming = format!(
            r#"{{"v":2,"provider":"cloud","cloud":{{"baseUrl":"https://api.openai.com/v1","apiKey":"{secret}","model":"gpt-4o-mini"}}}}"#
        );
        save_service_value(&dir, "ai.config", &incoming).unwrap();
        let sealed = std::fs::read_to_string(dir.join("credentials.json")).unwrap();
        assert!(!sealed.contains(secret), "the vault file stays encrypted");
        let loaded = load_service_value(&dir, "ai.config").unwrap().unwrap();
        assert!(
            !loaded.contains(secret),
            "IPC payload leaked the API key: {loaded}"
        );
        let presented: serde_json::Value = serde_json::from_str(&loaded).unwrap();
        assert_eq!(presented["cloud"]["apiKey"], "");
        assert_eq!(presented["cloud"]["hasKey"], true);
        assert_eq!(presented["cloud"]["model"], "gpt-4o-mini");
        assert_eq!(presented["provider"], "cloud");

        let kept = r#"{"v":2,"provider":"cloud","cloud":{"baseUrl":"https://api.openai.com/v1","apiKey":"","hasKey":true,"model":"gpt-4o"}}"#;
        save_service_value(&dir, "ai.config", kept).unwrap();
        let after_keep = load_service_value(&dir, "ai.config").unwrap().unwrap();
        assert!(!after_keep.contains(secret));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&after_keep).unwrap()["cloud"]["model"],
            "gpt-4o"
        );
        let endpoint = cloud_endpoint_from_config(
            &load_at(&dir, &service_account("ai.config").unwrap())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            endpoint.api_key, secret,
            "an empty save must keep the stored key"
        );

        let replaced = format!(
            r#"{{"v":2,"provider":"cloud","cloud":{{"baseUrl":"https://api.openai.com/v1","apiKey":"{replacement}","hasKey":true,"model":"gpt-4o"}}}}"#
        );
        save_service_value(&dir, "ai.config", &replaced).unwrap();
        let after_replace = load_service_value(&dir, "ai.config").unwrap().unwrap();
        assert!(!after_replace.contains(secret));
        assert!(!after_replace.contains(replacement));
        assert_eq!(
            cloud_endpoint_from_config(
                &load_at(&dir, &service_account("ai.config").unwrap())
                    .unwrap()
                    .unwrap(),
            )
            .unwrap()
            .api_key,
            replacement
        );

        let cleared = r#"{"v":2,"provider":"cloud","cloud":{"baseUrl":"https://api.openai.com/v1","apiKey":"","hasKey":false,"model":"gpt-4o"}}"#;
        save_service_value(&dir, "ai.config", cleared).unwrap();
        let after_clear = load_service_value(&dir, "ai.config").unwrap().unwrap();
        assert!(!after_clear.contains(replacement));
        let cleared_value: serde_json::Value = serde_json::from_str(&after_clear).unwrap();
        assert_eq!(cleared_value["cloud"]["hasKey"], false);
        assert_eq!(
            cloud_endpoint_from_config(
                &load_at(&dir, &service_account("ai.config").unwrap())
                    .unwrap()
                    .unwrap(),
            )
            .unwrap()
            .api_key,
            ""
        );

        let numeric = r#"{"cloud":{"baseUrl":"https://api.openai.com/v1","apiKey":123456789}}"#;
        let redacted = present_service_config("ai.config", numeric).unwrap();
        assert!(!redacted.contains("123456789"));
        assert!(present_service_config("ai.config", "{").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_the_base_url_origin_drops_the_stored_key() {
        let secret = "sk-test-UNIQUE-origin";
        let replacement = "sk-new-UNIQUE-origin";
        let dir = std::env::temp_dir().join(format!("sonde-ai-origin-{}", uuid::Uuid::new_v4()));
        let initial = format!(
            r#"{{"v":2,"provider":"cloud","cloud":{{"baseUrl":"https://api.openai.com/v1","apiKey":"{secret}","model":"gpt-4o-mini"}}}}"#
        );
        save_service_value(&dir, "ai.config", &initial).unwrap();

        let path_only = r#"{"v":2,"provider":"cloud","cloud":{"baseUrl":"https://api.openai.com/v1/openai","apiKey":"","hasKey":true,"model":"gpt-4o-mini"}}"#;
        save_service_value(&dir, "ai.config", path_only).unwrap();
        let kept = cloud_endpoint_from_config(
            &load_at(&dir, &service_account("ai.config").unwrap())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(kept.api_key, secret, "a path-only edit keeps the key");
        assert_eq!(kept.base_url, "https://api.openai.com/v1/openai");
        let explicit_port = r#"{"v":2,"provider":"cloud","cloud":{"baseUrl":"https://api.openai.com:443/v1","apiKey":"","hasKey":true,"model":"gpt-4o-mini"}}"#;
        save_service_value(&dir, "ai.config", explicit_port).unwrap();
        assert_eq!(
            cloud_endpoint_from_config(
                &load_at(&dir, &service_account("ai.config").unwrap())
                    .unwrap()
                    .unwrap(),
            )
            .unwrap()
            .api_key,
            secret,
            "the default https port is the same origin"
        );

        let retargeted = r#"{"v":2,"provider":"cloud","cloud":{"baseUrl":"https://evil.example/v1","apiKey":"","hasKey":true,"model":"gpt-4o-mini"}}"#;
        save_service_value(&dir, "ai.config", retargeted).unwrap();
        let stored = load_at(&dir, &service_account("ai.config").unwrap())
            .unwrap()
            .unwrap();
        assert!(
            !stored.contains(secret),
            "the vault must forget the key when the origin changes"
        );
        let cleared = cloud_endpoint_from_config(&stored).unwrap();
        assert_eq!(cleared.base_url, "https://evil.example/v1");
        assert_eq!(cleared.api_key, "");
        let presented: serde_json::Value =
            serde_json::from_str(&load_service_value(&dir, "ai.config").unwrap().unwrap()).unwrap();
        assert_eq!(presented["cloud"]["hasKey"], false);
        assert_eq!(presented["cloud"]["apiKey"], "");

        let replaced = format!(
            r#"{{"v":2,"provider":"cloud","cloud":{{"baseUrl":"https://api.example/v1","apiKey":"{replacement}","hasKey":true,"model":"gpt-4o-mini"}}}}"#
        );
        save_service_value(&dir, "ai.config", &replaced).unwrap();
        let moved = cloud_endpoint_from_config(
            &load_at(&dir, &service_account("ai.config").unwrap())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(moved.api_key, replacement);
        assert_eq!(moved.base_url, "https://api.example/v1");
        assert!(!load_service_value(&dir, "ai.config")
            .unwrap()
            .unwrap()
            .contains(replacement));
        fs::remove_dir_all(dir).unwrap();
    }
}
