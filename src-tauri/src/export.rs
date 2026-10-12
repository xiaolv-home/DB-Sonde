use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const MAX_EXPORT_BYTES: usize = 100 * 1024 * 1024;

fn safe_base_name(input: &str) -> String {
    let value: String = input
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .take(80)
        .collect();
    let value = value.trim().trim_matches('.');
    if value.is_empty() {
        "query-result".to_string()
    } else {
        value.to_string()
    }
}

fn available_path(directory: &Path, base_name: &str, extension: &str) -> PathBuf {
    let first = directory.join(format!("{base_name}.{extension}"));
    if !first.exists() {
        return first;
    }
    for suffix in 2..10_000 {
        let candidate = directory.join(format!("{base_name}-{suffix}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!(
        "{base_name}-{}.{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S"),
        extension
    ))
}

fn export_bytes(format: &str, content: String) -> AppResult<Vec<u8>> {
    if format != "png" {
        return Ok(content.into_bytes());
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content.trim())
        .map_err(|_| AppError::msg("图片数据损坏,导出失败"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::msg("图片数据不是 PNG,导出失败"));
    }
    Ok(bytes)
}

// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn save_export(
    app: AppHandle,
    suggested_name: String,
    format: String,
    content: String,
) -> AppResult<String> {
    let extension = match format.as_str() {
        "csv" => "csv",
        "json" => "json",
        "svg" => "svg",
        // 图片走 base64 文本传过来,这里解回二进制再写
        "png" => "png",
        _ => return Err(AppError::msg("Only CSV, JSON, SVG and PNG exports are supported.")),
    };
    if content.len() > MAX_EXPORT_BYTES {
        return Err(AppError::msg("The export exceeds the 100 MB safety limit."));
    }
    let bytes = export_bytes(&format, content)?;

    let directory = app
        .path()
        .download_dir()
        .map_err(|error| AppError::msg(format!("cannot resolve Downloads folder: {error}")))?;
    std::fs::create_dir_all(&directory)?;
    let path = available_path(&directory, &safe_base_name(&suggested_name), extension);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_names_are_sanitized_and_never_overwritten() {
        assert_eq!(safe_base_name("../../sales:daily"), "_.._sales_daily");
        let directory =
            std::env::temp_dir().join(format!("sonde-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let first = directory.join("sales.csv");
        std::fs::write(&first, "existing").unwrap();
        assert_eq!(
            available_path(&directory, "sales", "csv"),
            directory.join("sales-2.csv")
        );
        std::fs::remove_file(first).ok();
        std::fs::remove_dir(directory).ok();
    }

    #[test]
    fn png_exports_are_decoded_and_checked() {
        assert_eq!(export_bytes("svg", "<svg/>".into()).unwrap(), b"<svg/>");
        // 1x1 透明 PNG
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        assert!(export_bytes("png", png.into()).unwrap().starts_with(b"\x89PNG"));
        assert!(export_bytes("png", "not base64!".into()).is_err());
        assert!(export_bytes("png", "aGVsbG8=".into()).is_err(), "解出来不是 PNG 也要拒");
    }
}
