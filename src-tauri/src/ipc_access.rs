//! Remote monitor windows never receive application IPC, even after navigating to a local URL.
pub fn application_window(label: &str) -> bool {
    matches!(label, "main" | "lineage-canvas")
}
#[cfg(test)]
mod tests {
    #[test]
    fn only_known_ui_windows_receive_application_commands() {
        assert!(super::application_window("main"));
        assert!(super::application_window("lineage-canvas"));
        for label in ["monitor-win-main", "main-frame", "", "new-window"] {
            assert!(!super::application_window(label));
        }
    }
}
