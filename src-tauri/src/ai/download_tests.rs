
use super::*;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "sonde-model-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn client() -> reqwest::blocking::Client {
    model_http_client(Duration::from_secs(5), true).unwrap()
}

fn filename_error(name: &str) -> String {
    let dir = TempDir::new();
    model_destination(&dir.0, name).unwrap_err()
}

#[test]
fn filename_rejects_traversal_absolute_paths_bad_extension_and_reserved_names() {
    assert!(filename_error("../secret.gguf").contains(".."), "traversal");
    assert!(filename_error("..").contains(".."));
    assert!(filename_error("foo/../../etc/passwd.gguf").contains(".."));
    assert!(filename_error(r"..\..\windows\system.gguf").contains(".."));
    assert!(
        filename_error("/tmp/secret.gguf").contains("absolute"),
        "unix absolute"
    );
    assert!(filename_error(r"\Windows\system.gguf").contains("absolute"));
    let windows_abs = filename_error(r"C:\Windows\system.gguf");
    assert!(
        windows_abs.contains("absolute") || windows_abs.contains("separator"),
        "{windows_abs}"
    );
    assert!(filename_error("nested/model.gguf").contains("separator"));
    assert!(
        filename_error("C:model.gguf").contains("drive"),
        "drive prefix"
    );
    assert!(filename_error("").contains("empty"));
    assert!(
        filename_error("model.bin").contains(".gguf"),
        "bad extension"
    );
    assert!(filename_error("model.gguf.txt").contains(".gguf"));
    assert!(filename_error(".gguf").contains(".gguf"));
    assert!(filename_error("CON.gguf").contains("reserved"));
    assert!(filename_error("nul.gguf").contains("reserved"));
    assert!(filename_error("COM1.gguf").contains("reserved"));
    assert!(filename_error("LPT9.gguf").contains("reserved"));
    assert!(filename_error("my model.gguf").contains("invalid"));
    assert!(filename_error("模型.gguf").contains("invalid"));
}

#[test]
fn filename_stays_inside_the_models_directory() {
    let root = TempDir::new();
    let models = root.0.join("models");
    let name = "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf";
    let dest = model_destination(&models, name).unwrap();
    let canonical = fs::canonicalize(&models).unwrap();
    assert_eq!(dest.parent(), Some(canonical.as_path()));
    assert!(dest.starts_with(&canonical));
    assert_eq!(dest.file_name().and_then(|n| n.to_str()), Some(name));
    fs::write(&dest, b"partial").unwrap();
    let again = model_destination(&models, name).unwrap();
    assert_eq!(again, dest);

    let outside = root.0.join("outside.gguf");
    fs::write(&outside, b"secret").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, models.join("evil.gguf")).unwrap();
        let err = model_destination(&models, "evil.gguf").unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert_eq!(fs::read(&outside).unwrap(), b"secret");
    }
}

#[test]
fn url_rejects_http_scheme_and_bad_host_but_allows_modelscope() {
    assert_eq!(
        validate_model_url("http://modelscope.cn/a.gguf").unwrap_err(),
        "model URL must use https"
    );
    assert_eq!(
        validate_model_url("http://cdn-lfs-cn-1.modelscope.cn/obj").unwrap_err(),
        "model URL must use https",
    );
    assert!(validate_model_url("https://evil.example/a.gguf")
        .unwrap_err()
        .contains("not allowed"));
    assert!(
        validate_model_url("https://modelscope.cn.evil.example/a.gguf")
            .unwrap_err()
            .contains("not allowed")
    );
    assert!(validate_model_url("https://notmodelscope.cn/a.gguf")
        .unwrap_err()
        .contains("not allowed"));
    assert!(validate_model_url("https://evilmodelscope.cn/a.gguf")
        .unwrap_err()
        .contains("not allowed"));
    assert_eq!(
        validate_model_url("https://user:pass@modelscope.cn/a.gguf").unwrap_err(),
        "model URL must not include credentials",
    );
    let builtin = builtin_model_url();
    assert_eq!(validate_model_url(&builtin).unwrap().as_str(), builtin);
    assert!(validate_model_url(
        "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/abc?filename=q.gguf&auth_key=1"
    )
    .is_ok());
    assert!(validate_model_url("https://www.modelscope.cn/models/Qwen/x").is_ok());
}

#[test]
fn builtin_pinned_model_passes_the_allowlist() {
    let dir = TempDir::new();
    assert!(
        model_destination(&dir.0, BUILTIN_MODEL_FILENAME).is_ok(),
        "{}",
        BUILTIN_MODEL_FILENAME
    );
    let url = builtin_model_url();
    assert!(validate_model_url(&url).is_ok(), "{url}");
    assert_eq!(BUILTIN_MODEL_SHA256.len(), 64);
}

#[test]
fn download_writes_the_body_and_resumes_a_partial_file() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap();
    std::thread::spawn(move || {
        for _ in 0..2 {
            let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) else {
                break;
            };
            let range = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("Range"))
                .map(|h| h.value.as_str().to_string());
            let (status, payload) = match range.as_deref() {
                None => (200, "hello"),
                Some("bytes=5-") => (206, "WORLD"),
                Some(_) => (400, "bad-range"),
            };
            let _ = req.respond(tiny_http::Response::from_string(payload).with_status_code(status));
        }
    });
    let dir = TempDir::new();
    let dest = dir.0.join("model.gguf");
    let url = format!("http://{addr}/model.gguf");
    let http = client();
    download_model_file(
        &http,
        &url,
        &dest,
        &sha256_bytes(b"hello"),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"hello");
    download_model_file(
        &http,
        &url,
        &dest,
        &sha256_bytes(b"helloWORLD"),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"helloWORLD");
}

