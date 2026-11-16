'use strict';
/*
 * Windows 打包入口。Electron 本体、NSIS、winCodeSign 默认从 github.com 的
 * Release 下载，国内网络下经常超时；这里默认换成 npmmirror 镜像，
 * 想用官方源时把自己环境里的 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR
 * 设成空字符串即可（脚本不会覆盖已有非空值）。
 *
 *   node scripts/build-win.cjs              → 便携版 + NSIS 安装包
 *   node scripts/build-win.cjs portable     → 只出便携版
 *   node scripts/build-win.cjs nsis         → 只出安装包
 *   node scripts/build-win.cjs portable --dir   → 只解包，不压缩（最快验证）
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const mode = String(process.argv[2] || 'all').toLowerCase();
const rest = process.argv.slice(3);
const cli = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('未找到 electron-builder，请先运行 npm install');
  process.exit(1);
}

const env = { ...process.env };
const DEFAULT_ELECTRON = 'https://npmmirror.com/mirrors/electron/';
const DEFAULT_BINARIES = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
if (!env.ELECTRON_MIRROR) env.ELECTRON_MIRROR = DEFAULT_ELECTRON;
if (!env.ELECTRON_BUILDER_BINARIES_MIRROR) env.ELECTRON_BUILDER_BINARIES_MIRROR = DEFAULT_BINARIES;

const args = [cli, '--win'];
if (mode === 'portable') args.push('portable');
else if (mode === 'nsis' || mode === 'installer') args.push('nsis');
else if (mode !== 'all') {
  console.error('未知目标：' + mode + '（可用 all / portable / nsis）');
  process.exit(1);
}
args.push('--x64', ...rest);

console.log('[build-win] electron 镜像：' + env.ELECTRON_MIRROR);
console.log('[build-win] 打包工具链镜像：' + env.ELECTRON_BUILDER_BINARIES_MIRROR);
console.log('[build-win] 输出目录：release/');

const child = spawn(process.execPath, args, { stdio: 'inherit', env });
child.on('error', err => { console.error('无法启动 electron-builder：' + err.message); process.exit(1); });
child.on('exit', code => process.exit(code == null ? 1 : code));
