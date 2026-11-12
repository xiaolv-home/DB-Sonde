//! Cloud model HTTP. The API key is read from the vault and attached here.
//! Responses are scrubbed so a reflected key cannot cross IPC back to the webview.

use crate::{
    credentials::{self, CloudEndpoint},
    error::{AppError, AppResult},
};
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

const CANCELLED: &str = "已取消";

pub struct CloudProxy {
    client: reqwest::Client,
    inner: Mutex<Inflight>,
}

struct Inflight {
    aborted: HashSet<String>,
    handles: HashMap<String, tokio::task::AbortHandle>,
}

impl Default for CloudProxy {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("cloud proxy HTTP client");
        Self {
            client,
            inner: Mutex::new(Inflight {
                aborted: HashSet::new(),
                handles: HashMap::new(),
            }),
        }
    }
}

impl CloudProxy {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inflight> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin(&self, id: &str) -> bool {
        let mut inner = self.lock();
        if inner.aborted.contains(id) {
            inner.aborted.remove(id);
            false
        } else {
            true
        }
    }

    fn track(&self, id: &str, handle: tokio::task::AbortHandle) -> bool {
        let mut inner = self.lock();
        if inner.aborted.contains(id) {
            handle.abort();
            false
        } else {
            inner.handles.insert(id.to_string(), handle);
            true
        }
    }

    fn cancel(&self, id: &str) {
        let mut inner = self.lock();
        inner.aborted.insert(id.to_string());
        if let Some(handle) = inner.handles.remove(id) {
            handle.abort();
        }
    }

    fn finish(&self, id: &str) {
        let mut inner = self.lock();
        inner.handles.remove(id);
        inner.aborted.remove(id);
    }
}

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
    let path = path.trim().trim_start_matches('/');
    if path != "models" && path != "chat/completions" {
        return Err(AppError::msg("不支持的模型接口路径"));
    }
    Ok(format!("{stored}/{path}"))
}

fn normalize_base(raw: &str) -> AppResult<String> {
    let mut parsed =
        reqwest::Url::parse(raw.trim()).map_err(|_| AppError::msg("云端接口地址无效"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
        return Err(AppError::msg("云端接口地址无效"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppError::msg("云端接口地址不能包含账号密码"));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::msg("云端接口地址无效"));
    }
    let path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&path);
    let mut text = parsed.to_string();
    if text.ends_with('/') {
        text.pop();
    }
    Ok(text)
}

fn scrub(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_string()
    } else {
        text.replace(secret, "****")
    }
}

fn public_error(err: &impl std::fmt::Display, secret: &str) -> AppError {
    AppError::msg(scrub(&err.to_string(), secret))
}

struct Scrubber {
    secret: String,
    held: String,
}

impl Scrubber {
    fn new(secret: &str) -> Self {
        Self {
            secret: secret.to_string(),
            held: String::new(),
        }
    }

    fn push(&mut self, text: &str) -> String {
        if self.secret.is_empty() {
            return text.to_string();
        }
        self.held.push_str(text);
        self.held = self.held.replace(&self.secret, "****");
        let keep = prefix_suffix_len(&self.held, &self.secret);
        if keep >= self.held.len() {
            return String::new();
        }
        let split = self.held.len() - keep;
        self.held.drain(..split).collect()
    }

    fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.held);
        scrub(&rest, &self.secret)
    }
}

fn prefix_suffix_len(text: &str, secret: &str) -> usize {
    let max = secret.len().saturating_sub(1).min(text.len());
    for len in (1..=max).rev() {
        if text.is_char_boundary(text.len() - len)
            && secret.is_char_boundary(len)
            && text.ends_with(&secret[..len])
        {
            return len;
        }
    }
    0
}

fn take_utf8(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let valid = match std::str::from_utf8(pending) {
        Ok(text) => text.len(),
        Err(err) => err.valid_up_to(),
    };
    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
    pending.drain(..valid);
    if pending.len() > 3 {
        let broken = String::from_utf8_lossy(pending).into_owned();
        pending.clear();
        return text + &broken;
    }
    text
}

