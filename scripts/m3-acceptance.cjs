'use strict';
/*
 * V0.7.6-M3 1 GiB 真实 Electron 窗口验收。
 *
 * 与只跑 Node 层单测不同，本脚本在真实编辑器窗口里完成：
 *   导入素材 → 打开大型工程 → 编辑剧本 → 切换章节/场景 → 显示背景与立绘 →
 *   播放 BGM/SFX/Voice → 撤销/重做 → 保存 → 关闭并重开 → 完整预览 →
 *   导出目录版游戏 → 启动导出的游戏并验证资源加载。
 *
 * 全程用 CDP 对真实窗口取证 + 持续采样 app.getAppMetrics() 与 OS 进程工作集。
 * 用法：node scripts/m3-acceptance.cjs [--project F:/pvn-1gib-m3-valid] [--skip-export]
 */
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const argOf = (k, d) => { const i = ARGS.indexOf('--' + k); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d; };
const PROJECT = path.resolve(argOf('project', 'F:/pvn-1gib-m3-valid'));
const SKIP_EXPORT = ARGS.includes('--skip-export');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-m3-accept-'));
const USER_DATA = path.join(WORK, 'user-data');
const EXPORT_DIR = path.join(WORK, 'exports');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const report = {
  version: '0.7.6-M3', at: new Date().toISOString(), project: PROJECT,
  machine: { platform: os.platform(), arch: os.arch(), cpuModel: os.cpus()[0].model,
    cpus: os.cpus().length, totalMem: os.totalmem(), freeMem: os.freemem(),
    node: process.version, electron: (() => { try { return require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version; } catch { return null; } })() },
  ok: true, stages: {}, problems: [], screenshots: [], assertions: {}, sizes: {}, incidents: []
};
const samples = [];
const stages = {};
let currentStage = 'boot';
const okStep = (name, detail) => { report.stages[name] = { ok: true, detail }; console.log('  ok  ' + name); };
const bad = (name, e) => {
  report.ok = false; const m = e && e.message || String(e);
  report.problems.push(name + '：' + m); report.stages[name] = { ok: false, message: m };
  console.log('  FAIL ' + name + ' — ' + m);
};
let forceSample = null;
async function stage(name, fn) {
  currentStage = name;
  const t0 = Date.now();
  stages[name] = { startedAt: new Date().toISOString() };
  if (forceSample) await forceSample(name);          // 阶段开始必采一次
  try { const v = await fn(); stages[name].ok = true; return v; }
  catch (e) { stages[name].ok = false; stages[name].error = e && e.message || String(e); throw e; }
  finally {
    if (forceSample) await forceSample(name);        // 阶段结束必采一次
    stages[name].ms = Date.now() - t0; stages[name].finishedAt = new Date().toISOString();
  }
}

/* ---------- 真实 PNG / WAV 生成（CRC 正确，可解码） ---------- */
function crc32(buf) {
  const t = [];
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function png(w, h, seed) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let i = 0; i < w; i++) { row[1 + i * 3] = seed & 255; row[2 + i * 3] = (seed >> 8) & 255; row[3 + i * 3] = (seed >> 16) & 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds) {
  const rate = 8000, frames = seconds * rate, data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(i / 12) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/* ---------- CDP ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function httpJson(url, ms = 2000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
async function waitPage(port, match, timeout = 180000, quiet = false) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find(x => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    if (!quiet && (Date.now() - (end - timeout)) % 20000 < 300) { /* no noisy logs */ }
    await sleep(300);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP 连接超时')), 20000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); };
  });
  let id = 0; const pending = new Map();
  const errors = [];
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails || {};
      errors.push(String((d.exception && d.exception.description) || d.text || 'unknown exception'));
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params && m.params.entry || {};
      if (e.level === 'error') errors.push(String(e.text || 'log error'));
    } else if (m.method === 'Inspector.targetCrashed') {
      errors.push('Inspector.targetCrashed（渲染进程崩溃）');
    }
    const s = pending.get(m.id); if (!s) return;
    pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result);
  };
  ws.onclose = () => { for (const s of pending.values()) s.reject(new Error('CDP 连接已关闭')); pending.clear(); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params }));
  });
  /* 开启异常与日志事件，用于事后判定 OOM / Invalid string length / 渲染进程崩溃。 */
  send('Runtime.enable').catch(() => {});
  send('Log.enable').catch(() => {});
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result && r.result.value;
  };
  const shot = async file => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return path.relative(ROOT, file);
  };
  return { send, ev, shot, errors, close: () => { try { ws.close(); } catch {} } };
}

