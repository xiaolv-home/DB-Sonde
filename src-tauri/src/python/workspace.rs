//! 工作区文件(~/.db-sonde/workspace):列表、读写、新建、改名、删除,一律限制在工作区里。

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::workspace_dir;

// ---- workspace file CRUD (scoped to ~/.db-sonde/workspace) ----

#[derive(Serialize, Debug)]
pub struct PyFile {
    name: String,
    path: String,
    size: u64,
}

pub(super) fn ensure_workspace() -> PathBuf {
    let dir = workspace_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Resolve both the parent and final component; never fall back to a lexical
/// prefix if filesystem resolution fails. A missing leaf is valid for creation.
fn workspace_path(path: &Path) -> Result<PathBuf, String> {
    let denied = || "路径不在工作区内".to_string();
    let root = std::fs::canonicalize(workspace_dir()).map_err(|_| denied())?;
    let parent = path.parent().ok_or_else(denied)?;
    let parent = std::fs::canonicalize(parent).map_err(|_| denied())?;
    let name = path.file_name().ok_or_else(denied)?;
    let resolved = parent.join(name);
    if !resolved.starts_with(&root) || resolved == root { return Err(denied()); }
    match std::fs::symlink_metadata(&resolved) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(denied()),
        Ok(_) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err(denied()),
    }
    Ok(resolved)
}
pub(super) fn in_workspace(path: &Path) -> bool { workspace_path(path).is_ok() }
pub(super) fn workspace_file(path: &Path, write: bool) -> Result<std::fs::File, String> {
    let path = workspace_path(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(!write).write(write).create(write).truncate(write);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW); }
    options.open(path).map_err(|e| format!("打开文件失败:{e}"))
}
fn script_name(name: &str) -> Result<&str, String> {
    let name = name.trim().trim_end_matches(".py");
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err("名字不合法".into());
    }
    Ok(name)
}

#[tauri::command]
pub fn py_workspace_dir() -> String {
    ensure_workspace().to_string_lossy().into_owned()
}

// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_list_files() -> Vec<PyFile> {
    let dir = ensure_workspace();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) == Some("py") {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(PyFile {
                    name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(),
                    size,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 按扩展名列工作区里的文件(不含子目录)。Python 脚本之外的东西也放这儿,
/// 比如「导出网页」产出的看板 .html —— 文件面板据此分组展示。
// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn workspace_list_files(ext: String) -> Vec<PyFile> {
    let dir = ensure_workspace();
    let want = ext.trim_start_matches('.').to_lowercase();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            let matches = path
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.to_lowercase() == want)
                .unwrap_or(false);
            if matches {
                out.push(PyFile {
                    name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(),
                    size: e.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_read_file(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut content = String::new();
    workspace_file(Path::new(&path), false)?.read_to_string(&mut content).map_err(|e| format!("读取失败:{e}"))?;
    Ok(content)
}

// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_write_file(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    workspace_file(Path::new(&path), true)?.write_all(content.as_bytes()).map_err(|e| format!("写入失败:{e}"))
}

/// Create a new .py file (auto-suffixed if the name is taken). Returns its path.
// 写文件,放线程池里
#[tauri::command(async)]
pub fn py_new_file(name: Option<String>) -> Result<PyFile, String> {
    let dir = ensure_workspace();
    let base = name.unwrap_or_else(|| "未命名".into());
    let base = script_name(&base)?;
    let mut candidate = dir.join(format!("{base}.py"));
    let mut n = 1;
    let template = "# Sonde · Python 工作台(⌘⏎ 运行)\n\
# 内置 pandas / numpy / polars…,还能直接查你左边连好的库:\n\
#\n\
#   from sonde import query, connections\n\
#   print(connections())                        # 当前打开的连接名\n\
#   df = query(\"SELECT 1 AS n\", conn=\"连接名\")   # -> pandas.DataFrame\n\
\n\
import pandas as pd\n\
\n\
print(\"hello from Sonde 🐍\")\n\
print(pd.DataFrame({\"n\": [1, 2, 3], \"n2\": [1, 4, 9]}))\n";
    use std::io::Write;
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => { file.write_all(template.as_bytes()).map_err(|e| format!("创建失败:{e}"))?; break; },
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                n += 1; candidate = dir.join(format!("{base}{n}.py"));
            },
            Err(e) => return Err(format!("创建失败:{e}")),
        }
    }
    Ok(PyFile {
        name: candidate.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: candidate.to_string_lossy().into_owned(),
        size: template.len() as u64,
    })
}

#[tauri::command]
pub fn py_delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !in_workspace(&p) {
        return Err("路径不在工作区内".into());
    }
    std::fs::remove_file(&p).map_err(|e| format!("删除失败:{e}"))
}

