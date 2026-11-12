//! Authenticated HTTP is confined to the configured endpoint; redirects are never followed.
//! Each query owns its timeout and server query_id, including timeout cleanup.
use super::{
    json_to_string, lit, with_json_format, AppError, AppResult, ClickHouseHandle, ConnectionConfig,
    Json,
};
use std::time::Duration;

pub struct QueryOptions {
    pub query_id: String,
    pub timeout: Duration,
}
impl QueryOptions {
    pub fn new(run_id: Option<&str>, timeout_secs: Option<u64>) -> Self {
        Self {
            query_id: run_id
                .and_then(crate::db::run_marker)
                .unwrap_or_else(|| format!("sonde:{}", uuid::Uuid::new_v4())),
            timeout: Duration::from_secs(timeout_secs.unwrap_or(300).clamp(1, 3600)),
        }
    }
}
pub(super) fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::msg(format!("构建 HTTP 客户端失败: {e}")))
}
pub(super) fn endpoint(cfg: &ConnectionConfig) -> AppResult<String> {
    let tls = cfg.ssl_mode.as_deref() == Some("require");
    let scheme = if tls { "https" } else { "http" };
    let port = if cfg.port == 0 {
        if tls {
            8443
        } else {
            8123
        }
    } else {
        cfg.port
    };
    let host = cfg.host.trim().trim_matches(['[', ']']);
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let parsed = reqwest::Url::parse(&format!("{scheme}://{host}:{port}/"))
        .map_err(|_| AppError::msg("ClickHouse 主机地址无效"))?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(AppError::msg("ClickHouse 主机地址无效"));
    }
    Ok(parsed.to_string())
}
impl ClickHouseHandle {
    async fn request(
        &self,
        sql: &str,
        timeout: Duration,
        query: &[(&str, String)],
    ) -> AppResult<String> {
        let response = self
            .client
            .post(&self.url)
            .query(&[("database", &self.database)])
            .query(query)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .body(sql.to_owned())
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| AppError::msg(format!("ClickHouse 请求失败: {e}")))?;
        let status = response.status();
        if status.is_redirection() {
            return Err(AppError::msg(
                "ClickHouse 地址发生重定向，已停止请求以保护密码。请填写数据库的最终地址。",
            ));
        }
        let text = response
            .text()
            .await
            .map_err(|e| AppError::msg(e.to_string()))?;
        if !status.is_success() {
            return Err(AppError::msg(format!(
                "ClickHouse {}: {}",
                status.as_u16(),
                text.trim()
            )));
        }
        Ok(text)
    }
    pub(super) async fn exec(&self, sql: &str) -> AppResult<String> {
        self.request(sql, Duration::from_secs(30), &[]).await
    }
    pub(super) async fn query_json(&self, sql: &str) -> AppResult<Json> {
        let text = self.exec(&with_json_format(sql)).await?;
        serde_json::from_str(&text)
            .map_err(|e| AppError::msg(format!("解析 ClickHouse 响应失败: {e}")))
    }
    pub(super) async fn scalar(&self, sql: &str) -> Option<String> {
        let value = self.query_json(sql).await.ok()?;
        value
            .get("data")?
            .as_array()?
            .first()?
            .as_object()?
            .values()
            .next()
            .map(json_to_string)
    }
    pub(super) async fn execute(&self, sql: &str, options: &QueryOptions) -> AppResult<String> {
        // Server-side limit survives a dropped HTTP connection. A second request cancels
        // explicitly when the caller's deadline expires (ClickHouse keeps disconnected work alive).
        let params = [
            ("query_id", options.query_id.clone()),
            (
                "max_execution_time",
                options.timeout.as_secs().max(1).to_string(),
            ),
        ];
        match tokio::time::timeout(
            options.timeout,
            self.request(sql, options.timeout + Duration::from_secs(1), &params),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                let cleanup = self.cancel(&options.query_id).await;
                Err(AppError::msg(if cleanup.is_ok() {
                    "ClickHouse 查询超时，已请求服务器取消".to_owned()
                } else {
                    "ClickHouse 查询超时；服务器取消未确认，请检查数据库运行列表".to_owned()
                }))
            }
        }
    }
    pub async fn cancel(&self, query_id: &str) -> AppResult<u64> {
        if query_id
            .strip_prefix("sonde:")
            .and_then(crate::db::run_marker)
            .as_deref()
            != Some(query_id)
        {
            return Err(AppError::msg("运行编号无效"));
        }
        let sql = format!(
            "KILL QUERY WHERE query_id = '{}' AND user = currentUser() SYNC FORMAT JSON",
            lit(query_id)
        );
        let text = self.request(&sql, Duration::from_secs(5), &[]).await?;
        let value: Json = serde_json::from_str(&text).map_err(|e| AppError::msg(e.to_string()))?;
        cancellation_count(&value)
    }
}

fn cancellation_count(value: &Json) -> AppResult<u64> {
    let rows = value
        .get("data")
        .and_then(Json::as_array)
        .ok_or_else(|| AppError::msg("ClickHouse 没有返回取消结果"))?;
    if rows
        .iter()
        .any(|row| row.get("kill_status").and_then(Json::as_str) != Some("finished"))
    {
        return Err(AppError::msg(
            "ClickHouse 尚未确认查询已停止，请检查数据库运行列表",
        ));
    }
    Ok(rows.len() as u64)
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
