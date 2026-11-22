'use strict';
/*
 * V0.7.6-M3 Alpha 真实作品兼容性验收。
 *
 * 三个《晚风》Alpha 工程位于 C: 工作区 wanfeng_alpha/projects/。本脚本
 * 只操作隔离副本（复制工程目录 + 素材），原始作品永远不会被打开写入，更不会覆盖。
 * 每个副本在真实 Electron 窗口中完成：打开 → 编辑 → 保存 → 重开 → 预览 → 目录版导出。
 *
 * 用法：node scripts/alpha-acceptance.cjs [--only Wanfeng_Part1_Alpha] [--skip-export]
 */
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const argOf = (k, d) => { const i = ARGS.indexOf('--' + k); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d; };
const ONLY = argOf('only', '');
const SKIP_EXPORT = ARGS.includes('--skip-export');
const SOURCE_BASE = path.resolve(argOf('source',
  'C:/Users/Administrator/WorkBuddy/LAPTOP-O1JJ0J9M/PaperVNStudio-v0.3-source-and-AI-guide/wanfeng_alpha/projects'));
const NAMES = ['Wanfeng_Part1_Alpha', 'Wanfeng_Part1_Rehearsal', 'Wanfeng_Asset_Check'];
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-alpha-accept-'));
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const report = { version: '0.7.6-M3', at: new Date().toISOString(), sourceBase: SOURCE_BASE,
  isolatedCopies: WORK, ok: true, projects: {}, problems: [], screenshots: [],
  machine: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, totalMem: os.totalmem() } };

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
async function waitPage(port, match, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find(x => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(300);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP 超时')), 20000);
    ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); };
  });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
    const s = pending.get(m.id); if (!s) return; pending.delete(m.id);
    m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result); };
  ws.onclose = () => { for (const s of pending.values()) s.reject(new Error('CDP 连接已关闭')); pending.clear(); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params }));
  });
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
  return { send, ev, shot, close: () => { try { ws.close(); } catch {} } };
}
function killTree(pid) { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'backups') continue;          // 备份不是工程内容，副本不需要
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function fingerprint(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'project.paper.json'), 'utf8'));
  return { title: j.title, nodes: (j.nodes || []).length, images: (j.assets || []).length,
    audio: (j.audioAssets || []).length, chapters: (j.chapters || []).length,
    firstText: String((j.nodes && j.nodes[0] && j.nodes[0].text) || ''),
    jsonBytes: fs.statSync(path.join(dir, 'project.paper.json')).size };
}
async function runOne(name) {
  const src = path.join(SOURCE_BASE, name);
  if (!fs.existsSync(path.join(src, 'project.paper.json'))) {
    report.projects[name] = { ok: false, reason: '源工程不存在' };
    report.ok = false; report.problems.push(name + '：源工程不存在'); return;
  }
  const before = fingerprint(src);
  const copy = path.join(WORK, name);
  copyDir(src, copy);                          // 原件只读，所有写操作都在副本
  const userData = path.join(WORK, 'ud-' + name);
  const exportsDir = path.join(WORK, 'exports-' + name);
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(exportsDir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: copy, items: [{ path: copy, title: before.title, openedAt: new Date().toISOString() }]
  }));
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + userData], { cwd: ROOT, stdio: 'ignore', env });
  const one = { source: src, copy, before, steps: {}, ok: true };
  let editor = null, preview = null;
  const step = async (key, fn) => {
    const t0 = Date.now();
    try { const v = await fn(); one.steps[key] = { ok: true, ms: Date.now() - t0, detail: v }; return v; }
    catch (e) { one.steps[key] = { ok: false, ms: Date.now() - t0, message: e.message }; throw e; }
  };
  try {
    await step('open', async () => {
      const page = await waitPage(port, u => u.startsWith('paper://app/'), 120000);
      if (!page) throw new Error('编辑器窗口未出现');
      editor = await connect(page.webSocketDebuggerUrl);
      let m = null;
      for (let i = 0; i < 240; i++) {
        m = await editor.ev(`(() => {const M=window.__pvnM3;return M?M.metrics():null})()`).catch(() => null);
        if (m && m.assets === before.images && m.audio === before.audio) break;
        await sleep(300);
      }
      if (!m || m.assets !== before.images || m.audio !== before.audio) {
        throw new Error('打开后素材数量不符：' + JSON.stringify({ m, before }));
      }
      return m;
    });
    const originalText = await editor.ev(`window.__pvnM3.nodeText()`);
    await step('edit', async () => {
      await editor.ev(`window.__pvnM3.editText('【M3 兼容性验收·仅副本】' + ${JSON.stringify(originalText)})`);
      const t = await editor.ev(`window.__pvnM3.nodeText()`);
      if (t === originalText) throw new Error('编辑未生效');
      return { textLength: t.length };
    });
    await step('save', async () => {
      const r = await editor.ev(`(async()=>await window.__pvnM3.save())()`);
      if (!r || r.ok === false) throw new Error('保存失败：' + JSON.stringify(r));
      const disk = fs.readFileSync(path.join(copy, 'project.paper.json'), 'utf8');
      if (disk.includes('base64,')) throw new Error('保存后工程仍含 Base64 素材');
      return { diskBytes: Buffer.byteLength(disk) };
    });
    await step('reopen', async () => {
      editor.close(); editor = null; killTree(proc.pid); await sleep(900);
      const again = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*',
        '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + userData], { cwd: ROOT, stdio: 'ignore', env });
      one.reopenPid = again.pid;
      const page = await waitPage(port, u => u.startsWith('paper://app/'), 120000);
      if (!page) throw new Error('重开后窗口未出现');
      editor = await connect(page.webSocketDebuggerUrl);
      let m = null;
      for (let i = 0; i < 240; i++) {
        m = await editor.ev(`(() => {const M=window.__pvnM3;return M?M.metrics():null})()`).catch(() => null);
        if (m && m.assets === before.images) break;
        await sleep(300);
      }
      const text = await editor.ev(`window.__pvnM3.nodeText()`);
      if (!m || m.assets !== before.images || text !== '【M3 兼容性验收·仅副本】' + originalText) {
        throw new Error('重开后内容不一致：' + JSON.stringify({ m, text }));
      }
      return { runtime: m };
    });
    await step('preview', async () => {
      await editor.ev(`document.querySelector('#fullPreview').click()`);
      const page = await waitPage(port, u => u.startsWith('pvres://'), 240000);
      if (!page) throw new Error('预览窗口未出现');
      preview = await connect(page.webSocketDebuggerUrl);
      for (let i = 0; i < 240; i++) { if (await preview.ev(`!!document.getElementById('startGame')`)) break; await sleep(300); }
      await preview.ev(`document.getElementById('startGame').click()`);
      let s = null;
      for (let i = 0; i < 200; i++) {
        s = await preview.ev(`(() => {const a=[...document.querySelectorAll('#layers img')];
          return {count:a.length,loaded:a.filter(i=>i.complete&&i.naturalWidth>0).length,
            allPvres:a.length>0&&a.every(i=>String(i.src).startsWith('pvres://'))};})()`);
        if (s && s.loaded > 0) break;
        await sleep(300);
      }
      if (!s || !s.loaded) throw new Error('预览图片未加载：' + JSON.stringify(s));
      one.screenshot = await preview.shot(path.join(SHOTS, 'v076-m3-alpha-' + name + '.png'));
      report.screenshots.push(one.screenshot);
      return s;
    });
    try { await editor.ev(`window.PaperHost.closePreview()`); } catch {}
    if (!SKIP_EXPORT) {
      await step('folderExport', async () => {
        const r = await editor.ev(`(async()=>{
          const q=window.__pvnM3.project();
          return await window.PaperHost.exportGame({project:q,type:'folder',outDir:${JSON.stringify(exportsDir)}});
        })()`);
        if (!r || !r.ok) throw new Error('目录版导出失败：' + JSON.stringify(r).slice(0, 400));
        const content = path.join(r.artifact, 'resources', 'app', 'content');
        return { artifact: r.artifact, htmlBytes: fs.statSync(path.join(content, 'index.html')).size,
          images: fs.readdirSync(path.join(content, 'assets', 'images')).length,
          audio: fs.readdirSync(path.join(content, 'assets', 'audio')).length };
      });
    } else one.steps.folderExport = { ok: null, skipped: true };
    const after = fingerprint(src);
    one.sourceUnchanged = JSON.stringify(after) === JSON.stringify(before);
    if (!one.sourceUnchanged) throw new Error('原始作品工程被改动！');
    one.copyAfter = fingerprint(copy);
    console.log('  ok  ' + name + ' — ' + Object.keys(one.steps).map(k => k + (one.steps[k].ok === true ? '✓' : one.steps[k].ok === null ? '-' : '✗')).join(' '));
  } catch (e) {
    one.ok = false; one.error = e.message; report.ok = false;
    report.problems.push(name + '：' + e.message);
    console.log('  FAIL ' + name + ' — ' + e.message);
  } finally {
    try { if (preview) preview.close(); } catch {}
    try { if (editor) editor.close(); } catch {}
    killTree(proc.pid);
    if (one.reopenPid) killTree(one.reopenPid);
    report.projects[name] = one;
  }
}

(async () => {
  for (const name of (ONLY ? [ONLY] : NAMES)) await runOne(name);
  fs.writeFileSync(path.join(ROOT, 'release', 'alpha-acceptance.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: report.ok, projects: Object.fromEntries(
    Object.entries(report.projects).map(([k, v]) => [k, { ok: v.ok, steps: v.steps, sourceUnchanged: v.sourceUnchanged }])),
    problems: report.problems }, null, 2));
  process.exit(report.ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
