'use strict';
/* V0.7.3 音乐实装验收：标题音乐、场景 BGM、继承与释放。
 * 用法：node scripts/music-acceptance.cjs [--portable]
 * 报告：release/music-acceptance.json */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WANT_PORTABLE = process.argv.includes('--portable');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const report = { at: new Date().toISOString(), ok: true, stages: {}, problems: [], unverified: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d }; console.log('  ok  ' + n + (d && d.summary ? ' — ' + d.summary : '')); };
const bad = (n, m, d) => { report.ok = false; report.problems.push(n + '：' + m); report.stages[n] = { ok: false, message: m, detail: d }; console.log('  FAIL ' + n + ' — ' + m); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function killTree(pid) { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
async function httpJson(url, ms = 1500) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
async function waitPage(port, match, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await httpJson('http://127.0.0.1:' + port + '/json/list');
      const page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && typeof t.url === 'string' && match(t.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* not yet */ }
    await sleep(250);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP 连接超时')), 12000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); };
  });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const slot = pending.get(m.id); if (!slot) return;
    pending.delete(m.id);
    if (m.error) slot.reject(new Error(m.error.message)); else slot.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result && r.result.value;
  };
  return { send, evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}
async function click(cdp, sel) {
  const r = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error('找不到可点击元素：' + sel);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
}

/* 页面里所有 <audio>：标题音乐是独立元素，剧情音频走 Audio 对象，不在 DOM 里。 */
const titleAudioState = cdp => cdp.evaluate(`(() => {
  const el = document.querySelector('audio');
  if (!el) return null;
  return { src: el.src.slice(0, 24), paused: el.paused, loop: el.loop,
    currentTime: Number(el.currentTime.toFixed(2)), volume: el.volume,
    readyState: el.readyState, error: el.error ? el.error.code : null };
})()`);