async fn read_endpoint(app: AppHandle) -> AppResult<CloudEndpoint> {
    tokio::task::spawn_blocking(move || credentials::cloud_endpoint(&app))
        .await
        .map_err(|_| AppError::msg("读取云端配置失败"))?
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

#[tauri::command]
pub async fn cloud_model_request(
    app: AppHandle,
    proxy: State<'_, CloudProxy>,
    request_id: String,
    base_url: String,
    path: String,
    method: String,
    body: Option<String>,
    timeout_ms: u64,
) -> AppResult<ProxyHttpResponse> {
    check_request_id(&request_id)?;
    let target = read_endpoint(app).await?;
    let url = authorized_cloud_url(&target.base_url, &base_url, &path)?;
    let client = proxy.client.clone();
    let secret = target.api_key;
    run_cancellable(&proxy, &request_id, async move {
        execute(&client, &method, &url, &secret, body, timeout_ms).await
    })
    .await
}

#[tauri::command]
pub async fn cloud_chat_stream(
    app: AppHandle,
    proxy: State<'_, CloudProxy>,
    request_id: String,
    base_url: String,
    body: String,
    channel: tauri::ipc::Channel<ChatStreamEvent>,
) -> AppResult<()> {
    check_request_id(&request_id)?;
    let target = read_endpoint(app).await?;
    let url = authorized_cloud_url(&target.base_url, &base_url, "chat/completions")?;
    let client = proxy.client.clone();
    let secret = target.api_key;
    run_cancellable(&proxy, &request_id, async move {
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
mod tests {
    use super::*;

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[test]
    fn url_must_match_the_saved_base_and_a_known_path() {
        let base = "https://api.openai.com/v1/";
        assert_eq!(
            authorized_cloud_url(base, "https://api.openai.com/v1", "chat/completions").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            authorized_cloud_url(base, base, "models").unwrap(),
            "https://api.openai.com/v1/models"
        );
        let mismatch = authorized_cloud_url(base, "https://evil.example/v1", "models").unwrap_err();
        assert_eq!(mismatch.to_string(), "云端地址与已保存的配置不一致");
        assert!(authorized_cloud_url(base, base, "../secret").is_err());
        assert!(authorized_cloud_url(base, base, "https://evil.example/models").is_err());
        assert!(
            authorized_cloud_url("https://user:secret@api.openai.com/v1", base, "models").is_err()
        );
        assert!(authorized_cloud_url("https://api.openai.com/v1?x=1", base, "models").is_err());
    }

    #[test]
    fn scrubber_hides_a_key_split_across_chunks() {
        let mut scrubber = Scrubber::new("sk-test-UNIQUE");
        let first = scrubber.push("hello sk-test-");
        let second = scrubber.push("UNIQUE world");
        let tail = scrubber.finish();
        let joined = format!("{first}{second}{tail}");
        assert!(!joined.contains("sk-test-UNIQUE"), "{joined}");
        assert_eq!(joined, "hello **** world");
    }

    #[test]
    fn utf8_sequences_survive_a_split_chunk() {
        let bytes = "你好".as_bytes();
        let mut pending = Vec::new();
        let first = take_utf8(&mut pending, &bytes[..bytes.len() - 2]);
        let second = take_utf8(&mut pending, &bytes[bytes.len() - 2..]);
        assert_eq!(format!("{first}{second}"), "你好");
    }

    #[tokio::test]
    async fn proxy_sends_the_key_only_to_the_saved_host_and_scrubs_the_response() {
        let secret = "sk-test-UNIQUE-proxy-key";
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let record = seen.clone();
        std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let auth = request.headers().iter().find_map(|header| {
                header
                    .field
                    .equiv("Authorization")
                    .then(|| header.value.as_str().to_string())
            });
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            *record.lock().unwrap() = Some((auth, request.url().to_string(), body));
            let payload = format!(r#"{{"echo":"{secret}","ok":true}}"#);
            let header = tiny_http::Header::from_bytes(&b"Retry-After"[..], &b"2"[..]).unwrap();
            let response = tiny_http::Response::from_string(payload)
                .with_status_code(200u16)
                .with_header(header);
            request.respond(response).unwrap();
        });

        let base = format!("http://127.0.0.1:{port}/v1");
        let url = authorized_cloud_url(&base, &base, "chat/completions").unwrap();
        let response = execute(
            &client(),
            "POST",
            &url,
            secret,
            Some(r#"{"model":"m"}"#.into()),
            5_000,
        )
        .await
        .unwrap();
        let (auth, path, body) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(auth.as_deref(), Some(format!("Bearer {secret}").as_str()));
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(body, r#"{"model":"m"}"#);
        assert_eq!(response.status, 200);
        assert_eq!(response.retry_after.as_deref(), Some("2"));
        assert!(
            !response.body.contains(secret),
            "response crossed back with the key: {}",
            response.body
        );
        assert!(response.body.contains("****"));
    }

    #[tokio::test]
    async fn stream_forwards_sse_without_the_reflected_key() {
        let secret = "sk-test-UNIQUE-stream";
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let secret_for_server = secret.to_string();
        std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let mut ignored = String::new();
            request.as_reader().read_to_string(&mut ignored).unwrap();
            let payload = format!("data: hi {secret_for_server}\n");
            request
                .respond(tiny_http::Response::from_string(payload).with_status_code(200u16))
                .unwrap();
        });
        let base = format!("http://127.0.0.1:{port}/v1");
        let url = authorized_cloud_url(&base, &base, "chat/completions").unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        stream_chat(&client(), &url, secret, "{}".into(), 5_000, |event| {
            events.lock().unwrap().push(event);
            Ok(())
        })
        .await
        .unwrap();
        let events = events.into_inner().unwrap();
        let text: String = events.iter().map(|event| event.data.as_str()).collect();
        assert!(events.iter().any(|event| event.kind == "done"));
        assert!(!text.contains(secret), "{text}");
        assert!(text.contains("data: hi ****"));
    }

    #[tokio::test]
    async fn http_error_status_is_preserved_for_the_stream() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            let mut request = server.recv().unwrap();
            let mut ignored = String::new();
            request.as_reader().read_to_string(&mut ignored).unwrap();
            request
                .respond(tiny_http::Response::from_string("nope").with_status_code(401u16))
                .unwrap();
        });
        let base = format!("http://127.0.0.1:{port}/v1");
        let url = authorized_cloud_url(&base, &base, "chat/completions").unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        let err = stream_chat(&client(), &url, "", "{}".into(), 5_000, |event| {
            events.lock().unwrap().push(event);
            Ok(())
        })
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "HTTP 401");
        assert!(events.into_inner().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancel_aborts_running_work_without_leaking_a_key() {
        let proxy = std::sync::Arc::new(CloudProxy::default());
        let id = "req-live".to_string();
        let (started_tx, started_rx) = oneshot::channel();
        let worker = {
            let proxy = proxy.clone();
            let id = id.clone();
            tokio::spawn(async move {
                run_cancellable(&proxy, &id, async move {
                    let _ = started_tx.send(());
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok::<_, AppError>("sk-should-stay-in-rust".to_string())
                })
                .await
            })
        };
        started_rx.await.unwrap();
        proxy.cancel(&id);
        let err = worker.await.unwrap().unwrap_err();
        assert_eq!(err.to_string(), CANCELLED);
        assert!(!err.to_string().contains("sk-"));
    }

    #[tokio::test]
    async fn an_already_cancelled_id_never_runs_the_request() {
        let proxy = CloudProxy::default();
        proxy.cancel("req-early");
        let err = run_cancellable(&proxy, "req-early", async {
            Ok::<_, AppError>("sk-should-not-run".to_string())
        })
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), CANCELLED);
        assert!(!err.to_string().contains("sk-"));
    }
}
