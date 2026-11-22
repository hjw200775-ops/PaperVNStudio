'use strict';
/* 独立游戏目录版冒烟：启动产物里的 EXE，确认播放器、资源协议、BGM 与推进都正常。
 * 用法：node scripts/game-folder-smoke.cjs "<游戏目录>" */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const DIR = path.resolve(process.argv[2] || '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitPage(port, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && String(t.url).startsWith('papergame://'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* not ready */ }
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

(async () => {
  if (!DIR || !fs.existsSync(DIR)) throw new Error('游戏目录不存在：' + DIR);
  const exe = fs.readdirSync(DIR).find(f => /\.exe$/i.test(f) && !/elevate/i.test(f));
  if (!exe) throw new Error('目录里没有 EXE');

  const contentDir = path.join(DIR, 'resources', 'app', 'content');
  const htmlBytes = fs.statSync(path.join(contentDir, 'index.html')).size;
  const assetsDir = path.join(contentDir, 'assets');
  const count = d => fs.existsSync(d) ? fs.readdirSync(d).length : 0;
  const images = count(path.join(assetsDir, 'images'));
  const audios = count(path.join(assetsDir, 'audio'));

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(path.join(DIR, exe), ['--remote-debugging-port=' + port, '--remote-allow-origins=*'],
    { stdio: 'ignore', env, cwd: DIR });
  const out = { dir: DIR, exe, htmlBytes, images, audios, ok: true, problems: [] };
  try {
    const t0 = Date.now();
    const page = await waitPage(port);
    if (!page) throw new Error('游戏窗口没有启动（可能被杀毒软件拦下）');
    out.startMs = Date.now() - t0;
    const cdp = await connect(page.webSocketDebuggerUrl);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await cdp.evaluate(`!!document.getElementById('startGame')`);
      if (!ready) await sleep(200);
    }
    if (!ready) throw new Error('页面没有就绪');
    out.title = await cdp.evaluate(`document.getElementById('title').textContent`);
    /* 标题背景走资源协议，最容易在资源分离后被漏掉。 */
    out.titleBg = await cdp.evaluate(`(() => {
      const box = document.getElementById('titleBg');
      const img = document.getElementById('titleBgImg');
      return { visible: !!(box && !box.hidden), src: img ? img.src.slice(0, 40) : '',
        loaded: !!(img && img.complete && img.naturalWidth > 0) };
    })()`);
    /* 标题背景走资源协议，最容易在资源分离后被漏掉。 */
    out.titleBg = await cdp.evaluate(`(() => {
      const box = document.getElementById('titleBg');
      const img = document.getElementById('titleBgImg');
      return { visible: !!(box && !box.hidden), src: img ? img.src.slice(0, 40) : '',
        loaded: !!(img && img.complete && img.naturalWidth > 0) };
    })()`);
    out.origin = await cdp.evaluate(`location.origin`);

    await cdp.evaluate(`document.getElementById('startGame').click()`);
    await sleep(1500);
    out.imagesInScene = await cdp.evaluate(`(() => {
      const imgs = [...document.querySelectorAll('#layers img')];
      return { count: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
        allGameScheme: imgs.length > 0 && imgs.every(i => i.src.startsWith('papergame://')) };
    })()`);
    out.audio = await cdp.evaluate(`paperGameState().audio`);
    out.i0 = await cdp.evaluate(`paperGameState().i`);
    await cdp.evaluate(`document.getElementById('scene').click()`);
    await sleep(600);
    out.i1 = await cdp.evaluate(`paperGameState().i`);

    /* 返回标题：标题音乐继续，页面不崩 */
    await cdp.evaluate(`document.getElementById('menuBtn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.getElementById('menuTitle').click()`);
    await sleep(900);
    out.backToTitle = await cdp.evaluate(`paperGameState().state`);

    if (out.titleBg.visible && !out.titleBg.loaded) out.problems.push('标题背景没有加载：' + out.titleBg.src);
    if (out.titleBg.src && !out.titleBg.src.startsWith('papergame://')) out.problems.push('标题背景不是从 papergame:// 读取');
    if (out.titleBg.visible && !out.titleBg.loaded) out.problems.push('标题背景没有加载：' + out.titleBg.src);
    if (out.titleBg.src && !out.titleBg.src.startsWith('papergame://')) out.problems.push('标题背景不是从 papergame:// 读取');
    if (!out.imagesInScene.loaded) out.problems.push('场景图片没有加载');
    if (!out.imagesInScene.allGameScheme) out.problems.push('图片不是从 papergame:// 读取');
    if (!out.audio || !out.audio.bgm || !out.audio.bgm.playing) out.problems.push('BGM 没有播放');
    if (out.i1 <= out.i0) out.problems.push('无法推进剧情');
    if (out.backToTitle !== 'title') out.problems.push('返回标题失败：' + out.backToTitle);
    out.ok = out.problems.length === 0;
    cdp.close();
  } finally {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.ok ? 0 : 1);
})();
