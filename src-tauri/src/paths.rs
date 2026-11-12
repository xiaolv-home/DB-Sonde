//! 跨模块共用的路径工具。

use std::path::PathBuf;

/// 用户主目录。不要读 `HOME`：Windows 上通常没有这个变量，读了就落到盘符根目录。
/// `dirs::home_dir()` 在 Windows 用的是用户配置里的 Profile；那个接口失败时再看 `USERPROFILE`。
pub(crate) fn home_dir() -> PathBuf {
    if let Some(dir) = dirs::home_dir().filter(|dir| !dir.as_os_str().is_empty()) {
        return dir;
    }
    #[cfg(windows)]
    if let Some(dir) = std::env::var_os("USERPROFILE").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        PathBuf::new()
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_comes_from_dirs() {
        let expected = dirs::home_dir().expect("this machine has a home directory");
        assert_eq!(home_dir(), expected);
    }
}
