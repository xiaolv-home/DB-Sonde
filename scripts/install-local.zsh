#!/bin/zsh
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
installed_app="/Applications/DB Sonde.app"
built_app="$project_dir/src-tauri/target/release/bundle/macos/DB Sonde.app"
launch_services="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
backup_stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$HOME/.Trash/DB-Sonde-update-$backup_stamp"
rust_bin="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
preferred_signing_identity="${SONDE_SIGNING_IDENTITY:-Sonde Local Signing}"

if ! command -v cargo >/dev/null 2>&1 && [[ -x "$rust_bin/cargo" ]]; then
  export PATH="$rust_bin:$PATH"
fi

require_app_closed() {
  if pgrep -x db-sonde >/dev/null 2>&1; then
    print -u2 "DB Sonde is running. Save your work and quit it before installing the update."
    exit 1
  fi
}

require_app_closed
cd "$project_dir"
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
# 内置运行时(本地 llama、Python)是可选的:跑过 scripts/bundle-llama.sh /
# bundle-python.sh 才有。有就用叠加配置把它们打进去,没有就构建一个不带
# 本地 AI 和 Python 工作台的版本 —— 而不是让构建直接失败。
bundle_args=()
if [[ -n "$(print -rl -- src-tauri/binaries/llama/*(N))" && -f src-tauri/binaries/python-runtime.tar.gz ]]; then
  bundle_args=(--config src-tauri/tauri.bundled.conf.json)
  print "→ 打包内置运行时(llama + Python)"
else
  print "→ 未发现内置运行时,构建精简版(本地 AI 与 Python 工作台不可用)"
  print "  需要的话先跑 scripts/bundle-llama.sh 和 scripts/bundle-python.sh"
fi
npm run tauri build -- --bundles app $bundle_args

if [[ ! -d "$built_app" ]]; then
  print -u2 "Build succeeded but the expected app bundle is missing: $built_app"
  exit 1
fi

require_app_closed

signing_identity="-"
if security find-identity -v -p codesigning | /usr/bin/grep -Fq "\"$preferred_signing_identity\""; then
  signing_identity="$preferred_signing_identity"
else
  print -u2 "No stable code-signing identity named '$preferred_signing_identity' was found."
  print -u2 "Using an ad-hoc signature for this local-only build."
fi

codesign --force --deep --sign "$signing_identity" "$built_app"
codesign --verify --deep --strict "$built_app"

require_app_closed

mkdir -p "$backup_dir"
if [[ -d "$installed_app" ]]; then
  "$launch_services" -u "$installed_app" || true
  mv "$installed_app" "$backup_dir/Sonde-previous.app.backup"
fi

ditto "$built_app" "$installed_app"
codesign --verify --deep --strict "$installed_app"

"$launch_services" -u "$built_app" >/dev/null 2>&1 || true
mv "$built_app" "$backup_dir/Sonde-build-output.app.backup"
"$launch_services" -f "$installed_app"
mdimport "$installed_app" >/dev/null 2>&1 || true

installed_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$installed_app/Contents/Info.plist")"
print "Installed DB Sonde $installed_version at $installed_app"
print "Code-signing identity: $signing_identity"
print "Previous app backup: $backup_dir"
