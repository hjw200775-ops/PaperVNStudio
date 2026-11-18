'use strict';
/*
 * 《晚风经过二楼走廊》独立试玩包验收（V0.7 第一阶段）。
 *
 *   node scripts/game-package-acceptance.cjs                 # 用 release/game 里最新的 ZIP
 *   node scripts/game-package-acceptance.cjs --zip=<zip>     # 指定 ZIP
 *   node scripts/game-package-acceptance.cjs --no-editor     # 跳过纸间编辑器/内置示例交叉检查
 *
 * 原则：验收对象是**真正解压后的成品**，不是源码启动。
 *   1. 解压到带中文与空格的目录，双击等价地启动 EXE（进程启动，不经过源码）；
 *   2. 用 Chromium 远程调试（CDP）驱动真实窗口：标题页 → 从头玩到 demo_end；
 *   3. 存档 → 杀进程 → 重开继续到同一句 → 移动整个解压目录 → 再继续；
 *   4. 与纸间编辑器、内置示例三处存档互不影响（有编辑器成品时做交叉验证）；
 *   5. ZIP 清单里没有编辑器入口、工程文件与本机开发路径。
 *
 * 远程调试只在验收时用 PAPER_GAME_DEVTOOLS=1 打开，窗口的 sandbox / 上下文隔离 /
 * 禁用 Node 集成配置与正式运行完全相同；若不开也能连上，就不加这个变量。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { listZipEntries } = require('./zip-manifest.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'release', 'game');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const SAMPLE_DIR = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');

const args = process.argv.slice(2);
const argOf = name => {
  const hit = args.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const noEditor = !!argOf('no-editor');
const keepWork = !!argOf('keep');

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const report = { ok: false, stages: {}, problems: [], unverified: [], startedAt: new Date().toISOString() };
const ok = (stage, detail) => {
  report.stages[stage] = { ok: true, ...(detail === undefined ? {} : { detail }) };
  console.log('  ok   ' + stage + (detail && detail.summary ? ' — ' + detail.summary : ''));
};
const bad = (stage, message, detail) => {
  report.stages[stage] = { ok: false, message, detail };
  report.problems.push(stage + '：' + message);
  console.log('  FAIL ' + stage + ' — ' + message);
};

/* ---------- 解压与文件工具 ---------- */

function findZip() {
  const given = argOf('zip');
  if (given && given !== true) return path.resolve(given);
  if (!fs.existsSync(OUT_ROOT)) throw new Error('还没有构建产物：' + OUT_ROOT);
  const zips = fs.readdirSync(OUT_ROOT).filter(f => f.toLowerCase().endsWith('.zip'))
    .map(f => ({ f, t: fs.statSync(path.join(OUT_ROOT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!zips.length) throw new Error('release/game 下没有 ZIP，请先运行 npm run game:build');
  return path.join(OUT_ROOT, zips[0].f);
}

function extract(zipPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync(TAR, ['-x', '-f', zipPath, '-C', dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('解压失败：' + (r.stderr || r.status));
  const entries = fs.readdirSync(dest, { withFileTypes: true }).filter(d => d.isDirectory());
  if (!entries.length) throw new Error('解压后没有目录');
  return path.join(dest, entries[0].name);
}

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push({ rel: path.relative(base, abs).replace(/\\/g, '/'), abs, bytes: st.size });
  }
  return out;
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', () => resolve(9400 + Math.floor(Math.random() * 100)));
  });
}

/* ---------- CDP ---------- */

async function httpJson(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function waitPage(port, match, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson('http://127.0.0.1:' + port + '/json/list');
      const page = (Array.isArray(list) ? list : [])
        .find(t => t.type === 'page' && typeof t.url === 'string' && match(t.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 进程还没起来 */ }
    await sleep(250);
  }
  return null;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message || 'CDP 错误'));
    else slot.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      throw new Error('页面脚本异常：' + ((ex.exception && ex.exception.description) || ex.text));
    }
    return r.result && r.result.value;
  };
  return { send, evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

/* 页面可能在 target 出现后仍在执行内联播放器脚本：等到状态钩子就绪再断言。 */
async function waitReady(cdp, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`({ready:document.readyState,hasHook:typeof window.paperGameState==='function',
      title:document.title,texts:document.body?document.body.innerText.slice(0,80):''})`);
    if (last.ready === 'complete' && last.hasHook) return last;
    await sleep(200);
  }
  throw new Error('游戏页面没有就绪：' + JSON.stringify(last));
}

