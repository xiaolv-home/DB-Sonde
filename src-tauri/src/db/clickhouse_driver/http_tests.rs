use super::*;
use std::sync::{Arc, Mutex};

fn fixture() -> (tiny_http::Server, ClickHouseHandle) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let handle = ClickHouseHandle {
        client: client().unwrap(),
        url: format!("http://{}/", server.server_addr()),
        user: "test-user".into(),
        password: "test-password".into(),
        database: "test-db".into(),
    };
    (server, handle)
}
#[tokio::test]
async fn redirect_never_receives_credentials() {
    let (source, handle) = fixture();
    let target = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let location = format!("http://{}/", target.server_addr());
    let worker = std::thread::spawn(move || {
        let request = source
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        assert!(request
            .headers()
            .iter()
            .any(|h| h.field.equiv("X-ClickHouse-Key") && h.value.as_str() == "test-password"));
        request
            .respond(
                tiny_http::Response::empty(302)
                    .with_header(tiny_http::Header::from_bytes("Location", location).unwrap()),
            )
            .unwrap();
        assert!(target
            .recv_timeout(Duration::from_millis(200))
            .unwrap()
            .is_none());
    });
    assert!(handle
        .exec("SELECT 1")
        .await
        .unwrap_err()
        .to_string()
        .contains("重定向"));
    worker.join().unwrap();
}
#[tokio::test]
async fn timeout_sends_kill_for_the_exact_query_id_and_current_user() {
    let (server, handle) = fixture();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let out = observed.clone();
    let worker = std::thread::spawn(move || {
        let mut running = server
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        let mut sql = String::new();
        running.as_reader().read_to_string(&mut sql).unwrap();
        out.lock().unwrap().push(running.url().to_owned());
        assert_eq!(sql, "SELECT sleep(90)");
        // Keep the first HTTP exchange open: the cancellation must use an independent request.
        let mut cancel = server
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        let mut kill = String::new();
        cancel.as_reader().read_to_string(&mut kill).unwrap();
        out.lock().unwrap().push(kill);
        cancel
            .respond(tiny_http::Response::from_string(
                r#"{"data":[{"kill_status":"finished"}]}"#,
            ))
            .unwrap();
        let _ = running.respond(tiny_http::Response::empty(200));
    });
    let options = QueryOptions {
        query_id: "sonde:fixture-1".into(),
        timeout: Duration::from_millis(100),
    };
    assert!(handle
        .execute("SELECT sleep(90)", &options)
        .await
        .unwrap_err()
        .to_string()
        .contains("超时"));
    worker.join().unwrap();
    let calls = observed.lock().unwrap().clone();
    assert!(calls[0].contains("query_id=sonde%3Afixture-1"));
    assert!(calls[0].contains("max_execution_time=1"));
    assert_eq!(
        calls[1],
        "KILL QUERY WHERE query_id = 'sonde:fixture-1' AND user = currentUser() SYNC FORMAT JSON"
    );
    assert!(handle.cancel("sonde:a' OR 1=1").await.is_err());
}
#[test]
fn query_deadlines_are_per_call() {
    assert_eq!(
        QueryOptions::new(Some("one"), Some(75)).timeout,
        Duration::from_secs(75)
    );
    assert_eq!(
        QueryOptions::new(None, None).timeout,
        Duration::from_secs(300)
    );
    assert_eq!(
        QueryOptions::new(None, Some(99999)).timeout,
        Duration::from_secs(3600)
    );
}

#[test]
fn a_waiting_or_failed_cancellation_is_not_reported_as_success() {
    assert!(cancellation_count(&serde_json::json!({"data":[{"kill_status":"waiting"}]})).is_err());
    assert!(
        cancellation_count(&serde_json::json!({"data":[{"kill_status":"cant_cancel"}]})).is_err()
    );
    assert_eq!(
        cancellation_count(&serde_json::json!({"data":[]})).unwrap(),
        0
    );
    assert_eq!(
        cancellation_count(&serde_json::json!({"data":[{"kill_status":"finished"}]})).unwrap(),
        1
    );
}

#[test]
fn tls_default_ports_preserve_existing_http_profiles_and_accept_ipv6() {
    let mut config: ConnectionConfig = serde_json::from_value(serde_json::json!({"id":"fixture","name":"fixture","kind":"clickhouse","host":"::1","sslMode":"require"})).unwrap();
    assert_eq!(endpoint(&config).unwrap(), "https://[::1]:8443/");
    config.ssl_mode = None;
    assert_eq!(endpoint(&config).unwrap(), "http://[::1]:8123/");
    config.host = "user:password@example.com".into();
    assert!(endpoint(&config).is_err());
}
