use crate::error::AppError;

pub(super) fn scrub(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_string()
    } else {
        text.replace(secret, "****")
    }
}

pub(super) fn public_error(err: &impl std::fmt::Display, secret: &str) -> AppError {
    AppError::msg(scrub(&err.to_string(), secret))
}

pub(super) struct Scrubber {
    secret: String,
    held: String,
}

impl Scrubber {
    pub(super) fn new(secret: &str) -> Self {
        Self {
            secret: secret.to_string(),
            held: String::new(),
        }
    }

    pub(super) fn push(&mut self, text: &str) -> String {
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

    pub(super) fn finish(&mut self) -> String {
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

pub(super) fn take_utf8(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
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
