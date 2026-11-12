//! Model HTTP for the desktop app. The cloud API key is read from the vault and
//! attached here, and only to that saved origin. Local and built-in models are
//! proxied too, without the cloud key, so the webview does not open loopback ports.
//! Responses are scrubbed so a reflected key cannot cross IPC back to the webview.

use crate::{
    credentials,
    error::{AppError, AppResult},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

const CANCELLED: &str = "已取消";

mod inflight;
mod redaction;
mod target;
pub use inflight::CloudProxy;
use redaction::*;
use target::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpResponse {
    status: u16,
    body: String,
    retry_after: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ChatStreamEvent {
    pub kind: String,
    pub data: String,
}

fn check_request_id(id: &str) -> AppResult<()> {
    if (1..=80).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(AppError::msg("无效的请求编号"))
    }
}

async fn read_ai_config(app: AppHandle) -> AppResult<String> {
    let loaded = tokio::task::spawn_blocking(move || credentials::ai_config_raw(&app))
        .await
        .map_err(|_| AppError::msg("读取模型配置失败"))??;
    Ok(loaded.unwrap_or_else(|| "{}".to_string()))
}

async fn run_cancellable<T: Send + 'static>(
    proxy: &CloudProxy,
    request_id: &str,
    work: impl std::future::Future<Output = AppResult<T>> + Send + 'static,
) -> AppResult<T> {
    if !proxy.begin(request_id) {
        return Err(AppError::msg(CANCELLED));
    }
    let (tx, rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let result = work.await;
        let _ = tx.send(result);
    });
    if !proxy.track(request_id, task.abort_handle()) {
        proxy.finish(request_id);
        return Err(AppError::msg(CANCELLED));
    }
    let result = match rx.await {
        Ok(inner) => inner,
        Err(_) => Err(AppError::msg(CANCELLED)),
    };
    proxy.finish(request_id);
    result
}

fn request_builder(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    api_key: &str,
    body: Option<String>,
    timeout_ms: u64,
) -> AppResult<reqwest::RequestBuilder> {
    let verb = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return Err(AppError::msg("不支持的模型请求方法")),
    };
    let mut builder = client.request(verb.clone(), url);
    if timeout_ms > 0 {
        builder = builder.timeout(Duration::from_millis(timeout_ms.min(600_000)));
    }
    if !api_key.is_empty() {
        builder = builder.header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"));
    }
    if verb == reqwest::Method::POST {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.unwrap_or_default());
    }
    Ok(builder)
}

async fn execute(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    api_key: &str,
    body: Option<String>,
    timeout_ms: u64,
) -> AppResult<ProxyHttpResponse> {
    let response = request_builder(client, method, url, api_key, body, timeout_ms)?
        .send()
        .await
        .map_err(|err| public_error(&err, api_key))?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(|value| scrub(value, api_key));
    let text = response
        .text()
        .await
        .map_err(|err| public_error(&err, api_key))?;
    Ok(ProxyHttpResponse {
        status,
        body: scrub(&text, api_key),
        retry_after,
    })
}

async fn stream_chat<F>(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: String,
    timeout_ms: u64,
    mut emit: F,
) -> AppResult<()>
where
    F: FnMut(ChatStreamEvent) -> AppResult<()>,
{
    let response = request_builder(client, "POST", url, api_key, Some(body), timeout_ms)?
        .send()
        .await
        .map_err(|err| public_error(&err, api_key))?;
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "HTTP {}",
            response.status().as_u16()
        )));
    }
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut scrubber = Scrubber::new(api_key);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| public_error(&err, api_key))?;
        let text = take_utf8(&mut pending, &chunk);
        let visible = scrubber.push(&text);
        if !visible.is_empty() {
            emit(ChatStreamEvent {
                kind: "chunk".into(),
                data: visible,
            })?;
        }
    }
    if !pending.is_empty() {
        let visible = scrubber.push(&String::from_utf8_lossy(&pending));
        if !visible.is_empty() {
            emit(ChatStreamEvent {
                kind: "chunk".into(),
                data: visible,
            })?;
        }
    }
    let tail = scrubber.finish();
    if !tail.is_empty() {
        emit(ChatStreamEvent {
            kind: "chunk".into(),
            data: tail,
        })?;
    }
    emit(ChatStreamEvent {
        kind: "done".into(),
        data: String::new(),
    })
}

/// Non-streaming model call. Grouped so the command stays under clippy's argument limit.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHttpCall {
    pub request_id: String,
    pub provider: String,
    pub base_url: String,
    pub path: String,
    pub method: String,
    pub body: Option<String>,
    pub timeout_ms: u64,
}

#[tauri::command]
pub async fn cloud_model_request(
    app: AppHandle,
    proxy: State<'_, CloudProxy>,
    call: ModelHttpCall,
) -> AppResult<ProxyHttpResponse> {
    let ModelHttpCall {
        request_id,
        provider,
        base_url,
        path,
        method,
        body,
        timeout_ms,
    } = call;
    check_request_id(&request_id)?;
    let client = proxy.client.clone();
    run_cancellable(&proxy, &request_id, async move {
        let config = read_ai_config(app).await?;
        let (url, secret) = resolve_proxy_target(&config, &provider, &base_url, &path)?;
        execute(&client, &method, &url, &secret, body, timeout_ms).await
    })
    .await
}

#[tauri::command]
pub async fn cloud_chat_stream(
    app: AppHandle,
    proxy: State<'_, CloudProxy>,
    request_id: String,
    provider: String,
    base_url: String,
    body: String,
    channel: tauri::ipc::Channel<ChatStreamEvent>,
) -> AppResult<()> {
    check_request_id(&request_id)?;
    let client = proxy.client.clone();
    run_cancellable(&proxy, &request_id, async move {
        let config = read_ai_config(app).await?;
        let (url, secret) =
            resolve_proxy_target(&config, &provider, &base_url, "chat/completions")?;
        stream_chat(&client, &url, &secret, body, 0, |event| {
            channel
                .send(event)
                .map_err(|_| AppError::msg("流式响应已中断"))
        })
        .await
    })
    .await
}

#[tauri::command]
pub fn cloud_model_cancel(proxy: State<'_, CloudProxy>, request_id: String) -> AppResult<()> {
    check_request_id(&request_id)?;
    proxy.cancel(&request_id);
    Ok(())
}

#[cfg(test)]
mod tests;
