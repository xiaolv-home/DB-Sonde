import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build an application-only DMG. Never copy user data or the source checkout.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
const read = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Run this packager on an Apple Silicon Mac.');
if (process.argv.slice(2).some(arg => arg !== '--skip-build')) throw Error('Only --skip-build is supported (for an already verified release build).');
if (!process.argv.includes('--skip-build')) run('npm', ['run', 'tauri', 'build', '--', '--bundles', 'app']);

const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const appName = `${config.productName}.app`;
const builtApp = join(root, 'src-tauri/target/release/bundle/macos', appName);
const plist = join(builtApp, 'Contents/Info.plist');
const plistValue = key => read('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
if (plistValue('CFBundleIdentifier') !== config.identifier || plistValue('CFBundleShortVersionString') !== config.version) {
  throw Error('The application does not match the current identity/version. Rebuild it first.');
}
const executable = join(builtApp, 'Contents/MacOS', plistValue('CFBundleExecutable'));
if (read('/usr/bin/lipo', ['-archs', executable]) !== 'arm64') throw Error('Expected an arm64 application.');
const linked = read('/usr/bin/otool', ['-L', executable]).split('\n').slice(1).map(line => line.trim().split(' ')[0]);
if (linked.some(path => !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'))) {
  throw Error('The application links to a non-system library; it is not self-contained.');
}

const output = join(root, 'src-tauri/target/release/bundle/dmg');
mkdirSync(output, { recursive: true });
const name = `DB-Sonde_${config.version}_macOS_arm64.dmg`;
const dmg = join(output, name);
const stage = mkdtempSync(join(tmpdir(), 'db-sonde-dmg-'));
try {
  const app = join(stage, appName);
  run('/usr/bin/ditto', [builtApp, app]);
  const resources = join(app, 'Contents/Resources');
  for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(root, file), join(resources, file));

  // Retain dependency copyright/license notices in the distributed binary.
  const licenses = join(resources, 'licenses');
  mkdirSync(licenses, { recursive: true });
  const inventory = [];
  const collect = (ecosystem, name, version, license, directory) => {
    const id = `${ecosystem}-${name}-${version}`.replace(/[^a-z0-9._-]/gi, '_');
    const files = readdirSync(directory).filter(name => /^(licen[cs]e|copying|copyright|notice|ofl)([._-]|$)/i.test(name));
    if (files.length) {
      mkdirSync(join(licenses, id), { recursive: true });
      for (const file of files) cpSync(join(directory, file), join(licenses, id, file), { recursive: true, dereference: true });
    }
    inventory.push(`${ecosystem}: ${name} ${version} — ${typeof license === 'string' ? license : 'see included notices'}`);
  };
  for (const directory of read('npm', ['ls', '--omit=dev', '--all', '--parseable']).split('\n')) {
    if (directory === root || !existsSync(join(directory, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    collect('npm', pkg.name, pkg.version, pkg.license, directory);
  }
  const metadata = JSON.parse(read('cargo', ['metadata', '--offline', '--locked', '--filter-platform', 'aarch64-apple-darwin', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml']));
  for (const pkg of metadata.packages) {
    if (dirname(pkg.manifest_path) === join(root, 'src-tauri')) continue;
    collect('cargo', pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path));
  }
  writeFileSync(join(licenses, 'INDEX.txt'), `${inventory.sort().join('\n')}\n`);

  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  symlinkSync('/Applications', join(stage, 'Applications'));
  writeFileSync(join(stage, '安装说明.txt'), `DB Sonde ${config.version} — Apple Silicon / M 系列 Mac\n\n1. 把 DB Sonde.app 拖到旁边的 Applications 文件夹。\n2. 从“应用程序”打开 DB Sonde。\n3. 首次打开连接列表为空；可手动创建本地演示库体验。\n\n当前安装包未经过 Apple 签名公证。如果首次打开被拦截，请在“系统设置 → 隐私与安全性”中找到 DB Sonde，选择“仍要打开”。\n\n安装不需要 Node、Rust、Homebrew 或编译源码。\n此基础安装包包含数据库客户端与云端 AI 接口；本地 AI 和 Python 运行时未内置。\n\n项目与更新：https://github.com/xiaolv-home/DB-Sonde\n`);
  run('/usr/bin/hdiutil', ['create', '-ov', '-volname', 'DB Sonde', '-fs', 'HFS+', '-format', 'UDZO', '-srcfolder', stage, dmg]);
  run('/usr/bin/hdiutil', ['verify', dmg]);
  const sha256 = createHash('sha256').update(readFileSync(dmg)).digest('hex');
  writeFileSync(`${dmg}.sha256`, `${sha256}  ${basename(dmg)}\n`);
  console.log(`Installer: ${dmg}\nSHA-256: ${sha256}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