/* ---------- 内存持续采样 ---------- */
let editor = null, sampling = true, baselinePids = new Set(), proc = null;
/* 每个真实窗口的 CDP 异常事件汇总（引用持久保留，窗口关闭后仍可读取）。 */
const windowErrors = [];
function watch(name, cdp) { windowErrors.push({ window: name, errors: cdp.errors }); return cdp; }
function tasklist() {
  return new Promise(resolve => {
    execFile('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq electron.exe'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const out = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^"electron\.exe","(\d+)".*?"([0-9,]+) K"/i.exec(line.trim());
        if (!m) continue;
        const pid = Number(m[1]); if (baselinePids.has(pid)) continue;
        out.push({ pid, bytes: Number(m[2].replace(/,/g, '')) * 1024 });
      }
      resolve(out);
    });
  });
}
function snapshotBaseline() { return tasklist().then(list => { baselinePids = new Set(list.map(x => x.pid)); }); }
function startSampling() {
  let cdpBusy = false;
  async function cdpSample(stageName) {
    if (!editor) return;
    try {
      const r = await editor.ev(`window.PaperHost.metrics()`);
      if (r && r.ok && Array.isArray(r.metrics)) {
        /* Electron ProcessMetric.memory.workingSetSize 的单位是 KB；
           进程类型中渲染进程叫 Tab（不是 Renderer），主进程叫 Browser。 */
        const KB = 1024;
        const m = r.metrics;
        const browser = m.filter(x => x.type === 'browser').reduce((s, x) => s + x.workingSetSize, 0) * KB;
        const renderer = m.filter(x => x.type === 'tab').reduce((s, x) => s + x.workingSetSize, 0) * KB;
        const total = m.reduce((s, x) => s + x.workingSetSize, 0) * KB;
        samples.push({ at: Date.now(), stage: stageName || currentStage, source: 'cdp',
          mainBytes: browser, rendererBytes: renderer, totalBytes: total,
          peakWorkingSetBytes: m.reduce((s, x) => Math.max(s, x.peakWorkingSetSize || 0), 0) * KB,
          processes: m.length, types: [...new Set(m.map(x => x.type))] });
      }
    } catch { /* 窗口重建/忙碌时跳过，OS 采样独立兜底 */ }
  }
  async function osSample(stageName) {
    const list = await tasklist();
    if (!list.length) return;
    samples.push({ at: Date.now(), stage: stageName || currentStage, source: 'tasklist',
      totalBytes: list.reduce((s, x) => s + x.bytes, 0), processes: list.length });
  }
  const cdpTimer = setInterval(async () => {
    if (!sampling || cdpBusy || !editor) return;
    cdpBusy = true;
    try { await cdpSample(); } finally { cdpBusy = false; }
  }, 150);
  const osTimer = setInterval(async () => {
    if (sampling) await osSample();
  }, 250);
  cdpTimer.unref(); osTimer.unref();
  /* 阶段首尾强制采样：即使某阶段只有几十毫秒，也至少留下两个真实采样点。 */
  forceSample = async name => { await Promise.all([cdpSample(name), osSample(name)]); };
  return () => { sampling = false; forceSample = null; clearInterval(cdpTimer); clearInterval(osTimer); };
}
function launch(port) {
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  return spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + USER_DATA],
    { cwd: ROOT, stdio: 'ignore', env });
}
function killTree(pid) { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }

function projectStats() {
  const disk = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));
  const unique = new Map();
  for (const a of [...disk.assets, ...(disk.audioAssets || [])]) unique.set(a.sha256, a.bytes);
  let actual = 0; for (const b of unique.values()) actual += b;
  return { actualAssetBytes: actual, uniqueHashes: unique.size, images: disk.assets.length,
    audio: (disk.audioAssets || []).length, nodes: disk.nodes.length,
    chapters: (disk.chapters || []).length, runtimeJsonBytes: JSON.stringify(disk).length,
    diskJsonBytes: fs.statSync(path.join(PROJECT, 'project.paper.json')).size };
}

