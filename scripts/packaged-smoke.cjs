'use strict';
/*
 * Verify the packaged形态 starts without a development server.
 * The app is launched with PAPER_VN_SMOKE=1: its main process reports the real
 * page origin, rendered node count and renderer isolation to a temp file.
 *
 *   npm run desktop:smoke:packaged            # the built portable EXE
 *   npm run desktop:smoke:packaged -- --asar  # app.asar built from current source
 *
 * --asar is the exact payload an EXE loads, so it verifies the packaged
 * paper:// path without re-downloading build tools. No CDP or dev server.
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const asarMode = process.argv.includes('--asar');
// Only CLI args are candidate EXE paths; argv[0] is node.exe itself.
let exe = process.argv.slice(2).find(a => /\.exe$/i.test(a)) ||
  path.join(root, 'release', 'PaperVNStudio-' + version + '-win-x64-portable.exe');
let args = [];
let staging = '';
let child = null;
let log = '';
let cleaned = false;

const out = path.join(os.tmpdir(), 'pvn-packaged-smoke-' + process.pid + '.json');
try { fs.unlinkSync(out); } catch { /* not present */ }
const env = { ...process.env, PAPER_VN_SMOKE: '1', PAPER_VN_SMOKE_OUT: out };
delete env.ELECTRON_RUN_AS_NODE;          // otherwise Electron runs as plain Node

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (child) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
    try { child.kill(); } catch { /* best effort */ }
  }
  try { fs.unlinkSync(out); } catch { /* best effort */ }
  if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function prepareAsar() {
  const asar = require('@electron/asar');
  staging = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-asar-smoke-'));
  const src = path.join(staging, 'app');
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(src, 'desktop'), { recursive: true });
  for (const f of fs.readdirSync(path.join(root, 'dist'))) {
    const from = path.join(root, 'dist', f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(src, 'dist', f));
  }
  for (const f of fs.readdirSync(path.join(root, 'desktop'))) {
    const from = path.join(root, 'desktop', f);
    if (f.endsWith('.cjs') && fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(src, 'desktop', f));
  }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(src, 'package.json'));
  const file = path.join(staging, 'app.asar');
  await asar.createPackage(src, file);
  return { exe: require('electron'), args: [file] };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  if (asarMode) {
    const prepared = await prepareAsar();
    exe = prepared.exe;
    args = prepared.args;
  } else if (!fs.existsSync(exe)) {
    throw new Error('打包产物不存在，请先运行 npm run build:win:portable，或用 --asar 验证打包形态\n' + exe);
  }
  child = spawn(exe, args, { env, cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] });
  if (process.env.PAPER_VN_DEBUG === '1') {
    console.log('[smoke] exe=' + exe + ' cwd=' + path.dirname(exe) + ' out=' + out + ' pid=' + child.pid);
  }
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });

  let result = null;
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(out)) {
      try { result = JSON.parse(fs.readFileSync(out, 'utf8')); break; } catch { /* partial write */ }
    }
    // A portable NSIS launcher exits after spawning the real app, so do not
    // treat launcher exit as failure; keep waiting for the report file.
    await sleep(500);
  }
  if (!result) throw new Error('打包应用未返回自检结果。日志：' + log.slice(-800));
  const info = result.info || {};
  assert(result.ok, '打包自检失败：' + JSON.stringify(info));
  assert(String(info.url).startsWith('paper://app/'), '打包后仍依赖开发服务器或 file://：' + info.url);
  assert(info.nodes >= 7, '打包窗口没有渲染示例剧情');
  assert(info.host, '打包窗口缺少 preload 桥接');
  assert.equal(info.requireType, 'undefined', '打包窗口泄漏 require');
  assert.equal(info.processType, 'undefined', '打包窗口泄漏 process');
  console.log('PASS: ' + (asarMode ? 'app.asar' : 'portable EXE') + ' starts offline through paper://, renderer isolated, editor rendered');
  console.log('  ' + JSON.stringify(info));
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(err => { console.error('PACKAGED SMOKE FAILED: ' + err.stack); cleanup(); process.exit(1); });
