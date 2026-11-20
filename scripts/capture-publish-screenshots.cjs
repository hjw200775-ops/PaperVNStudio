'use strict';
/*
 * 生成「游戏发行」界面截图（用于交付说明）。会真实导出一次工程 B，所以进度与结果都是真的。
 *
 *   node scripts/capture-publish-screenshots.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const fixtures = require('./game-export-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitPage(port, match, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const p = list.find(t => t.type === 'page' && t.url && match(t.url));
      if (p) return p;
    } catch { /* 等 */ }
    await sleep(200);
  }
  return null;
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  let id = 0; const pend = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data); const s = pend.get(m.id);
    if (!s) return; pend.delete(m.id);
    m.error ? s.rej(new Error(m.error.message)) : s.res(m.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async file => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  shot', path.basename(file));
  };
  await send('Page.enable').catch(() => {});
  return { evaluate, shot, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-shots-'));
  const store = require(path.join(ROOT, 'desktop', 'project-store.cjs'))();
  const Bfix = fixtures.buildProjectB(work, { stamp: 'shots' });
  const created = store.createProject(Bfix.dir, Bfix.project);
  const outDir = path.join(work, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const ud = path.join(work, 'ud');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'recent-projects.json'), JSON.stringify({
    format: 'paper-recent', formatVersion: 1, savedAt: new Date().toISOString(),
    lastOpened: created.root, items: [{ path: created.root, title: Bfix.title, openedAt: new Date().toISOString() }]
  }));

  const port = await freePort();
  const env = Object.assign({}, process.env, { PAPER_VN_TEST_EXPORT_DIR: outDir });
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + ud],
    { cwd: ROOT, env, stdio: 'ignore' });
  const page = await waitPage(port, u => u.startsWith('paper://app/'));
  const cdp = await connect(page.webSocketDebuggerUrl);
  for (let i = 0; i < 80; i++) {
    if (await cdp.evaluate(`document.querySelectorAll('#list .node').length`) > 0) break;
    await sleep(250);
  }
  await cdp.evaluate(`document.getElementById('publish').click()`);
  await sleep(900);
  await cdp.shot(path.join(OUT, 'v072-publish-settings.png'));

  const scrollBottom = `(()=>{const b=document.querySelector('#publishDialog .publish-body');b.scrollTop=b.scrollHeight;})()`;
  await cdp.evaluate(scrollBottom);
  await sleep(400);
  await cdp.shot(path.join(OUT, 'v072-export-panel.png'));

  await cdp.evaluate(`document.getElementById('pubStart').click()`);
  await sleep(1500);
  await cdp.evaluate(scrollBottom);
  await sleep(300);
  await cdp.shot(path.join(OUT, 'v072-export-progress.png'));

  for (let i = 0; i < 120; i++) {
    const t = await cdp.evaluate(`document.getElementById('pubProgressText').textContent`);
    if (/导出完成|导出失败|已取消/.test(t)) break;
    await sleep(500);
  }
  await cdp.evaluate(scrollBottom);
  await sleep(500);
  await cdp.shot(path.join(OUT, 'v072-export-result.png'));

  /* 图标导入后的预览：换成自定义图标再看一眼 */
  await cdp.evaluate(`(()=>{const el=document.getElementById('pubIconPick');if(el)el.click()})()`);
  await sleep(200);
  cdp.close();
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  console.log('SCREENSHOTS OK ' + OUT);
  process.exit(0);
})().catch(e => { console.error('SHOTS FAIL ' + (e.stack || e.message)); process.exit(1); });