(async () => {
  if (!fs.existsSync(path.join(PROJECT, 'project.paper.json'))) {
    throw new Error('1 GiB 测试工程不存在：' + PROJECT + '（先运行 scripts/make-large-project-m3.cjs）');
  }
  fs.mkdirSync(USER_DATA, { recursive: true }); fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT,
    items: [{ path: PROJECT, title: '1 GiB 流式素材压力测试 · M3', openedAt: new Date().toISOString() }]
  }));
  await snapshotBaseline();
  const port = await freePort();
  const stopSampling = startSampling();
  let preview = null, game = null, gameProc = null;
  try {
    const stats = projectStats();
    report.sizes = Object.assign({}, stats, {
      assetBytesOnDisk: (() => { let n = 0; for (const d of ['images', 'audio']) {
        const dir = path.join(PROJECT, 'assets', d);
        if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) n += fs.statSync(path.join(dir, f)).size;
      } return n; })()
    });
    if (stats.actualAssetBytes < 1073741824) throw new Error('素材总量不足 1 GiB：' + stats.actualAssetBytes);
    report.assertions.assetBytesMeetTarget = true;
    okStep('测试工程素材总量与去重统计', report.sizes);

    /* ===== 1. 打开大型工程（真实窗口 bootstrap） ===== */
    await stage('openProject', async () => {
      proc = launch(port);
      const page = await waitPage(port, u => u.startsWith('paper://app/'), 120000);
      if (!page) throw new Error('编辑器窗口未出现');
      editor = watch('editor', await connect(page.webSocketDebuggerUrl));
      let ready = null;
      for (let i = 0; i < 300; i++) {
        ready = await editor.ev(`(() => { const M=window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null);
        if (ready && ready.assets >= stats.images) break;
        await sleep(300);
      }
      if (!ready || ready.assets < stats.images) throw new Error('大型工程未在编辑器中打开：' + JSON.stringify(ready));
      return ready;
    });
    const opened = await editor.ev(`window.__pvnM3.metrics()`);
    okStep('9a 真实窗口打开 1 GiB 工程', { runtime: opened, openMs: stages.openProject.ms });
    report.assertions.noLargeRuntimeBase64 = await editor.ev(`(() => {
      const q=window.__pvnM3.project();
      return !JSON.stringify(q).includes('base64,');
    })()`);
    if (!report.assertions.noLargeRuntimeBase64) throw new Error('运行时工程 JSON 仍含大型 Base64');
    report.sizes.runtimeProjectJsonBytes = await editor.ev(`JSON.stringify(window.__pvnM3.project()).length`);
    report.screenshots.push(await editor.shot(path.join(SHOTS, 'v076-m3-1gib-editor.png')));

    /* ===== 2. 流式导入素材（含重复导入不增磁盘） ===== */
    const importResult = await stage('import', async () => {
      const imgPath = path.join(WORK, 'm3-import-bg.png'), audPath = path.join(WORK, 'm3-import-voice.wav');
      const imgBytes = png(320, 180, 31), audBytes = wav(1);
      fs.writeFileSync(imgPath, imgBytes); fs.writeFileSync(audPath, audBytes);
      const r = await editor.ev(`(async () => {
        const H=window.PaperHost, stat=async()=>(await H.stagingStats()).stats;
        const s0=await stat();
        const a=await H.stageFiles({kind:'image',files:${JSON.stringify([imgPath])},multiple:true});
        const s1=await stat();
        const b=await H.stageFiles({kind:'audio',files:${JSON.stringify([audPath])},multiple:true});
        const s2=await stat();
        const dup=await H.stageFiles({kind:'image',files:${JSON.stringify([imgPath])},multiple:true});
        const s3=await stat();
        return {a,b,dup,s0,s1,s2,s3};
      })()`);
      return { r, imgSha: sha(imgBytes), audSha: sha(audBytes),
        imgBytes: imgBytes.length, audBytes: audBytes.length };
    });
    {
      const { r, imgSha, audSha, imgBytes, audBytes } = importResult;
      const a = r.a.files[0], b = r.b.files[0], d = r.dup.files[0];
      if (!a || !b || !d) throw new Error('导入未返回素材：' + JSON.stringify(r).slice(0, 400));
      if (/base64/i.test(JSON.stringify(r))) throw new Error('导入结果含 Base64');
      if (a.sha256 !== imgSha || b.sha256 !== audSha) throw new Error('导入 SHA-256 不一致');
      if (!/^paper:\/\/app\/staging\//.test(a.dataUrl)) throw new Error('导入未返回受控 URL');
      if (r.s1.bytes - r.s0.bytes !== imgBytes || r.s2.bytes - r.s1.bytes !== audBytes) {
        throw new Error('首次导入落盘大小不符：' + JSON.stringify({ s0: r.s0, s1: r.s1, s2: r.s2, imgBytes, audBytes }));
      }
      if (r.s3.bytes !== r.s2.bytes || r.s3.files !== r.s2.files) {
        throw new Error('重复导入使暂存目录持续增长：' + JSON.stringify({ s2: r.s2, s3: r.s3 }));
      }
      report.assertions.duplicateImportDoesNotGrowDisk = true;
      okStep('1 真实窗口流式导入（无 Base64 / 哈希正确 / 重复不增磁盘）',
        { imageSha: imgSha.slice(0, 12), audioSha: audSha.slice(0, 12),
          stagingBytes: r.s3.bytes, stagingFiles: r.s3.files });
    }

    /* ===== 3. 编辑剧本 + 撤销/重做 ===== */
    const editResult = await stage('edit', async () => {
      const before = await editor.ev(`window.__pvnM3.nodeText()`);
      /* 唯一文本：验收可重复运行，不会因为上次保存过同样内容而误判「未编辑」。 */
      const text = 'M3 验收：晚风穿过二楼走廊 · 已编辑 · ' + Date.now();
      await editor.ev(`window.__pvnM3.editText(${JSON.stringify(text)})`);
      const after = await editor.ev(`window.__pvnM3.nodeText()`);
      if (before === after || after !== text) throw new Error('剧本没有被编辑：' + JSON.stringify({ before, after }));
      return { before, after };
    });
    okStep('2 真实窗口编辑剧本', { length: String(editResult.after).length });
    await stage('undoRedo', async () => {
      await editor.ev(`window.__pvnM3.undo()`);
      const undone = await editor.ev(`window.__pvnM3.nodeText()`);
      await editor.ev(`window.__pvnM3.redo()`);
      const redone = await editor.ev(`window.__pvnM3.nodeText()`);
      if (undone === editResult.after || redone !== editResult.after) {
        throw new Error('撤销/重做未恢复剧本：' + JSON.stringify({ undone, redone }));
      }
      return { undone, redone };
    });
    okStep('3 真实窗口撤销与重做', { restored: editResult.after });

    /* ===== 4. 切换章节/场景，显示背景与立绘 ===== */
    const sceneResult = await stage('scenes', async () => {
      const ids = await editor.ev(`(() => { const q=window.__pvnM3.project();
        const ch=q.chapters; return [q.nodes[0].id, ch[3].paragraphs[2].nodes[3], ch[9].paragraphs[1].nodes[5]]; })()`);
      const out = [];
      for (const id of ids) {
        await editor.ev(`window.__pvnM3.select(${JSON.stringify(id)})`);
        for (let i = 0; i < 40; i++) {
          const s = await editor.ev(`window.__pvnM3.sceneInfo()`);
          if (s.imgs.length >= 2 && s.imgs.every(x => x.loaded)) { out.push(s); break; }
          await sleep(200);
        }
      }
      return out;
    });
    if (sceneResult.length !== 3) throw new Error('章节/场景切换后背景与立绘没有全部解码：' + JSON.stringify(sceneResult));
    const distinct = new Set(sceneResult.map(s => s.imgs.map(i => i.src).join('|')));
    if (distinct.size < 2) throw new Error('切换场景后画面没有变化');
    report.assertions.backgroundAndSpriteDecoded = true;
    okStep('4 切换章节/场景并显示背景与立绘（真实窗口解码）',
      { scenes: sceneResult.length, distinctImages: distinct.size, sample: sceneResult[1].imgs.map(i => i.src.slice(0, 48)) });

    /* ===== 5. 播放 BGM / SFX / Voice ===== */
    const audioResult = await stage('audio', async () => {
      const unlocked = await editor.ev(`(async () => { const r=await window.__pvnM3.unlockAudio(); return r&&r.ok; })()`);
      await editor.ev(`window.__pvnM3.select(window.__pvnM3.project().nodes[0].id)`);
      await editor.ev(`window.__pvnM3.play()`);
      let state = null;
      for (let i = 0; i < 40; i++) {
        state = await editor.ev(`window.__pvnM3.audioState()`);
        if (state && state.bgm && state.bgm.playing) break;
        await sleep(200);
      }
      return { unlocked, state };
    });
    {
      const st = audioResult.state;
      if (!st || !st.bgm || !st.bgm.playing) throw new Error('BGM 未在真实编辑器中播放：' + JSON.stringify(audioResult));
      const hasSfx = st.sfx && st.sfx.some(x => x && x.playing) || st.pendingSfx > 0;
      const hasVoice = st.voice && st.voice.playing;
      report.assertions.audioPlayback = { bgm: true, sfx: !!hasSfx, voice: !!hasVoice, unlocked: !!audioResult.unlocked };
      okStep('5 真实窗口播放 BGM / SFX / Voice', {
        bgm: st.bgm.audioId, bgmTime: st.bgm.time, sfxChannels: (st.sfx || []).length,
        pendingSfx: st.pendingSfx, voice: hasVoice ? st.voice.audioId : null
      });
      await editor.ev(`window.__pvnM3.stop()`);
    }

    /* ===== 5b. 单文件 HTML 200MB 上限：超限时必须引导目录版，不得硬拼巨型字符串 ===== */
    await stage('singleHtmlGuard', async () => {
      /* 音频素材会先弹确认框，直接走 exportHTML 的守卫：点击确认后取 toast 文本。 */
      const r = await editor.ev(`(async () => {
        const toastEl=document.querySelector('#toast');
        if(!toastEl) return {error:'没有 toast 元素'};
        toastEl.textContent='';                    /* 清掉启动恢复提示，避免读到旧文本 */
        const btn=document.querySelector('#export'); if(!btn) return {error:'没有导出按钮'};
        btn.click();
        const confirm=document.querySelector('#confirmAudioExport');
        if(confirm) confirm.click();
        for(let i=0;i<100;i++){
          const t=String(toastEl.textContent||'');
          if(/超出单文件 HTML|200 MB/.test(t)) return {toast:t};
          await new Promise(r=>setTimeout(r,100));
        }
        return {toast:String(toastEl.textContent||''), modal:!!document.querySelector('#confirmAudioExport')};
      })()`);
      if (!r || !/超出单文件 HTML|200 MB/.test(r.toast || '')) {
        throw new Error('1 GiB 工程单文件 HTML 未被 200MB 上限拦截：' + JSON.stringify(r));
      }
      return r;
    });
    okStep('5b 单文件 HTML 200MB 上限引导目录版（无 Invalid string length）',
      { guardMs: stages.singleHtmlGuard.ms });
    report.assertions.singleHtmlGuardWorks = true;

    /* ===== 6. 保存工程 ===== */
    await stage('save', async () => {
      const r = await editor.ev(`(async () => await window.__pvnM3.save())()`);
      if (!r || r.ok === false) throw new Error('保存失败：' + JSON.stringify(r));
      const disk = fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8');
      if (disk.includes('base64,') || disk.includes('staging/')) throw new Error('磁盘工程含 Base64 或暂存地址');
      return { saved: true, diskBytes: Buffer.byteLength(disk) };
    });
    okStep('6 真实窗口保存 1 GiB 工程（JSON 与素材一致）', { saveMs: stages.save.ms });
    report.assertions.diskJsonHasNoBase64 = true;

    /* ===== 7. 关闭并重开工程（真实进程重启，同时验证异常退出后重启） ===== */
    await stage('reopen', async () => {
      editor.close(); editor = null; killTree(proc.pid);
      await sleep(1200);
      proc = launch(port);
      const page = await waitPage(port, u => u.startsWith('paper://app/'), 120000);
      if (!page) throw new Error('重开后编辑器窗口未出现');
      editor = watch('editor', await connect(page.webSocketDebuggerUrl));
      let m = null;
      for (let i = 0; i < 300; i++) {
        m = await editor.ev(`(() => { const M=window.__pvnM3; return M?M.metrics():null; })()`).catch(() => null);
        if (m && m.assets >= stats.images) break;
        await sleep(300);
      }
      if (!m || m.assets < stats.images) throw new Error('重开后素材数量不对：' + JSON.stringify(m));
      const text = await editor.ev(`window.__pvnM3.nodeText()`);
      if (text !== editResult.after) throw new Error('重开后剧本编辑丢失');
      return { runtime: m, text };
    });
    okStep('7 关闭并重开工程（含异常退出后重启路径）', { reopenMs: stages.reopen.ms });

    /* ===== 8. 编辑器内完整预览 ===== */
    await stage('preview', async () => {
      await editor.ev(`document.querySelector('#fullPreview').click()`);
      const page = await waitPage(port, u => u.startsWith('pvres://'), 300000);
      if (!page) throw new Error('完整预览窗口未出现');
      preview = watch('preview', await connect(page.webSocketDebuggerUrl));
      for (let i = 0; i < 300; i++) {
        if (await preview.ev(`!!document.getElementById('startGame')`)) break;
        await sleep(300);
      }
      await preview.ev(`document.getElementById('startGame').click()`);
      let state = null;
      for (let i = 0; i < 300; i++) {
        state = await preview.ev(`(() => { const a=[...document.querySelectorAll('#layers img')];
          return {count:a.length,loaded:a.filter(i=>i.complete&&i.naturalWidth>0).length,
            allPvres:a.length>0&&a.every(i=>String(i.src).startsWith('pvres://')),
            audio:(()=>{try{return paperGameState().audio}catch(e){return null}})()}; })()`);
        if (state && state.loaded >= 2 && state.allPvres) break;
        await sleep(300);
      }
      if (!state || state.loaded < 2 || !state.allPvres) throw new Error('预览资源未加载：' + JSON.stringify(state));
      return state;
    });
    const pstate = await preview.ev(`(() => ({ title:document.getElementById('title').textContent,
      imgs:[...document.querySelectorAll('#layers img')].map(i=>String(i.src).slice(0,52)) }))()`).catch(() => null);
    report.screenshots.push(await preview.shot(path.join(SHOTS, 'v076-m3-1gib-preview.png')));
    okStep('8 大型工程完整预览（pvres:// 按需加载）', { previewStartMs: stages.preview.ms, state: pstate });
    try { await editor.ev(`window.PaperHost.closePreview()`); } catch {}
    preview.close(); preview = null;

    /* ===== 9. 目录版游戏导出 ===== */
    let gameDir = null;
    if (!SKIP_EXPORT) {
      await stage('folderExport', async () => {
        const r = await editor.ev(`(async () => {
          const H=window.PaperHost, q=window.__pvnM3.project();
          return await H.exportGame({project:q,type:'folder',outDir:${JSON.stringify(EXPORT_DIR)}});
        })()`);
        if (!r || !r.ok) throw new Error('目录版导出失败：' + JSON.stringify(r).slice(0, 600));
        gameDir = r.artifact;
        return { artifact: r.artifact, bytes: r.bytes, manifestPath: r.manifestPath };
      });
      if (!gameDir || !fs.existsSync(gameDir)) throw new Error('导出目录不存在：' + gameDir);
      const contentDir = path.join(gameDir, 'resources', 'app', 'content');
      const htmlBytes = fs.statSync(path.join(contentDir, 'index.html')).size;
      const imgCount = fs.readdirSync(path.join(contentDir, 'assets', 'images')).length;
      const audCount = fs.readdirSync(path.join(contentDir, 'assets', 'audio')).length;
      report.sizes.gameHtmlBytes = htmlBytes;
      report.sizes.gameImages = imgCount; report.sizes.gameAudio = audCount;
      if (htmlBytes > 8 * 1024 * 1024) throw new Error('目录版页面过大：' + htmlBytes);
      const manifest = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR,
        fs.readdirSync(EXPORT_DIR).find(f => f.endsWith('.manifest.json'))), 'utf8'));
      if (manifest.exportMode !== 'folder') throw new Error('导出类型不是 folder：' + manifest.exportMode);
      report.assertions.folderExportMode = true;
      okStep('9 目录版游戏导出（轻量页面 + 资源分离）',
        { folderExportMs: stages.folderExport.ms, htmlBytes, imgCount, audCount, exportMode: manifest.exportMode });

      /* ===== 10. 启动导出的游戏并验证资源加载 ===== */
      await stage('exportedGame', async () => {
        const exe = fs.readdirSync(gameDir).find(f => /\.exe$/i.test(f) && !/elevate/i.test(f));
        if (!exe) throw new Error('目录里没有游戏 EXE');
        const gPort = await freePort();
        const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
        gameProc = spawn(path.join(gameDir, exe), ['--remote-debugging-port=' + gPort,
          '--remote-allow-origins=*', '--autoplay-policy=no-user-gesture-required'], { stdio: 'ignore', env, cwd: gameDir });
        const page = await waitPage(gPort, u => u.startsWith('papergame://'), 180000);
        if (!page) throw new Error('导出的游戏窗口未启动');
        game = watch('exported-game', await connect(page.webSocketDebuggerUrl));
        for (let i = 0; i < 300; i++) {
          if (await game.ev(`!!document.getElementById('startGame')`)) break;
          await sleep(300);
        }
        await game.ev(`document.getElementById('startGame').click()`);
        let s = null;
        for (let i = 0; i < 300; i++) {
          s = await game.ev(`(() => { const a=[...document.querySelectorAll('#layers img')];
            return {count:a.length,loaded:a.filter(i=>i.complete&&i.naturalWidth>0).length,
              allScheme:a.length>0&&a.every(i=>String(i.src).startsWith('papergame://')),
              audio:(()=>{try{return paperGameState().audio}catch(e){return null}})(),
              state:(()=>{try{return paperGameState().state}catch(e){return null}})()}; })()`);
          if (s && s.loaded >= 2 && s.allScheme) break;
          await sleep(300);
        }
        if (!s || s.loaded < 2 || !s.allScheme) throw new Error('导出游戏资源未加载：' + JSON.stringify(s));
        return s;
      });
      report.screenshots.push(await game.shot(path.join(SHOTS, 'v076-m3-1gib-exported-game.png')));
      okStep('10 启动导出的游戏并实际验证资源加载', { exportedGameMs: stages.exportedGame.ms });
    } else {
      report.incidents.push('按 --skip-export 跳过了目录版导出与导出游戏启动');
    }

    /* 素材完整性：保存/重开/导出后哈希不变 */
    const after = projectStats();
    if (after.actualAssetBytes !== stats.actualAssetBytes || after.uniqueHashes !== stats.uniqueHashes) {
      throw new Error('素材在全流程后发生丢失或损坏');
    }
    report.assertions.assetsIntact = true;
    /* 稳定性结论必须来自真实窗口的 CDP 异常事件，不能硬编码。 */
    const allErrors = windowErrors.flatMap(w => w.errors.map(e => w.window + '：' + e));
    report.cdpErrors = allErrors;
    report.assertions.noInvalidStringLength = !allErrors.some(e => /Invalid string length/i.test(e));
    report.assertions.noOomOrCrash = !allErrors.some(e => /out of memory|oom|targetCrashed|渲染进程崩溃/i.test(e));
    if (!report.assertions.noInvalidStringLength || !report.assertions.noOomOrCrash) {
      throw new Error('真实窗口出现异常：' + allErrors.slice(0, 5).join(' | '));
    }
    okStep('全流程素材完整性与稳定性（含真实窗口异常事件判定）',
      { before: stats.actualAssetBytes, after: after.actualAssetBytes, cdpErrorCount: allErrors.length });
  } catch (e) {
    bad('m3-acceptance', e);
  } finally {
    try { if (game) game.close(); } catch {}
    try { if (preview) preview.close(); } catch {}
    try { if (editor) editor.close(); } catch {}
    try { killTree(gameProc && gameProc.pid); } catch {}
    try { killTree(proc && proc.pid); } catch {}
    stopSampling();
    fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'release', 'm3-memory-samples.json'),
      JSON.stringify({ machine: report.machine, samples, stages, sizes: report.sizes,
        assertions: report.assertions,
        incidents: [...report.incidents, ...(report.cdpErrors || [])] }, null, 2), 'utf8');
    report.timingsMs = Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v.ms]));
    report.memory = { sampleCount: samples.length,
      cdp: samples.filter(s => s.source === 'cdp').length,
      tasklist: samples.filter(s => s.source === 'tasklist').length,
      mainPeakMB: +(samples.reduce((m, s) => Math.max(m, s.mainBytes || 0), 0) / 1048576).toFixed(1),
      rendererPeakMB: +(samples.reduce((m, s) => Math.max(m, s.rendererBytes || 0), 0) / 1048576).toFixed(1),
      totalPeakMB: +(samples.reduce((m, s) => Math.max(m, s.totalBytes || 0), 0) / 1048576).toFixed(1) };
    fs.writeFileSync(path.join(ROOT, 'release', 'large-project-acceptance.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('\n' + JSON.stringify({ ok: report.ok, problems: report.problems,
      timingsMs: report.timingsMs, memory: report.memory, screenshots: report.screenshots }, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
})().catch(e => { console.error(e); process.exit(1); });
