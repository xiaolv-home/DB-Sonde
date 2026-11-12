use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub struct CloudProxy {
    pub(super) client: reqwest::Client,
    inner: Mutex<Inflight>,
}
#[derive(Default)]
struct Inflight {
    cancelled: HashMap<String, Instant>,
    active: HashMap<String, Option<tokio::task::AbortHandle>>,
}
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(30);
const MAX_EARLY_CANCELS: usize = 256;
impl Default for CloudProxy {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .build()
                .expect("model HTTP client"),
            inner: Mutex::new(Inflight::default()),
        }
    }
}
impl CloudProxy {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inflight> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub(super) fn begin(&self, id: &str) -> bool {
        let mut inner = self.lock();
        inner
            .cancelled
            .retain(|_, at| at.elapsed() < EARLY_CANCEL_TTL);
        if inner.cancelled.remove(id).is_some() || inner.active.contains_key(id) {
            return false;
        }
        inner.active.insert(id.to_owned(), None);
        true
    }
    pub(super) fn track(&self, id: &str, handle: tokio::task::AbortHandle) -> bool {
        let mut inner = self.lock();
        if inner.cancelled.contains_key(id) || !inner.active.contains_key(id) {
            handle.abort();
            false
        } else {
            inner.active.insert(id.to_owned(), Some(handle));
            true
        }
    }
    pub(super) fn cancel(&self, id: &str) {
        let mut inner = self.lock();
        if let Some(handle) = inner.active.remove(id).flatten() {
            handle.abort();
        }
        inner
            .cancelled
            .retain(|_, at| at.elapsed() < EARLY_CANCEL_TTL);
        if inner.cancelled.len() >= MAX_EARLY_CANCELS {
            if let Some(oldest) = inner
                .cancelled
                .iter()
                .min_by_key(|(_, at)| *at)
                .map(|(key, _)| key.clone())
            {
                inner.cancelled.remove(&oldest);
            }
        }
        inner.cancelled.insert(id.to_owned(), Instant::now());
    }
    pub(super) fn finish(&self, id: &str) {
        let mut inner = self.lock();
        inner.active.remove(id);
        inner.cancelled.remove(id);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_cancels_are_bounded_and_duplicate_ids_cannot_replace_active_work() {
        let proxy = CloudProxy::default();
        for i in 0..1000 {
            proxy.cancel(&format!("late-{i}"));
        }
        assert!(proxy.lock().cancelled.len() <= MAX_EARLY_CANCELS);
        assert!(proxy.begin("unique"));
        assert!(!proxy.begin("unique"));
        proxy.finish("unique");
        assert!(proxy.begin("unique"));
    }
}
