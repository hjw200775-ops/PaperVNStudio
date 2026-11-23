'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-probe-'));
const USER_DATA = path.join(WORK, 'ud');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function j(u) { try { return await (await fetch(u)).json(); } catch { return null; } }
(async () => {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + USER_DATA], { cwd: ROOT, stdio: 'ignore', env });
  try {
    let page = null;
    for (let i = 0; i < 120 && !page; i++) {
      const list = await j('http://127.0.0.1:' + port + '/json/list');
      page = (Array.isArray(list) ? list : []).find((x) => x.type === 'page' && (x.url || '').startsWith('paper://app/'));
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('no page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pend = new Map();
    const errs=[];
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;errs.push((d.exception&&d.exception.description)||d.text)}
      if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error'){errs.push('console: '+m.params.args.map(a=>a.value||a.description).join(' '))}
      const s = pend.get(m.id); if (!s) return; pend.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pend.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description) : r.result.value; };
    await sleep(1500);
    console.log('typeof perf:', await ev('typeof createPaperPerformance'));
    console.log('typeof PF:', await ev('typeof PF'));
    console.log('host:', await ev('typeof window.PaperHost'));
    console.log('pvnM3:', await ev('typeof window.__pvnM3'));
    console.log('fetch perf:', await ev(`fetch('paper://app/performance.js').then(r=>r.status+' '+r.headers.get('content-type')).catch(e=>'ERR '+e)`));
    console.log('ERRORS:', JSON.stringify(errs,null,1).slice(0,1500));
    console.log('scripts:', await ev(`[...document.scripts].map(s=>s.src.split('/').pop())`));
    ws.close();
  } finally { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
})();