async function runHtml(dir) {
  const store = require(path.join(ROOT, 'desktop/project-store.cjs'))();
  const sampleDir = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
  const project = store.openProject(sampleDir).project;
  const { buildPlayerHTML } = require(path.join(ROOT, 'dist', 'game-html.js'));
  const reportData = {};
  const html = buildPlayerHTML(project, undefined, reportData);
  const file = path.join(dir, 'music.html');
  fs.writeFileSync(file, html, 'utf8');
  report.audio = reportData.audio;

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON, [path.join(ROOT, 'scripts', 'html-probe-loader.cjs'), file,
    '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + path.join(dir, 'ud')],
    { stdio: 'ignore', env });
  let cdp = null;
  try {
    const page = await waitPage(port, url => url.includes('music.html'));
    if (!page) throw new Error('页面没有加载');
    cdp = await connect(page.webSocketDebuggerUrl);
    /* 断网再跑一遍：素材全部内嵌，离线也必须能起播。 */
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    try { await cdp.evaluate('location.reload()'); } catch { /* reload 会中断执行上下文 */ }
    await sleep(1500);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await cdp.evaluate(`!!(document.getElementById('startGame') && document.querySelector('audio'))`);
      if (!ready) await sleep(200);
    }
    if (!ready) throw new Error('标题页没有音乐元素');

    /* 1. 标题音乐：OGG data URI、循环、独立通道 */
    const t0 = await titleAudioState(cdp);
    const problems = [];
    if (!t0.src.startsWith('data:audio/ogg')) problems.push('标题音乐不是内嵌 OGG：' + t0.src);
    if (!t0.loop) problems.push('标题音乐没有循环');
    if (t0.error) problems.push('标题音乐解码失败，错误码 ' + t0.error);

    /* 自动播放可能被策略拦：像玩家一样点一下再等。 */
    if (t0.paused) await click(cdp, '#titleScreen');
    await sleep(900);
    const t1 = await titleAudioState(cdp);
    const titlePlaying = !t1.paused && t1.currentTime > 0.1;
    if (!titlePlaying) problems.push('标题音乐没有开始播放（paused=' + t1.paused + ' t=' + t1.currentTime + '）');

    /* 2. 进入游戏：标题音乐暂停，场景 BGM 起播（不叠加） */
    await click(cdp, '#startGame');
    await sleep(1200);
    const t2 = await titleAudioState(cdp);
    const s2 = await cdp.evaluate(`paperGameState().audio`);
    if (!t2.paused) problems.push('进入游戏后标题音乐仍在播（与场景 BGM 叠加）');
    const bgm2 = s2 && s2.bgm;
    if (!bgm2 || !bgm2.playing) problems.push('场景 BGM 没有播放：' + JSON.stringify(bgm2));
    else if (!String(bgm2.audioId).includes('ost_02_morning')) problems.push('早餐段落的 BGM 不是 ost_02：' + bgm2.audioId);

    /* 3. 推进一句：BGM 保持同一首，不重启（沿用而非重播） */
    await click(cdp, '#scene');
    await click(cdp, '#scene');
    await sleep(800);
    const s3 = await cdp.evaluate(`paperGameState().audio`);
    const bgm3 = s3 && s3.bgm;
    if (!bgm3 || bgm3.audioId !== bgm2.audioId) problems.push('推进后台词换了 BGM，说明逐句重设了：' + JSON.stringify(bgm3));

    /* 4. 返回标题：标题音乐从暂停点继续，不重头 */
    await cdp.evaluate(`document.getElementById('menuBtn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.getElementById('menuTitle').click()`);
    await sleep(1200);
    const t4 = await titleAudioState(cdp);
    if (t4.paused) problems.push('返回标题后标题音乐没有继续');
    if (t4.currentTime < t1.currentTime) problems.push('标题音乐重头播放了：' + t4.currentTime + ' < ' + t1.currentTime);

    /* 5. 播放中关闭页面：释放音源（pagehide 清理） */
    const beforeExit = await cdp.evaluate(`!!document.querySelector('audio').src`);
    await cdp.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide'))`);
    await sleep(300);
    /* 释放后元素可能被直接移除：拿不到元素也算释放成功。 */
    const afterExit = await cdp.evaluate(`(() => { const el = document.querySelector('audio');
      return el ? { hasSrc: !!el.src, paused: el.paused } : { hasSrc: false, paused: true, removed: true }; })()`);
    if (!beforeExit) problems.push('关闭前标题音乐没有音源，无法验证释放');
    if (afterExit.hasSrc) problems.push('pagehide 后音源没有释放');
    if (!afterExit.paused) problems.push('pagehide 后播放没有停止');

    const detail = { title: t1, afterStart: t2, bgm: bgm2, bgmAfterAdvance: bgm3, afterReturn: t4, afterExit };
    if (problems.length) bad('HTML 音乐实装', problems.join('；'), detail);
    else ok('HTML 音乐实装', {
      summary: '断网下：标题曲循环 / 进入游戏暂停 / 早餐 BGM 起播 / 推进不重启 / 返回标题续播 / 退出释放',
      ...detail
    });

    /* 6. 未引用的三首不在页面里 */
    const included = (report.audio && report.audio.included) || [];
    const excluded = (report.audio && report.audio.excluded) || [];
    const embeddedOthers = excluded.filter(a => html.includes('"id":"' + a.id + '"'));
    if (included.length !== 3 || excluded.length !== 3) bad('导出过滤', '应为 3 进 3 出，实际 ' + included.length + '/' + excluded.length);
    else if (embeddedOthers.length) bad('导出过滤', '未引用曲目进了包：' + embeddedOthers.map(a => a.id).join(', '));
    else ok('导出过滤', { summary: '包内 ' + included.length + ' 首，排除 ' + excluded.length + ' 首' });
  } finally {
    if (cdp) cdp.close();
    killTree(proc.pid);
    await sleep(400);
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-music-'));
  console.log('音乐实装验收');
  try { await runHtml(dir); } catch (e) { bad('执行', (e && e.message) || String(e)); }
  const out = path.join(ROOT, 'release', 'music-acceptance.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(report.ok ? 'RESULT PASS' : 'RESULT FAIL · ' + report.problems.length + ' 个问题');
  console.log('报告：' + out);
  process.exit(report.ok ? 0 : 1);
})();
