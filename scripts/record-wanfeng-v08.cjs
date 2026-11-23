'use strict';
/*
 * V0.8.0 · 《晚风经过二楼走廊》演出试玩版的真实窗口录屏。
 *
 * 为什么要自己写：机器上没有 ffmpeg，也不该为了验收去装一个。
 * 这里用 Chromium 自带的 MediaRecorder 录「窗口画面」：
 *   主进程 → setDisplayMediaRequestHandler 选定本窗口；
 *   渲染进程 → getDisplayMedia + MediaRecorder(vp9) 录成 webm；
 *   主进程 → 每 500ms 把已成形的数据块取回来顺次写进文件（避免一次性搬几十 MB 字符串）。
 *
 * 用法：
 *   node scripts/record-wanfeng-v08.cjs [html] [out.webm]
 * 默认录制 release/wanfeng-v080/晚风经过二楼走廊·演出优化版.html
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_HTML = path.join(ROOT, 'release', 'wanfeng-v080', '晚风经过二楼走廊·演出优化版.html');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'media', 'v080-wanfeng-play.webm');

if (!process.versions.electron) {
  /* ---------- Node 侧：把自己当成 Electron 应用入口再启动一次 ---------- */
  const { spawn } = require('node:child_process');
  const html = path.resolve(process.argv[2] || DEFAULT_HTML);
  const out = path.resolve(process.argv[3] || DEFAULT_OUT);
  if (!fs.existsSync(html)) { console.error('找不到试玩版 HTML：' + html); process.exit(1); }
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(electron, [__filename, html, out], { cwd: ROOT, stdio: 'inherit', env });
  proc.on('exit', (code) => process.exit(code == null ? 1 : code));
  return;
}

/* ---------- Electron 主进程 ---------- */
const { app, BrowserWindow, session, desktopCapturer, Menu } = require('electron');
const html = path.resolve(process.argv[2] || DEFAULT_HTML);
const out = path.resolve(process.argv[3] || DEFAULT_OUT);
fs.mkdirSync(path.dirname(out), { recursive: true });
const partFile = out + '.part';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

let win = null;
let failed = '';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 页面里跑的录制 + 自动推进脚本。返回前只做初始化，进度靠主进程轮询。 */
const BOOT = `(() => {
  window.__rec = { ready: [], state: 'boot', error: '', index: 0, seconds: 0, total: 0 };
  const hint = () => (document.getElementById('hint') || {}).textContent || '';
  const waitFor = (fn, ms) => new Promise((res, rej) => {
    const end = Date.now() + ms;
    const tick = () => { if (fn()) return res(true); if (Date.now() > end) return rej(new Error('等待超时')); setTimeout(tick, 120); };
    tick();
  });
  const blobToB64 = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(new Error('读取录屏数据失败'));
    fr.readAsDataURL(blob);
  });
  (async () => {
    try {
      await waitFor(() => document.getElementById('startGame'), 20000);
      const start = document.getElementById('startGame');
      if (!start.disabled) start.click();
      await waitFor(() => !document.getElementById('titleScreen') || document.getElementById('titleScreen').hidden, 15000);
      await new Promise(r => setTimeout(r, 900));
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: 1280, height: 720 }, audio: false });
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : {});
      window.__rec.mime = mime || 'default';
      rec.ondataavailable = async (e) => {
        if (!e.data || !e.data.size) return;
        try { window.__rec.ready.push(await blobToB64(e.data)); } catch (err) { window.__rec.error = String(err); }
      };
      const stopped = new Promise((res) => { rec.onstop = res; });
      rec.start(1000);
      window.__rec.state = 'recording';
      const t0 = performance.now();
      const scene = document.getElementById('scene');
      /* 一句一停：正在播阻塞演出就先把演出结算掉，再进下一句。 */
      const step = () => {
        if (/演出中/.test(hint())) { scene.click(); return false; }
        scene.click(); return true;
      };
      let guard = 0;
      while (guard++ < 400) {
        await new Promise(r => setTimeout(r, 3400));
        const st = window.paperGameState ? window.paperGameState() : null;
        if (!st) break;
        const last = st.i >= st.nodes - 1;
        if (last) { await new Promise(r => setTimeout(r, 2200)); break; }
        step();
      }
      window.__rec.seconds = Math.round((performance.now() - t0) / 1000);
      rec.stop();
      stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      await stopped;
      window.__rec.total = window.__rec.ready.length;
      window.__rec.state = 'done';
    } catch (err) {
      window.__rec.error = String((err && err.message) || err);
      window.__rec.state = 'error';
    }
    return true;
  })();
  return true;
})()`;

app.whenReady().then(async () => {
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const pick = sources.find((s) => /晚风|演出试玩|PaperVN/.test(s.name)) || sources[0];
      callback({ video: pick });
    }, { useSystemPicker: false });

    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1280, height: 760, show: true, backgroundColor: '#17261f',
      title: '晚风经过二楼走廊 · 演出试玩',
      webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false, nodeIntegration: false }
    });
    win.setMenuBarVisibility(false);
    win.setTitle('晚风经过二楼走廊 · 演出试玩');
    await win.loadFile(html);
    await sleep(600);
    await win.webContents.executeJavaScript(BOOT);

    /* 边录边取：每次只搬几块，页面侧 splice 掉已写盘的部分 */
    const fd = fs.openSync(partFile, 'w');
    let chunks = 0;
    for (let i = 0; i < 900; i++) {
      const st = await win.webContents.executeJavaScript('({state: window.__rec.state, error: window.__rec.error, ready: window.__rec.ready.length, seconds: window.__rec.seconds})');
      if (st.ready) {
        const batch = await win.webContents.executeJavaScript('window.__rec.ready.splice(0, 6)');
        for (const b64 of batch || []) { fs.writeSync(fd, Buffer.from(b64, 'base64')); chunks++; }
      }
      if (st.state === 'error') { failed = st.error || '录屏失败'; break; }
      if (st.state === 'done' && !st.ready) { fs.closeSync(fd); break; }
      await sleep(400);
    }
    if (fs.existsSync(partFile)) {
      if (fs.statSync(partFile).size > 1024) fs.renameSync(partFile, out);
      else fs.rmSync(partFile, { force: true });
    }
    const seconds = await win.webContents.executeJavaScript('window.__rec.seconds');
    const mime = await win.webContents.executeJavaScript('window.__rec.mime');
    const meta = {
      at: new Date().toISOString(), version: '0.8.0', file: path.relative(ROOT, out).replace(/\\/g, '/'),
      bytes: fs.existsSync(out) ? fs.statSync(out).size : 0, chunks, seconds, mime,
      ok: !failed && fs.existsSync(out), error: failed
    };
    fs.writeFileSync(path.join(ROOT, 'release', 'wanfeng-v08-recording.json'), JSON.stringify(meta, null, 2), 'utf8');
    console.log(JSON.stringify(meta, null, 1));
    app.exit(meta.ok ? 0 : 1);
  } catch (e) {
    failed = (e && e.message) || String(e);
    fs.writeFileSync(path.join(ROOT, 'release', 'wanfeng-v08-recording.json'), JSON.stringify({ at: new Date().toISOString(), ok: false, error: failed }, null, 2), 'utf8');
    console.error('录屏失败：' + failed);
    app.exit(1);
  }
});