#[tauri::command]
pub fn py_rename_file(path: String, new_name: String) -> Result<PyFile, String> {
    let p = PathBuf::from(&path);
    if !in_workspace(&p) {
        return Err("路径不在工作区内".into());
    }
    let clean = script_name(&new_name)?;
    let target = ensure_workspace().join(format!("{clean}.py"));
    if target.exists() && target != p {
        return Err("同名文件已存在".into());
    }
    std::fs::rename(&p, &target).map_err(|e| format!("重命名失败:{e}"))?;
    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(PyFile {
        name: target.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: target.to_string_lossy().into_owned(),
        size,
    })
}

/// Read a plot PNG (written by `sonde.show()`) as a data: URL for inline view.
// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_read_image(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    workspace_file(Path::new(&path), false)?.read_to_end(&mut bytes).map_err(|e| format!("读图失败:{e}"))?;
    Ok(format!("data:image/png;base64,{}", b64(&bytes)))
}
/// Minimal base64 (std-only) for embedding a plot PNG as a data: URL.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    use crate::python::TEST_WORKSPACE;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("sonde-workspace-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            TEST_WORKSPACE.with(|p| *p.borrow_mut() = Some(root.clone()));
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            TEST_WORKSPACE.with(|p| *p.borrow_mut() = None);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 工作区边界:路径规范化之后必须落在工作区里。
    /// `..` 和符号链接都要解开 —— 只做字符串前缀比较的话
    /// `<工作区>/../../etc/passwd` 会直接通过。
    #[test]
    fn traversal_does_not_escape_the_workspace() {
        let _fixture = Fixture::new();
        let ws = ensure_workspace();
        assert!(in_workspace(&ws.join("a.py")), "工作区里的文件当然可以");
        assert!(
            !in_workspace(&ws.join("..").join("escaped.py")),
            "上跳一层就出了工作区"
        );
        assert!(
            !in_workspace(&ws.join("..").join("..").join("etc").join("passwd")),
            "多跳几层也一样"
        );
        assert!(!in_workspace(Path::new("/etc/passwd")), "绝对路径直接拒绝");
        // 子目录是工作区的一部分,不该误伤
        let sub = ws.join("sub");
        let _ = std::fs::create_dir_all(&sub);
        assert!(in_workspace(&sub.join("b.py")), "工作区的子目录算在内");
        let _ = std::fs::remove_dir(&sub);
    }

    /// 改名只收纯文件名。原来只挡 '/',反斜杠(Windows 的分隔符)和 `..` 都能过。
    ///
    /// 源文件必须真在工作区里 —— 否则 in_workspace 先把它拦下,
    /// 名字校验那段根本走不到,测了等于没测(第一版就是这样)。
    #[test]
    fn rename_rejects_anything_that_is_not_a_plain_name() {
        let _fixture = Fixture::new();
        let ws = ensure_workspace();
        let source = ws.join("rename-guard-fixture.py");
        std::fs::write(&source, "# fixture\n").expect("工作区应当可写");
        let path = source.to_string_lossy().into_owned();
        for bad in ["", "   ", "../evil", "a/b", "..\\evil", ".", ".."] {
            let result = py_rename_file(path.clone(), bad.into());
            assert!(result.is_err(), "「{bad}」不该被当成合法文件名");
            assert_eq!(
                result.unwrap_err(),
                "名字不合法",
                "「{bad}」该在名字校验那一步被拦下,不是别的原因"
            );
        }
        // 正常名字要能改成功(别把守卫收得连正经改名都不让)
        let ok = py_rename_file(path, "renamed-fixture".into()).expect("正常名字应当可以");
        assert_eq!(ok.name, "renamed-fixture.py");
        let _ = std::fs::remove_file(ws.join("renamed-fixture.py"));
    }
    #[test]
    fn new_file_rejects_paths_and_does_not_overwrite() {
        let _fixture = Fixture::new();
        for bad in ["../escape", "/tmp/escape", "a/b", "..\\escape", "", ".", "..", "C:\\escape"] {
            assert!(py_new_file(Some(bad.into())).is_err(), "{bad}");
        }
        let first = py_new_file(Some("safe.py".into())).unwrap();
        py_write_file(first.path.clone(), "keep".into()).unwrap();
        let second = py_new_file(Some("safe.py".into())).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(py_read_file(first.path).unwrap(), "keep");
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_read_or_overwrite_outside_files() {
        let fixture = Fixture::new();
        let outside = fixture.0.with_extension("outside");
        std::fs::write(&outside, "keep").unwrap();
        let link = fixture.0.join("link.py");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let path = link.to_string_lossy().into_owned();
        assert!(py_read_file(path.clone()).is_err());
        assert!(py_read_image(path.clone()).is_err());
        assert!(py_write_file(path, "overwritten".into()).is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        std::fs::remove_file(outside).unwrap();
    }

}
