
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
    assert!(authorized_cloud_url("https://user:secret@api.openai.com/v1", base, "models").is_err());
    assert!(authorized_cloud_url("https://api.openai.com/v1?x=1", base, "models").is_err());
    assert_eq!(
        authorized_cloud_url("http://example.com/v1", "http://example.com/v1", "models")
            .unwrap_err()
            .to_string(),
        "非本机地址必须使用 https"
    );
    assert!(
        authorized_cloud_url("http://127.0.0.1:9/v1", "http://127.0.0.1:9/v1", "models").is_ok()
    );
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

#[test]
fn origin_change_without_a_new_key_leaves_the_proxy_nothing_to_send() {
    let secret = "sk-test-UNIQUE-origin";
    let replacement = "sk-new-UNIQUE-origin";
    let stored = format!(
        r#"{{"cloud":{{"baseUrl":"https://api.openai.com/v1","apiKey":"{secret}"}},"local":{{"baseUrl":"http://127.0.0.1:1234/v1"}}}}"#
    );
    let retargeted = credentials::merge_ai_config(
            Some(&stored),
            r#"{"cloud":{"baseUrl":"https://evil.example/v1","apiKey":"","hasKey":true},"local":{"baseUrl":"http://127.0.0.1:1234/v1"}}"#,
        )
        .unwrap();
    assert!(!retargeted.contains(secret));
    let refused = resolve_proxy_target(
        &retargeted,
        "cloud",
        "https://evil.example/v1",
        "chat/completions",
    )
    .unwrap_err();
    assert_eq!(refused.to_string(), "云端模型尚未配置 API Key");
    assert!(!refused.to_string().contains(secret));

    let path_only = credentials::merge_ai_config(
        Some(&stored),
        r#"{"cloud":{"baseUrl":"https://api.openai.com/v1/openai","apiKey":"","hasKey":true}}"#,
    )
    .unwrap();
    let (url, key) = resolve_proxy_target(
        &path_only,
        "cloud",
        "https://api.openai.com/v1/openai",
        "chat/completions",
    )
    .unwrap();
    assert_eq!(key, secret);
    assert_eq!(url, "https://api.openai.com/v1/openai/chat/completions");

    let moved = credentials::merge_ai_config(
            Some(&stored),
            &format!(
                r#"{{"cloud":{{"baseUrl":"https://api.example/v1","apiKey":"{replacement}","hasKey":true}}}}"#
            ),
        )
        .unwrap();
    let (url, key) =
        resolve_proxy_target(&moved, "cloud", "https://api.example/v1", "models").unwrap();
    assert_eq!(key, replacement);
    assert_eq!(url, "https://api.example/v1/models");
    assert_ne!(key, secret);
}

#[test]
fn local_and_builtin_calls_omit_the_cloud_key() {
    let secret = "sk-test-UNIQUE-local";
    let config = format!(
        r#"{{"cloud":{{"baseUrl":"https://api.openai.com/v1","apiKey":"{secret}"}},"local":{{"baseUrl":"http://127.0.0.1:1234/v1"}}}}"#
    );
    let (url, key) =
        resolve_proxy_target(&config, "local", "http://127.0.0.1:1234/v1", "models").unwrap();
    assert!(key.is_empty());
    assert_eq!(url, "http://127.0.0.1:1234/v1/models");
    assert!(resolve_proxy_target(&config, "local", "http://127.0.0.1:8123/v1", "models").is_err());
    let public_local = r#"{"local":{"baseUrl":"https://10.1.2.3/v1"}}"#;
    assert!(resolve_proxy_target(public_local, "local", "https://10.1.2.3/v1", "models").is_ok());

    let (builtin, key) = resolve_proxy_target(
        &config,
        "builtin",
        "http://127.0.0.1:8899/v1",
        "chat/completions",
    )
    .unwrap();
    assert!(key.is_empty());
    assert_eq!(builtin, "http://127.0.0.1:8899/v1/chat/completions");
    assert!(resolve_proxy_target(&config, "builtin", "http://localhost:8899/v1", "models").is_ok());
    assert!(
        resolve_proxy_target(&config, "builtin", "http://127.0.0.1:8123/v1", "models").is_err()
    );
    assert!(
        resolve_proxy_target(&config, "builtin", "https://127.0.0.1:8899/v1", "models").is_err()
    );
}
