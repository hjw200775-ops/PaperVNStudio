'use strict';
/*
 * V0.8.1-RC3.1 / M1 实机复现：track_018（10.5MB / 60s WAV）voice 播放失败根因。
 *
 * 用真实 Chromium 解码真实压测素材，验证：
 *   1. voice 能否真正起播（真实 start 延迟）。
 *   2. 起播后立即切句打断 → 记 cancelled、不记错误（修复前的根因：AbortError 被误判「播放失败」）。
 *   3. 真正缺失素材 → 记 missing 错误。
 *
 * 用法：node scripts/v081rc3-voice-verify.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(ROOT, 'release', 'v081rc3');
const VOICE = path.join(ROOT, 'release', 'bench-project', 'assets', 'audio', 'b6befdc120272a6ba1646f2d6b3845ef5d18f8dadd4a1960915948cc1ffefdfe.wav');

function buildPage() {
  const audioJs = fs.readFileSync(path.join(ROOT, 'dist', 'audio.js'), 'utf8');
  const wav = 'data:audio/wav;base64,' + fs.readFileSync(VOICE).toString('base64');
  return `<!doctype html><meta charset="utf-8"><title>voice verify</title>
<body><script>${audioJs}</script>
<script>
const WAV = ${JSON.stringify(wav)};
window.__voiceVerify = async () => {
  const out = {};
  const A = createPaperAudio();
  const rt = A.runtime({ assetData: id => id === 'voice' ? WAV : '', prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 } });

  // 1. 正常起播，测真实 start 延迟
  const t0 = performance.now();
  const p = rt.voicePlay({ audioId: 'voice', volume: 1, duck: true });
  // 轮询等 started
  let startedAt = -1;
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (rt.playbackStats().started >= 1) { startedAt = performance.now() - t0; break; }
  }
  out.startLatencyMs = Math.round(startedAt);
  out.afterStart = { stats: rt.playbackStats(), errors: rt.status().errors.map(e => e.title + ':' + (e.label || e.audioId)) };

  // 2. 起播后立即打断（模拟切句）→ cancelled，不记错误
  rt.voiceStop();
  await new Promise(r => setTimeout(r, 100));
  out.afterInterrupt = { stats: rt.playbackStats(), errors: rt.status().errors.map(e => e.title + ':' + (e.label || e.audioId)) };

  // 3. 真正缺失素材 → missing
  rt.voicePlay({ audioId: 'missing', volume: 1, duck: false });
  await new Promise(r => setTimeout(r, 100));
  out.afterMissing = { stats: rt.playbackStats(), errors: rt.status().errors.map(e => e.title + ':' + (e.label || e.audioId)) };

  rt.dispose();
  return out;
};
window.__ready = true;
</script></body>`;
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const page = path.join(WORK, 'voice-verify.html');
  fs.writeFileSync(page, buildPage(), 'utf8');
  const shell = path.join(WORK, 'voice-verify-shell.cjs');
  fs.writeFileSync(shell, [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    "const fs = require('node:fs');",
    "app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');",
    'app.whenReady().then(async () => {',
    '  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });',
    '  await win.loadFile(process.argv[2]);',
    '  for (let i = 0; i < 100; i++) { if (await win.webContents.executeJavaScript("!!window.__ready").catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }',
    '  const r = await win.webContents.executeJavaScript("window.__voiceVerify()", true);',
    '  fs.writeFileSync(process.argv[3], JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2), "utf8");',
    '  app.exit(0);',
    '});'
  ].join('\n'), 'utf8');

  const tmp = path.join(WORK, 'voice-verify-result.json');
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  await new Promise((resolve) => { const p = spawn(ELECTRON, [shell, page, tmp], { cwd: ROOT, stdio: 'inherit', env }); p.on('exit', resolve); });
  if (!fs.existsSync(tmp)) { console.error('voice 验证没有产出结果'); process.exit(1); }
  const r = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})();