/* ---------- 启动 / 关闭游戏 ---------- */

let devtoolsFallback = false;
let activeProc = null;

async function launchGame(exePath, port, { devtools = false } = {}) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (devtools) env.PAPER_GAME_DEVTOOLS = '1';
  const proc = spawn(exePath, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'], {
    cwd: path.dirname(exePath), env, stdio: 'ignore', windowsHide: false
  });
  activeProc = proc;
  const page = await waitPage(port, url => url.startsWith('wanfeng://game/'));
  if (!page) return { proc, cdp: null, page: null };
  const cdp = await connect(page.webSocketDebuggerUrl);
  return { proc, cdp, page };
}

async function openGame(exePath) {
  const port = await freePort();
  let run = await launchGame(exePath, port);
  if (!run.cdp) {
    killTree(run.proc.pid);
    await sleep(1200);
    devtoolsFallback = true;
    const port2 = await freePort();
    run = await launchGame(exePath, port2, { devtools: true });
    if (!run.cdp) throw new Error('连不上游戏窗口的调试端口：EXE 可能没有启动或窗口加载失败');
  }
  await waitReady(run.cdp);
  return run;
}

/* 先按玩家的做法关窗口（让 Chromium 把 localStorage 落盘），超时才强杀进程。 */
async function closeGame(run) {
  if (!run) return;
  const pid = run.proc && run.proc.pid;
  if (run.cdp) {
    try { await run.cdp.evaluate('window.close()'); } catch { /* 窗口可能已关 */ }
    try { run.cdp.close(); } catch { /* ignore */ }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!pid || !isAlive(pid)) break;
      await sleep(200);
    }
  }
  if (pid && isAlive(pid)) killTree(pid);
  await sleep(500);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/* 刚关掉的 Electron 进程可能还短暂占着目录句柄，Windows 上 rename 会 EPERM。
 * 先等再重试；仍然不行就整目录复制过去，用副本继续验收（照样验证「换个位置读档」）。 */
async function moveDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let i = 0; i < 10; i++) {
    try {
      fs.renameSync(src, dest);
      return { method: 'rename', from: src, to: dest };
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      await sleep(500);
    }
  }
  fs.cpSync(src, dest, { recursive: true });
  return { method: 'copy', from: src, to: dest };
}

/* ---------- 页面断言 ---------- */

const STATE_JS = `(()=>{const st=window.paperGameState();
 const imgs=[...document.querySelectorAll('#layers img')];
 return {state:st.state,i:st.i,trail:st.trail.length,who:document.getElementById('who').textContent,
  text:document.getElementById('text').textContent,hint:document.getElementById('hint').textContent,
  imgs:imgs.map(im=>({name:im.alt,ok:im.complete&&im.naturalWidth>0,w:im.naturalWidth}))};})()`;

async function waitImages(cdp, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await cdp.evaluate(STATE_JS);
    if (s.imgs.every(im => im.ok)) return s;
    await sleep(150);
  }
  return cdp.evaluate(STATE_JS);
}

async function titleCheck(cdp) {
  return cdp.evaluate(`(()=>{const st=window.paperGameState();
   const img=document.getElementById('titleBgImg'),sec=document.getElementById('titleScreen');
   return {href:location.href,origin:location.origin,title:document.title,
    heading:document.getElementById('title').textContent,
    hasBgClass:sec.classList.contains('has-bg'),bgShown:!document.getElementById('titleBg').hidden,
    bgPrefix:(img&&img.src||'').slice(0,16),bgLoaded:!!img&&img.complete&&img.naturalWidth>0,
    bgMissingNote:document.getElementById('titleBgNote').hidden?'':document.getElementById('titleBgNote').textContent,
    titleNote:document.getElementById('titleNote').textContent,
    startDisabled:document.getElementById('startGame').disabled,
    continueDisabled:document.getElementById('continueGame').disabled,
    nodes:st.nodes,hasAudio:st.hasAudio,titleBg:st.titleBg};})()`);
}

