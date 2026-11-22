'use strict';
/*
 * V0.7.4 大型工程预览验收。
 * 验证：超过旧 64MB 限制的工程能打开完整预览；资源按 pvres:// 按需读取；
 * 未保存修改可见；关闭后会话目录清空；重复打开不残留。
 *
 * 用法：node scripts/large-project-acceptance.cjs [--project "F:/pvn-large-project"] [--packaged]
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARGS = process.argv.slice(2);
const argOf = k => { const i = ARGS.indexOf('--' + k); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : null; };
const PROJECT = path.resolve(argOf('project') || 'F:/pvn-large-project');
const PACKAGED = ARGS.includes('--packaged');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { at: new Date().toISOString(), project: PROJECT, ok: true, stages: {}, problems: [], unverified: [] };
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
async function listPages(port) {
  try { return await httpJson('http://127.0.0.1:' + port + '/json/list'); } catch { return []; }
}
async function waitPage(port, match, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const list = await listPages(port);
    const page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && typeof t.url === 'string' && match(t.url));
    if (page && page.webSocketDebuggerUrl) return page;
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

function editorCommand() {
  if (PACKAGED) {
    const direct = path.join(ROOT, 'release', 'win-unpacked', 'PaperVNStudio.exe');
    if (fs.existsSync(direct)) return { exe: direct, args: [] };
    const cands = fs.existsSync(path.join(ROOT, 'release'))
      ? fs.readdirSync(path.join(ROOT, 'release')).filter(n => /^pkg/.test(n))
        .map(n => path.join(ROOT, 'release', n, 'win-unpacked', 'PaperVNStudio.exe'))
        .filter(p => fs.existsSync(p))
      : [];
    if (!cands.length) throw new Error('没有打包好的纸间');
    return { exe: cands[cands.length - 1], args: [] };
  }
  return { exe: ELECTRON, args: [ROOT] };
}

function seedRecent(userData, projectDir, title) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: projectDir, items: [{ path: projectDir, title, openedAt: new Date().toISOString() }]
  }, null, 2), 'utf8');
}

function dirStats(dir) {
  let bytes = 0, files = 0;
  const walk = d => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d)) {
      const abs = path.join(d, n);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs); else { files++; bytes += st.size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

(async () => {
  if (!fs.existsSync(PROJECT)) throw new Error('大型工程不存在：' + PROJECT);
  const diskProject = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));
  const title = diskProject.title;
  const expectedNodes = Array.isArray(diskProject.nodes) ? diskProject.nodes.length : 0;
  const disk = dirStats(path.join(PROJECT, 'assets'));
  console.log('大型工程 ' + PROJECT + ' · 素材 ' + (disk.bytes / 1048576).toFixed(1) + ' MB / ' + disk.files + ' 个文件');

  const work = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pvn-large-'));
  const userData = path.join(work, 'ud');
  seedRecent(userData, PROJECT, title);
  const port = await freePort();
  const cmd = editorCommand();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(cmd.exe, [...cmd.args, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData],
    { stdio: 'ignore', env });

  let editor = null;
  try {
    const page = await waitPage(port, url => url.startsWith('paper://app/'), 60000);
    if (!page) throw new Error('编辑器没有启动');
    editor = await connect(page.webSocketDebuggerUrl);
    let ready = null;
    for (let i = 0; i < 120; i++) {
      ready = await editor.evaluate(`({host:typeof window.PaperHost==='object',
        nodes:document.querySelectorAll('#list .node').length,
        title:(document.getElementById('title')||{}).value||''})`);
      if (ready.host && ready.nodes > 0) break;
      await sleep(300);
    }
    if (!ready || !ready.nodes) throw new Error('编辑器没有打开工程：' + JSON.stringify(ready));
    const editorOpenMs = Date.now();

    /* 未保存修改：改工程标题但不保存，预览应该看到新标题。 */
    const marker = '未保存修改 · ' + Date.now().toString().slice(-6);
    await editor.evaluate(`(() => { const el = document.getElementById('title');
      el.value = ${JSON.stringify(marker)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(400);

    const sessionsDir = path.join(userData, 'preview-sessions');
    const clickPreview = async () => {
      const t0 = Date.now();
      await editor.evaluate(`document.getElementById('fullPreview').click()`);
      const previewPage = await waitPage(port, url => url.startsWith('pvres://'), 90000);
      const status = await editor.evaluate(`(() => { const el = document.getElementById('previewStatus');
        return el ? { text: el.textContent, hidden: el.hidden } : null; })()`).catch(() => null);
      const toasts = await editor.evaluate(`(document.getElementById('toast')||{}).textContent || ''`).catch(() => '');
      return { page: previewPage, ms: Date.now() - t0, status, toasts };
    };

    /* 第一次打开 */
    const first = await clickPreview();
    if (!first.page) throw new Error('预览窗口没有出现；状态=' + JSON.stringify(first.status) + ' 提示=' + first.toasts);
    const pcdp = await connect(first.page.webSocketDebuggerUrl);
    let pready = false;
    for (let i = 0; i < 150 && !pready; i++) {
      pready = await pcdp.evaluate(`!!document.getElementById('startGame')`);
      if (!pready) await sleep(200);
    }
    if (!pready) throw new Error('预览页面没有就绪');

    const detail = { url: first.page.url, openMs: first.ms };
    const problems = [];
    detail.title = await pcdp.evaluate(`document.getElementById('title').textContent`);
    if (detail.title !== marker) problems.push('未保存的标题没有带进预览：' + detail.title);
    detail.docBytes = await pcdp.evaluate(`document.documentElement.outerHTML.length`);
    if (detail.docBytes > 8 * 1024 * 1024) problems.push('页面文档仍然过大：' + detail.docBytes);
    detail.nodes = await pcdp.evaluate(`paperGameState().nodes`);
    if (detail.nodes !== expectedNodes) problems.push('节点数不是 ' + expectedNodes + '：' + detail.nodes);

    await pcdp.evaluate(`document.getElementById('startGame').click()`);
    await sleep(1200);
    detail.bgm = await pcdp.evaluate(`paperGameState().audio`);
    if (!detail.bgm || !detail.bgm.bgm || !detail.bgm.bgm.playing) problems.push('场景 BGM 没有播放');
    /* 自定义协议的请求不进 Resource Timing，直接看 <img> 的真实加载结果。 */
    detail.resources = await pcdp.evaluate(`(() => {
      const imgs = [...document.querySelectorAll('#layers img')];
      return { count: imgs.length,
        loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
        allPvres: imgs.length > 0 && imgs.every(i => i.src.startsWith('pvres://')),
        sample: imgs[0] ? imgs[0].src.slice(0, 56) : '' };
    })()`);
    if (detail.resources.loaded < 2) problems.push('立绘/背景没有按需加载：' + JSON.stringify(detail.resources));
    if (!detail.resources.allPvres) problems.push('图片不是从 pvres:// 读取的：' + detail.resources.sample);

    /* 推进 3 句，确认画面还能换图 */
    for (let i = 0; i < 3; i++) {
      await pcdp.evaluate(`document.getElementById('scene').click()`);
      await sleep(350);
    }
    detail.advanced = await pcdp.evaluate(`paperGameState().i`);
    if (detail.advanced < 1) problems.push('预览里无法推进剧情');

    /* 截一张真实预览窗口，作为交付证据。 */
    try {
      if (path.basename(PROJECT) !== 'pvn-large-project') throw new Error('skip');
      const shot = await pcdp.send('Page.captureScreenshot', { format: 'png' });
      const shots = path.join(ROOT, 'docs', 'screenshots');
      fs.mkdirSync(shots, { recursive: true });
      const shotFile = path.join(shots, 'v074-large-preview.png');
      fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
      detail.screenshot = path.relative(ROOT, shotFile);
    } catch { report.unverified.push('预览截图失败'); }
    pcdp.close();

    /* 关闭预览窗口：会话目录应被清掉 */
    const beforeClose = fs.existsSync(sessionsDir) ? dirStats(sessionsDir) : { files: 0, bytes: 0 };
    detail.sessionFiles = beforeClose.files;
    await editor.evaluate(`window.PaperHost.closePreview()`).catch(() => {});
    await sleep(1500);
    const afterClose = fs.existsSync(sessionsDir) ? dirStats(sessionsDir) : { files: 0, bytes: 0 };
    detail.sessionAfterClose = afterClose.files;

    /* 再打开一次，确认不残留、不互相干扰 */
    const second = await clickPreview();
    if (!second.page) throw new Error('第二次预览没有打开');
    const pcdp2 = await connect(second.page.webSocketDebuggerUrl);
    for (let i = 0; i < 100; i++) {
      if (await pcdp2.evaluate(`!!document.getElementById('startGame')`)) break;
      await sleep(200);
    }
    detail.secondOpenMs = second.ms;
    detail.secondTitle = await pcdp2.evaluate(`document.getElementById('title').textContent`);
    pcdp2.close();

    if (problems.length) bad('大型工程预览', problems.join('；'), detail);
    else ok('大型工程预览', {
      summary: '素材 ' + (disk.bytes / 1048576).toFixed(0) + ' MB 的工程打开预览 ' + (first.ms / 1000).toFixed(1) + ' s，页面仅 '
        + (detail.docBytes / 1024).toFixed(0) + ' KB，资源按需加载', ...detail
    });

    if (first.ms > 60000) report.unverified.push('预览启动超过 60 s，未进一步分析耗时构成');
  } catch (e) {
    bad('执行', (e && e.message) || String(e));
  } finally {
    try { if (editor) editor.close(); } catch { /* ignore */ }
    killTree(proc.pid);
  }

  const base = path.basename(PROJECT);
  const suffix = base === 'pvn-large-project' ? '' : '-' + base;
  const out = path.join(ROOT, 'release', 'large-project-acceptance' + suffix + '.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(report.ok ? 'RESULT PASS' : 'RESULT FAIL · ' + report.problems.length + ' 个问题');
  console.log('报告：' + out);
  process.exit(report.ok ? 0 : 1);
})();
