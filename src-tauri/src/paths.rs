//! 跨模块共用的路径工具。

use std::path::PathBuf;

/// 用户主目录。不要读 `HOME`：Windows 上通常没有这个变量，读了就落到盘符根目录。
/// `dirs::home_dir()` 在 Windows 用的是用户配置里的 Profile；那个接口失败时再看 `USERPROFILE`。
pub(crate) fn home_dir() -> PathBuf {
    dirs::home_dir()
        .filter(|dir| dir.is_absolute())
        .expect("操作系统未提供用户主目录，不能安全定位应用文件")
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