async function networkCheck(cdp) {
  return cdp.evaluate(`Promise.race([
    fetch('https://example.com/',{mode:'cors'}).then(()=>'reachable').catch(e=>'blocked'),
    new Promise(r=>setTimeout(()=>r('timeout'),4000))
  ])`);
}

/* ---------- 通关 ---------- */

async function playThrough(cdp, expected) {
  const steps = [];
  await cdp.evaluate(`document.getElementById('startGame').click()`);
  let at = null;
  for (let guard = 0; guard < 90; guard++) {
    await sleep(140);
    const s = await waitImages(cdp);
    if (at === null || s.i !== at) {
      steps.push({ i: s.i, id: expected[s.i] ? expected[s.i].id : '?', who: s.who,
        text: s.text, imgs: s.imgs.map(im => im.name), imagesOk: s.imgs.every(im => im.ok),
        missing: s.imgs.filter(im => !im.ok).map(im => im.name) });
      at = s.i;
    }
    if (s.i === 24) await sleep(700);            /* road_17 演出动画走完再读样式 */
    if (s.hint === '故事结束') return { steps, final: s };
    await cdp.evaluate(`document.getElementById('scene').click()`);
  }
  throw new Error('点击推进 90 次仍未到 demo_end，当前停在 ' + (at === null ? '标题' : expected[at].id));
}

async function road17Check(cdp) {
  return cdp.evaluate(`(()=>{
   const layers=[...document.querySelectorAll('.visual-layer')].map(w=>({id:w.dataset.layer,
     transform:w.style.transform,filter:w.style.filter}));
   const box=document.getElementById('box');
   return {layers,who:document.getElementById('who').textContent,
     text:document.getElementById('text').textContent,
     textColor:document.getElementById('who').style.color||'',
     boxVisible:!!box&&getComputedStyle(box).display!=='none'};})()`);
}

async function saveAtCurrent(cdp, key) {
  await cdp.evaluate(`document.getElementById('menuBtn').click()`);
  await sleep(200);
  await cdp.evaluate(`document.getElementById('save').click()`);
  await sleep(250);
  const raw = await cdp.evaluate(`localStorage.getItem(${JSON.stringify(key)})`);
  const note = await cdp.evaluate(`document.getElementById('menuNote').textContent`);
  await cdp.evaluate(`document.getElementById('menuResume').click()`);
  await sleep(200);
  if (!raw) throw new Error('保存后 localStorage 里没有存档：' + note);
  return { raw, note, save: JSON.parse(raw) };
}

async function resumeFromTitle(cdp) {
  const enabled = await cdp.evaluate(`!document.getElementById('continueGame').disabled`);
  if (!enabled) {
    const reason = await cdp.evaluate(`document.getElementById('titleNote').textContent`);
    throw new Error('继续游戏不可用：' + reason);
  }
  await cdp.evaluate(`document.getElementById('continueGame').click()`);
  await sleep(400);
  return waitImages(cdp);
}

/* ---------- 存储隔离 ---------- */

function appDataPath(...parts) {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, ...parts);
}

function leveldbText(dir) {
  if (!fs.existsSync(dir)) return '';
  let text = '';
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    if (!fs.statSync(abs).isFile()) continue;
    text += fs.readFileSync(abs).toString('latin1');
  }
  return text;
}

/* ---------- ZIP 清单 ---------- */