fn redirect_error(location: &str) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap();
    let location = location.to_string();
    std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
            let header =
                tiny_http::Header::from_bytes(&b"Location"[..], location.as_bytes()).unwrap();
            let _ = req.respond(tiny_http::Response::empty(302).with_header(header));
        }
    });
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .redirect(model_redirect_policy())
        .build()
        .unwrap();
    let err = client
        .get(format!("http://{addr}/model.gguf"))
        .send()
        .unwrap_err();
    error_detail(&err)
}

#[test]
fn redirect_to_non_allowlisted_host_is_rejected() {
    let err = redirect_error("https://evil.example/steal.gguf");
    assert!(err.contains("not allowed"), "{err}");
    assert!(err.contains("evil.example"), "{err}");
}

#[test]
fn redirect_to_http_on_allowlisted_host_is_rejected() {
    let err = redirect_error("http://cdn-lfs-cn-1.modelscope.cn/prod/object");
    assert!(err.contains("https"), "{err}");
}

#[test]
fn sha256_mismatch_deletes_the_downloaded_file() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = Arc::clone(&hits);
    std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
            hits2.fetch_add(1, Ordering::SeqCst);
            let _ = req.respond(tiny_http::Response::from_string("not-the-model"));
        }
    });
    let dir = TempDir::new();
    let dest = dir.0.join("model.gguf");
    let err = download_model_file(
        &client(),
        &format!("http://{addr}/model.gguf"),
        &dest,
        &sha256_bytes(b"the-model"),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(err.contains("校验和不符"), "{err}");
    assert!(!dest.exists(), "校验失败必须删掉文件");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[test]
fn http_416_with_matching_size_is_complete_and_keeps_a_matching_sha256() {
    let body = b"hello-model";
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = Arc::clone(&hits);
    std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
            hits2.fetch_add(1, Ordering::SeqCst);
            let value = format!("bytes */{}", body.len());
            let header =
                tiny_http::Header::from_bytes(&b"Content-Range"[..], value.as_bytes()).unwrap();
            let _ = req.respond(tiny_http::Response::empty(416).with_header(header));
        }
    });
    let dir = TempDir::new();
    let dest = dir.0.join("model.gguf");
    fs::write(&dest, body).unwrap();
    download_model_file(
        &client(),
        &format!("http://{addr}/model.gguf"),
        &dest,
        &sha256_bytes(body),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(
        fs::read(&dest).unwrap(),
        body,
        "大小一致时应保留已完成的文件"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1, "已完成的文件不应该再拉一次");
}

#[test]
fn http_416_matching_size_still_rejects_a_bad_sha256_and_deletes_the_file() {
    let body = b"hello-model";
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap();
    std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
            let value = format!("bytes */{}", body.len());
            let header =
                tiny_http::Header::from_bytes(&b"Content-Range"[..], value.as_bytes()).unwrap();
            let _ = req.respond(tiny_http::Response::empty(416).with_header(header));
        }
    });
    let dir = TempDir::new();
    let dest = dir.0.join("model.gguf");
    fs::write(&dest, body).unwrap();
    let err = download_model_file(
        &client(),
        &format!("http://{addr}/model.gguf"),
        &dest,
        &sha256_bytes(b"other-bytes"),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(err.contains("校验和不符"), "{err}");
    assert!(!dest.exists(), "416 视为完成之后仍要校验,不符必须删掉");
}

#[test]
fn http_416_with_a_different_size_errors_and_deletes_the_partial() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let addr = server.server_addr().to_ip().unwrap();
    std::thread::spawn(move || {
        if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
            let header =
                tiny_http::Header::from_bytes(&b"Content-Range"[..], &b"bytes */3"[..]).unwrap();
            let _ = req.respond(tiny_http::Response::empty(416).with_header(header));
        }
    });
    let dir = TempDir::new();
    let dest = dir.0.join("model.gguf");
    fs::write(&dest, b"hello").unwrap();
    let err = download_model_file(
        &client(),
        &format!("http://{addr}/model.gguf"),
        &dest,
        &sha256_bytes(b"hello"),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(err.contains("416"), "{err}");
    assert!(err.contains("5") && err.contains("3"), "{err}");
    assert!(!dest.exists(), "大小对不上必须删掉半截文件,下次才能重下");
}

#[test]
fn stalled_body_fails_on_the_idle_read_timeout() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let mut buf = [0_u8; 2048];
        let _ = sock.read(&mut buf);
        let _ =
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n");
        std::thread::sleep(Duration::from_secs(3));
    });
    let dir = TempDir::new();
    let dest = dir.0.join("model.gguf");
    let idle = Duration::from_millis(400);
    let http = model_http_client(idle, true).unwrap();
    let started = Instant::now();
    let err = download_model_file(
        &http,
        &format!("http://{addr}/model.gguf"),
        &dest,
        &sha256_bytes(b"x"),
        idle,
    )
    .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "空闲超时应该很快失败,实际 {:?}",
        started.elapsed()
    );
    assert!(err.contains("下载卡住"), "{err}");
}
