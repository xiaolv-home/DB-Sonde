use crate::{
    credentials,
    error::{AppError, AppResult},
};

/// The request may only use the saved cloud base URL, so the renderer cannot
/// point the stored key at some other host.
pub fn authorized_cloud_url(
    stored_base: &str,
    requested_base: &str,
    path: &str,
) -> AppResult<String> {
    let stored = normalize_base(stored_base)?;
    let requested = normalize_base(requested_base)?;
    if stored != requested {
        return Err(AppError::msg("云端地址与已保存的配置不一致"));
    }
    let path = model_path(path)?;
    Ok(format!("{stored}/{path}"))
}

fn is_loopback_host(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(host) => match host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
            Ok(ip) => ip.is_loopback(),
            Err(_) => host.eq_ignore_ascii_case("localhost"),
        },
        None => false,
    }
}

fn normalize_base(raw: &str) -> AppResult<String> {
    normalize_endpoint(raw, false)
}

fn normalize_endpoint(raw: &str, local: bool) -> AppResult<String> {
    let mut parsed =
        reqwest::Url::parse(raw.trim()).map_err(|_| AppError::msg("模型接口地址无效"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
        return Err(AppError::msg("模型接口地址无效"));
    }
    // Public cloud endpoints are https only. Plain http stays available for a
    // loopback server (a local model, or the tests' tiny HTTP fixture).
    if parsed.scheme() == "http" && !local && !is_loopback_host(&parsed) {
        return Err(AppError::msg("非本机地址必须使用 https"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::msg("模型接口地址不能包含账号密码"));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::msg("模型接口地址无效"));
    }
    let path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&path);
    let mut text = parsed.to_string();
    if text.ends_with('/') {
        text.pop();
    }
    Ok(text)
}

fn model_path(path: &str) -> AppResult<&str> {
    let path = path.trim().trim_start_matches('/');
    if path == "models" || path == "chat/completions" {
        Ok(path)
    } else {
        Err(AppError::msg("不支持的模型接口路径"))
    }
}

fn config_string(raw: &str, section: &str, field: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .get(section)
                .and_then(|item| item.get(field))
                .and_then(|item| item.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// User-configured local endpoints may live on the LAN. Only the exact saved
/// base URL is accepted, and the cloud key is never attached.
fn authorized_local_url(stored_base: &str, requested_base: &str, path: &str) -> AppResult<String> {
    let stored = normalize_endpoint(stored_base, true)?;
    let requested = normalize_endpoint(requested_base, true)?;
    if stored != requested {
        return Err(AppError::msg("模型地址与已保存的配置不一致"));
    }
    let path = model_path(path)?;
    Ok(format!("{stored}/{path}"))
}

fn authorized_builtin_url(requested_base: &str, path: &str) -> AppResult<String> {
    let base = normalize_base(requested_base)?;
    let parsed = reqwest::Url::parse(&base).map_err(|_| AppError::msg("内置模型地址无效"))?;
    let port = parsed.port_or_known_default().unwrap_or(0);
    if parsed.scheme() != "http"
        || !is_loopback_host(&parsed)
        || port != crate::ai::BUILTIN_PORT
        || parsed.path() != "/v1"
    {
        return Err(AppError::msg("内置模型地址无效"));
    }
    let path = model_path(path)?;
    Ok(format!("{base}/{path}"))
}

/// Where a proxied model call may go, and the secret to attach. Local and
/// built-in calls get an empty secret.
pub(super) fn resolve_proxy_target(
    config: &str,
    provider: &str,
    requested_base: &str,
    path: &str,
) -> AppResult<(String, String)> {
    match provider {
        "cloud" => {
            let target = credentials::cloud_endpoint_from_config(config)?;
            if target.api_key.is_empty() {
                return Err(AppError::msg("云端模型尚未配置 API Key"));
            }
            let url = authorized_cloud_url(&target.base_url, requested_base, path)?;
            Ok((url, target.api_key))
        }
        "local" => {
            let saved = config_string(config, "local", "baseUrl");
            if saved.trim().is_empty() {
                return Err(AppError::msg("本地模型尚未配置接口地址"));
            }
            let url = authorized_local_url(&saved, requested_base, path)?;
            Ok((url, String::new()))
        }
        "builtin" => Ok((authorized_builtin_url(requested_base, path)?, String::new())),
        _ => Err(AppError::msg("不支持的模型来源")),
    }
}

#[cfg(test)]
mod endpoint_tests {
    use super::*;
    #[test]
    fn local_lan_and_ipv6_are_supported_without_retargeting_secrets() {
        for base in [
            "http://192.168.1.5:1234/v1",
            "http://models.lan:11434/v1",
            "http://[::1]:1234/v1",
        ] {
            assert_eq!(
                authorized_local_url(base, base, "models").unwrap(),
                format!("{base}/models")
            );
        }
        assert!(normalize_base("http://[::1]:1234/v1").is_ok());
        assert!(authorized_cloud_url(
            "https://api.example/v1",
            "https://evil.example/v1",
            "models"
        )
        .is_err());
        assert!(
            authorized_local_url("http://models.lan/v1", "http://other.lan/v1", "models").is_err()
        );
    }
}