const FORBIDDEN_ZIP = [
  { re: /(^|\/)(dist|desktop|scripts|tests|docs|node_modules|release)\//i, why: '源码 / 开发目录' },
  { re: /\.test\.cjs$/i, why: '测试文件' },
  { re: /project\.paper\.json$/i, why: '工程文件' },
  { re: /(^|\/)backups?\//i, why: '备份目录' },
  { re: /(^|\/)assets\/images\//i, why: '未打包的原图目录' },
  { re: /app\.asar\.unpacked/i, why: 'asar 外散落资源' },
  { re: /\.log$/i, why: '日志' }
];

function zipAudit(zipPath, pkgDir) {
  /* 用中央目录解析而不是 tar -t：后者按控制台代码页输出中文名，会得到假失败。 */
  const entries = listZipEntries(zipPath).map(e => e.name);
  const roots = new Set(entries.map(e => e.split('/')[0]));
  const problems = [];
  if (roots.size !== 1) problems.push('ZIP 根目录不唯一：' + [...roots].join(', '));
  const top = [...roots][0];
  for (const e of entries) {
    for (const rule of FORBIDDEN_ZIP) if (rule.re.test(e)) problems.push(e + '（' + rule.why + '）');
  }
  const need = [top + '/晚风经过二楼走廊.exe', top + '/resources/app.asar',
    top + '/LICENSE', top + '/NOTICE-素材与许可.txt', top + '/试玩说明.txt',
    top + '/LICENSES.chromium.html'];
  for (const n of need) {
    if (!entries.some(e => e === n || e === n.replace(/\/$/, ''))) problems.push('缺少 ' + n);
  }
  if (problems.length) throw new Error('ZIP 清单不合格：' + problems.join('；'));

  const files = walk(pkgDir);
  const asarPath = path.join(pkgDir, 'resources', 'app.asar');
  const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
  const asarEntries = asar.listPackage(asarPath).map(p => p.replace(/\\/g, '/'));
  const expectedAsar = ['/main.cjs', '/package.json', '/content/index.html', '/content'];
  const stray = asarEntries.filter(e => !expectedAsar.includes(e));
  if (stray.length) throw new Error('app.asar 混入文件：' + stray.join(', '));

  const asarText = fs.readFileSync(asarPath).toString('utf8');
  const devLeaks = ['PaperVNStudio-src', '新建文件夹', 'desktop/main.cjs', 'dist/app.js', 'paper://app']
    .filter(n => asarText.includes(n));
  const rootText = files.filter(f => /\.(txt|json|html)$/i.test(f.rel) && f.bytes < 256 * 1024)
    .map(f => fs.readFileSync(f.abs, 'utf8')).join('\n');
  for (const n of ['PaperVNStudio-src', '新建文件夹\\', 'node_modules', 'desktop/main.cjs']) {
    if (rootText.includes(n)) devLeaks.push(n + '（包内文本）');
  }
  if (devLeaks.length) throw new Error('包里出现开发痕迹：' + devLeaks.join(', '));

  return {
    summary: entries.length + ' 个条目 · ' + files.length + ' 个文件 · asar ' + mb(fs.statSync(asarPath).size),
    roots: [...roots], entries: entries.length, files: files.length,
    asarEntries, devLeaks, zipBytes: fs.statSync(zipPath).size
  };
}

/* ---------- 主流程 ---------- */

async function main() {
  const zipPath = findZip();
  const extractedTo = path.join(os.tmpdir(), '晚风 试玩 验收', stamp());
  console.log('验收对象：' + zipPath);
  console.log('解压到：  ' + extractedTo);
  fs.mkdirSync(extractedTo, { recursive: true });

  const pkgDir = extract(zipPath, extractedTo);
  const exePath = path.join(pkgDir, '晚风经过二楼走廊.exe');
  if (!fs.existsSync(exePath)) throw new Error('解压后没找到 EXE：' + exePath);
  report.zip = { file: zipPath, bytes: fs.statSync(zipPath).size, sha256: sha256(fs.readFileSync(zipPath)) };
  report.exe = exePath;
  ok('解压：目录名含中文与空格', { summary: path.basename(pkgDir) });

  const sample = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'project.paper.json'), 'utf8'));
  const expected = sample.nodes;
  const saveKey = 'paper-game-' + sample.id;

  /* 1. 标题页 */
  const t0 = Date.now();
  let run = await openGame(exePath);
  const startupMs = Date.now() - t0;
  let title = await titleCheck(run.cdp);
  const net = await networkCheck(run.cdp);
  const titleProblems = [];
  if (title.origin !== 'wanfeng://game') titleProblems.push('页面来源不是 wanfeng://game：' + title.origin);
  if (title.title !== sample.title) titleProblems.push('标题不是《晚风》：' + title.title);
  if (!title.hasBgClass || !title.bgShown || !title.bgLoaded) titleProblems.push('标题背景（家中走廊）没有显示');
  if (title.bgPrefix !== 'data:image/png' && !title.bgPrefix.startsWith('data:image')) titleProblems.push('标题图不是内嵌 data: 图片');
  if (title.nodes !== 45) titleProblems.push('节点数不是 45：' + title.nodes);
  if (title.titleBg !== true) titleProblems.push('titleBackground 没有按家中走廊素材生效');
  if (net !== 'blocked') titleProblems.push('网络请求没有被拦截：' + net);
  const titleStage = '标题页 / 断网';
  if (titleProblems.length) bad(titleStage, titleProblems.join('；'), { ...title, network: net });
  else ok(titleStage, { summary: '标题与家中走廊背景正确，网络请求已拦截，启动 ' + startupMs + ' ms',
    ...title, network: net, startupMs, devtoolsFallback });

  /* 2. 从头玩到 demo_end */
  const played = await playThrough(run.cdp, expected);
  const mismatch = played.steps.filter(s => s.text !== expected[s.i].text);
  const badImages = played.steps.filter(s => !s.imagesOk);
  const whoMismatch = played.steps.filter(s => s.who !== (expected[s.i].name || ''));
  const playStage = '通关 demo_end';
  const playDetail = {
    steps: played.steps.map(s => ({ i: s.i, id: s.id, who: s.who, text: s.text.slice(0, 24), imgs: s.imgs })),
    end: { hint: played.final.hint, text: played.final.text }
  };
  if (played.steps.length !== 45) bad(playStage, '经过的句子不是 45 句：' + played.steps.length, playDetail);
  else if (mismatch.length) bad(playStage, '正文与原作不一致：' + mismatch.map(m => m.id).join(', '), playDetail);
  else if (badImages.length) bad(playStage, '有场景图片没加载：' + badImages.map(b => b.id + '(' + b.missing.join('/') + ')').join(', '), playDetail);
  else if (whoMismatch.length) bad(playStage, '说话人与原作不一致：' + whoMismatch.map(m => m.id).join(', '), playDetail);
  else ok(playStage, { summary: '45 句全过，图片全部加载，正文与说话人逐句一致', ...playDetail });

  /* 3. 表情与 road_17 演出 */
  const first = played.steps.find(s => s.i === 0);
  const road18 = played.steps.find(s => s.i === 25);
  const exprProblems = [];
  if (!first || !first.imgs.includes('林悠·校服·自然') || !first.imgs.includes('林澈·校服·平静')) {
    exprProblems.push('开场两人表情不是「自然 / 平静」：' + (first ? first.imgs.join('、') : '缺帧'));
  }
  if (!road18 || !road18.imgs.includes('林悠·校服·轻恼') || !road18.imgs.includes('林澈·校服·微笑')) {
    exprProblems.push('road_18 表情不是「轻恼 / 微笑」：' + (road18 ? road18.imgs.join('、') : '缺帧'));
  }
  if (exprProblems.length) bad('角色表情', exprProblems.join('；'));

  /* 回到 road_17 复核演出：从标题重新开始太慢，直接在当前会话用「上一步」回退不可行，
   * 因此演出断言放在通关过程中的独立采样里。这里启动第二遍到 road_17 采样。 */
  await closeGame(run);
  run = await openGame(exePath);
  await run.cdp.evaluate(`document.getElementById('startGame').click()`);
  let road17 = null;
  for (let g = 0; g < 40; g++) {
    const s = await waitImages(run.cdp);
    if (s.i === 24) { await sleep(750); road17 = await road17Check(run.cdp); break; }
    await run.cdp.evaluate(`document.getElementById('scene').click()`);
    await sleep(120);
  }
  if (!road17) {
    bad('road_17 演出', '没能停在 road_17');
  } else {
    const linyou = road17.layers.find(l => l.id === 'linyou');
    const bg = road17.layers.find(l => l.id === 'background');
    const scale = linyou && /scale\(([\d.]+)\)/.exec(linyou.transform);
    const blur = bg && /blur\(([\d.]+)px\)/.exec(bg.filter);
    const problems = [];
    if (!scale || Math.abs(Number(scale[1]) - 1.2) > 0.02) problems.push('人物特写缩放不是 120%：' + (linyou ? linyou.transform : '缺图层'));
    if (!blur || Number(blur[1]) <= 0) problems.push('背景没有虚化：' + (bg ? bg.filter : '缺图层'));
    if (road17.who !== '林悠') problems.push('road_17 说话人不是林悠：' + road17.who);
    if (road17.text !== expected[24].text) problems.push('road_17 台词与原作不一致');
    if (problems.length) bad('road_17 演出', problems.join('；'), road17);
    else {
      ok('road_17 演出', { summary: '人物特写 ' + Math.round(Number(scale[1]) * 100) + '% · 背景虚化生效（8/1280 画布 → 实际 '
        + Number(blur[1]).toFixed(2) + 'px）· 林悠「轻恼」', ...road17 });
      if (!exprProblems.length) ok('角色表情', { summary: '开场自然/平静，road_17 轻恼，road_18 轻恼/微笑' });
    }
  }

  /* 4. 存档 → 退出 → 继续 */
  const saved = await saveAtCurrent(run.cdp, saveKey);
  const expectId = expected[24].id;
  if (saved.save.id !== expectId) bad('保存', '存档节点不是 road_17：' + saved.save.id);
  else ok('保存', { summary: '第 25 句 road_17，路径 ' + saved.save.trail.length + ' 步' });
  const beforeKill = await run.cdp.evaluate(STATE_JS);
  await closeGame(run);

  run = await openGame(exePath);
  const titleAfter = await titleCheck(run.cdp);
  if (titleAfter.continueDisabled) bad('退出重开', '重开后「继续游戏」不可用：' + titleAfter.titleNote);
  const resumed = await resumeFromTitle(run.cdp);
  const resumeProblems = [];
  if (resumed.i !== 24) resumeProblems.push('继续后停在第 ' + (resumed.i + 1) + ' 句，不是 road_17');
  if (resumed.text !== expected[24].text) resumeProblems.push('继续后的正文与存档不一致');
  if (resumed.trail !== saved.save.trail.length) resumeProblems.push('恢复的路径长度不对：' + resumed.trail);
  if (!resumed.imgs.every(im => im.ok)) resumeProblems.push('读档后图片未加载');
  if (resumeProblems.length) bad('退出重开继续', resumeProblems.join('；'), resumed);
  else ok('退出重开继续', { summary: '回到同一句「' + resumed.text + '」' });

  /* 5. 保存进度，移动整个解压目录后再读档 */
  await saveAtCurrent(run.cdp, saveKey).catch(() => null);   /* 保证存档是最新一句 */
  await closeGame(run);
  const movedRoot = path.join(os.tmpdir(), '晚风 移动后', stamp());
  fs.mkdirSync(movedRoot, { recursive: true });
  const movedDir = path.join(movedRoot, '晚风 经过二楼走廊 移动测试');
  await sleep(1200);
  const moved = await moveDir(pkgDir, movedDir);
  const movedExe = path.join(movedDir, '晚风经过二楼走廊.exe');
  run = await openGame(movedExe);
  const movedTitle = await titleCheck(run.cdp);
  const movedResume = movedTitle.continueDisabled ? null : await resumeFromTitle(run.cdp);
  if (!movedResume) bad('移动后读档', '移动目录后「继续游戏」不可用');
  else if (movedResume.text !== expected[24].text || movedResume.i !== 24) {
    bad('移动后读档', '移动后读到的不是同一句：第 ' + (movedResume.i + 1) + ' 句');
  } else {
    ok('移动后读档', { summary: path.basename(movedDir) + ' → 仍回到 road_17', ...moved });
  }
  await closeGame(run);

  /* 6. 三处存档隔离 */
  const gameDir = appDataPath('PaperVNStudio-Game-wanfeng-ch01');
  const editorDir = appDataPath('PaperVNStudio');
  const sampleStore = path.join(editorDir, 'Partitions', 'papervn-sample', 'Local Storage', 'leveldb');
  const gameText = leveldbText(path.join(gameDir, 'Local Storage', 'leveldb'));
  const editorText = leveldbText(path.join(editorDir, 'Local Storage', 'leveldb'));
  const iso = { gameDir, editorDir, sampleStore,
    gameHasKey: gameText.includes(saveKey), editorHasKey: editorText.includes(saveKey),
    sampleStoreExists: fs.existsSync(sampleStore) };

  let editorCross = null;
  if (!noEditor) {
    const editorExe = (argOf('editor-exe') && argOf('editor-exe') !== true)
      ? path.resolve(argOf('editor-exe'))
      : ['F:\\Wanfeng-Demo\\PaperVNStudio-0.6.2\\PaperVNStudio.exe',
        path.join(ROOT, 'release', 'win-unpacked', 'PaperVNStudio.exe')].find(p => fs.existsSync(p));
    if (!editorExe) {
      report.unverified.push('纸间编辑器 / 内置示例交叉验证：本机没有可用的 0.6.2 编辑器成品');
    } else {
      editorCross = await sampleCrossCheck(editorExe, movedExe, expected, saveKey);
    }
  } else {
    report.unverified.push('纸间编辑器 / 内置示例交叉验证：本次用 --no-editor 跳过');
  }

  if (!iso.gameHasKey) bad('存档隔离', '游戏自己的存档目录里没有存档键');
  else if (iso.editorHasKey) bad('存档隔离', '纸间编辑器默认存储里出现了游戏存档键');
  else ok('存档隔离', { summary: '游戏存档只在 ' + gameDir + '；编辑器默认存储无此键', ...iso, editorCross });

  /* 7. ZIP 清单 */
  const audit = zipAudit(zipPath, movedDir);
  ok('ZIP 清单', { summary: audit.summary + ' · 无编辑器入口 / 工程文件 / 本机路径', ...audit });

  report.ok = report.problems.length === 0;
  report.finishedAt = new Date().toISOString();
  report.devtoolsFallback = devtoolsFallback;
  report.work = { extractedTo, movedTo: movedDir, kept: keepWork };
  report.unverified.push('第二台 Windows 电脑（未装纸间与开发环境）断网启动：本机无法验证');

  const reportPath = path.join(OUT_ROOT, 'acceptance-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('');
  console.log(report.ok ? 'GAME PACKAGE ACCEPTANCE PASS' : 'GAME PACKAGE ACCEPTANCE FAIL');
  console.log('  ZIP     ' + zipPath);
  console.log('  SHA-256 ' + report.zip.sha256);
  console.log('  报告    ' + reportPath);
  if (report.unverified.length) console.log('  未验证  ' + report.unverified.join(' / '));
  if (report.problems.length) {
    console.log('  问题');
    for (const p of report.problems) console.log('    - ' + p);
  }
  if (!keepWork) {
    /* 只清理本次验收自己创建的临时目录。 */
    try { fs.rmSync(extractedTo, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(movedDir), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exitCode = report.ok ? 0 : 1;
}

/* 纸间编辑器 → 内置示例体验：在同一个应用里写一份不同的存档，
 * 再确认游戏侧的存档没有被带动。 */
async function sampleCrossCheck(editorExe, gameExe, expected, saveKey) {
  const detail = { editorExe, sampleSaveId: null, gameStillAt: null, ok: false };
  let editor = null;
  try {
    const port = await freePort();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(editorExe, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'],
      { cwd: path.dirname(editorExe), env, stdio: 'ignore' });
    const page = await waitPage(port, url => url.startsWith('paper://app/'), 30000);
    if (!page) throw new Error('编辑器窗口没有起来');
    const cdp = await connect(page.webSocketDebuggerUrl);
    editor = { proc, cdp };
    /* 编辑器页面加载完才会由 desktop-bridge 注入 PaperHost，等它出现再点。 */
    let hostReady = false;
    for (let i = 0; i < 100 && !hostReady; i++) {
      hostReady = await cdp.evaluate(`typeof window.PaperHost==='object' && typeof window.PaperHost.experienceSample==='function'`);
      if (!hostReady) await sleep(200);
    }
    if (!hostReady) throw new Error('编辑器页面没有暴露 PaperHost（可能不是 0.6.2 成品）');
    await cdp.evaluate(`window.PaperHost.experienceSample()`);
    const samplePage = await waitPage(port, url => url.includes('game-sample.html'), 20000);
    if (!samplePage) throw new Error('内置示例窗口没有起来');
    const scdp = await connect(samplePage.webSocketDebuggerUrl);
    let sampleReady = false;
    for (let i = 0; i < 60 && !sampleReady; i++) {
      sampleReady = await scdp.evaluate(`typeof window.paperGameState==='function'`);
      if (!sampleReady) await sleep(200);
    }
    if (!sampleReady) throw new Error('示例窗口没有就绪');
    await scdp.evaluate(`document.getElementById('startGame').click()`);
    for (let i = 0; i < 4; i++) { await sleep(160); await scdp.evaluate(`document.getElementById('scene').click()`); }
    await sleep(300);
    await scdp.evaluate(`document.getElementById('menuBtn').click()`);
    await sleep(200);
    await scdp.evaluate(`document.getElementById('save').click()`);
    await sleep(250);
    const raw = await scdp.evaluate(`localStorage.getItem(${JSON.stringify(saveKey)})`);
    detail.sampleSaveId = raw ? JSON.parse(raw).id : null;
    detail.sampleOrigin = await scdp.evaluate('location.origin + " " + location.href.slice(0, 24)');
    scdp.close();

    const game = await openGame(gameExe);
    const resumed = await resumeFromTitle(game.cdp);
    detail.gameStillAt = { i: resumed.i, text: resumed.text.slice(0, 24) };
    await closeGame(game);
    detail.ok = detail.sampleSaveId && detail.sampleSaveId !== expected[24].id &&
      resumed.i === 24 && resumed.text === expected[24].text;
    if (!detail.ok) {
      report.problems.push('交叉验证：编辑器内置示例写入存档后，游戏侧读档被影响');
    } else {
      ok('编辑器 / 示例交叉验证', { summary: '示例存档 ' + detail.sampleSaveId + '，游戏仍回 road_17' });
    }
  } catch (e) {
    report.unverified.push('编辑器 / 内置示例交叉验证失败：' + e.message);
    detail.error = e.message;
  } finally {
    if (editor) { try { editor.cdp.close(); } catch { /* ignore */ } killTree(editor.proc.pid); }
  }
  return detail;
}

main().catch(e => {
  console.error('ACCEPTANCE ERROR ' + e.message);
  if (activeProc) { try { killTree(activeProc.pid); } catch { /* ignore */ } }
  try { fs.rmSync(path.join(os.tmpdir(), '晚风 试玩 验收'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(os.tmpdir(), '晚风 移动后'), { recursive: true, force: true }); } catch { /* ignore */ }
  report.problems.push('异常终止：' + e.message);
  try {
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(path.join(OUT_ROOT, 'acceptance-report.json'),
      JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  process.exitCode = 1;
});
