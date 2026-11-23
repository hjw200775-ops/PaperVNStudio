'use strict';
/*
 * V0.8.0 真实 Electron 窗口验收：演出运行时（M2）+ 剧情同步（M4）+ 编辑器/发布一致性（M5）。
 *
 * 不看「动作对象存在」，只看真实 DOM：
 *  - 阻塞演出期间点击不推进，但会把动画结算到终态；
 *  - 角色出现 / 移动 / 表情切换 / 背景转场真的改了 .pf-frame 与 img.src；
 *  - 编辑器试玩与完整预览（pvres://）在同一个节点上终态一致；
 *  - 读档后重建舞台：不靠动画，直接回到正确终态。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-v08-window-'));
const USER_DATA = path.join(WORK, 'user-data');
const PROJECT = path.join(WORK, 'project');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { at: new Date().toISOString(), ok: true, version: '0.8.0', stages: {}, problems: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d }; console.log('  ok  ' + n); };
const bad = (n, m) => { report.ok = false; report.problems.push(n + '：' + m); report.stages[n] = { ok: false, message: m }; console.log('  FAIL ' + n + ' — ' + m); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function crc32(buf) {
  const t = [];
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
/* 生成真实可解码的 PNG：纯色块带一条对角亮线，便于肉眼确认不是空图 */
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const on = Math.abs(x - y) < 6;
      row[1 + x * 3] = on ? 245 : rgb[0];
      row[2 + x * 3] = on ? 245 : rgb[1];
      row[3 + x * 3] = on ? 245 : rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
async function httpJson(url, ms = 1500) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
async function waitPage(port, match, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find((x) => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(250);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP 超时')), 12000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  return { send, ev, shot, close: () => { try { ws.close(); } catch {} } };
}
function killTree(pid) { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }

/* ---------- 构造带演出的三节点工程 ---------- */
function buildProject() {
  const p = C.blank();
  p.title = 'V0.8 演出验收';
  const mk = (id, name, kind, size, rgb) => {
    const bytes = png(size[0], size[1], rgb);
    return { id, name, kind, data: 'data:image/png;base64,' + bytes.toString('base64'), width: size[0], height: size[1], bytes: bytes.length };
  };
  const bg1 = mk('a_bg_day', '走廊', 'bg', [640, 360], [120, 160, 200]);
  const bg2 = mk('a_bg_night', '夜晚', 'bg', [640, 360], [30, 40, 80]);
  const yuu = mk('a_yuu', '林悠', 'char', [300, 520], [220, 180, 160]);
  const yuuSmile = mk('a_yuu_smile', '林悠·微笑', 'char', [300, 520], [235, 195, 175]);
  const che = mk('a_che', '林澈', 'char', [300, 520], [170, 190, 220]);
  p.assets = [bg1, bg2, yuu, yuuSmile, che];
  p.characters = [
    { id: 'ch_yuu', name: '林悠', color: '#b06a4a', defaultExpressionId: 'e_calm', expressions: [
      { id: 'e_calm', name: '平静', assetId: yuu.id }, { id: 'e_smile', name: '微笑', assetId: yuuSmile.id }] },
    { id: 'ch_che', name: '林澈', color: '#4a6ab0', defaultExpressionId: 'e_che_calm', expressions: [
      { id: 'e_che_calm', name: '平静', assetId: che.id }] }
  ];
  const L = (id, asset, kind, extra) => Object.assign({ id, asset, name: asset, kind, x: kind === 'bg' ? 0 : 20, y: kind === 'bg' ? 0 : 45, w: kind === 'bg' ? 100 : 26, h: kind === 'bg' ? 100 : 55, fit: kind === 'bg' ? 'cover' : 'contain', opacity: 100, hidden: false, locked: false, motion: 'none' }, extra || {});
  const n1 = C.makeNode('say');
  n1.name = '旁白'; n1.text = '清晨的光落在餐桌上，走廊尽头有人走来。'; n1.sceneMode = 'own';
  n1.layers = [L('ly_bg', bg1.id, 'bg'), L('ly_yuu', yuu.id, 'char', { characterId: 'ch_yuu' }), L('ly_che', che.id, 'char', { x: 62, characterId: 'ch_che' })];
  n1.performance = { version: 1, actions: [
    { id: 'p1', type: 'character.show', target: 'char:ch_yuu', params: { side: 'left' }, duration: 0.8, delay: 0, easing: 'easeOut', blocking: true, mode: 'after', enabled: true },
    { id: 'p2', type: 'character.show', target: 'char:ch_che', params: { side: 'fade' }, duration: 0.6, delay: 0, easing: 'easeOut', blocking: false, mode: 'parallel', enabled: true },
    { id: 'p3', type: 'character.move', target: 'char:ch_yuu', params: { x: 35, y: 45 }, duration: 0.6, delay: 0, easing: 'easeInOut', blocking: true, mode: 'after', enabled: true }
  ] };

  const n2 = C.makeNode('say');
  n2.name = '林悠'; n2.text = '放学后的走廊，风把书页吹得沙沙响。'; n2.sceneMode = 'inherit'; n2.speakerId = 'ch_yuu';
  n2.performance = { version: 1, actions: [
    { id: 'p4', type: 'background.change', target: 'bg', params: { assetId: bg2.id, transition: 'crossfade' }, duration: 0.8, delay: 0, easing: 'linear', blocking: false, mode: 'after', enabled: true },
    { id: 'p5', type: 'character.expression', target: 'char:ch_yuu', params: { expressionId: 'e_smile' }, duration: 0.3, delay: 0, easing: 'linear', blocking: false, mode: 'parallel', enabled: true },
    { id: 'p6', type: 'camera.zoom', target: '', params: { scale: 110 }, duration: 1.2, delay: 0, easing: 'easeInOut', blocking: true, mode: 'parallel', enabled: true }
  ] };

  const n3 = C.makeNode('say');
  n3.name = '旁白'; n3.text = '灯还亮着，屋子里安静下来。'; n3.sceneMode = 'inherit';
  n3.performance = { version: 1, actions: [
    { id: 'p7', type: 'screen.fade', target: '', params: { to: 100, color: 'black' }, duration: 0.5, delay: 0, easing: 'linear', blocking: true, mode: 'after', enabled: true }
  ] };

  n1.next = n2.id; n2.next = n3.id;
  p.nodes = [n1, n2, n3];
  const pid = p.chapters[0].paragraphs[0].id;
  for (const n of p.nodes) n.paragraphId = pid;
  C.validate(p);
  return { p, assets: { bg1, bg2, yuu, yuuSmile, che } };
}

/* 读取舞台真实状态：内层 frame 的位移/缩放/透明度 + 图片地址。
   位移按舞台宽度换算成百分比再比对——编辑器和播放器的舞台宽度不同，
   直接比像素会把「同一状态」误判成两个结果。 */
const READ_STAGE = `(() => {
  const box = document.querySelector('#layersCanvas') || document.querySelector('#layers');
  if (!box) return [];
  const r = box.getBoundingClientRect();
  const W = r.width || 1, H = r.height || 1;
  return [...box.querySelectorAll('.visual-layer')].map(w => {
    const inner = w.querySelector('.pf-frame');
    const img = w.querySelector('img');
    const cs = inner ? getComputedStyle(inner) : null;
    const m = inner ? /translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)\\s*scale\\(([-0-9.]+)\\)/.exec(inner.style.transform) : null;
    return {
      layer: w.dataset.layer,
      display: getComputedStyle(w).display,
      opacity: cs ? Number(cs.opacity) : null,
      transform: inner ? inner.style.transform : '',
      dxPct: m ? Number(m[1]) / W * 100 : 0,
      dyPct: m ? Number(m[2]) / H * 100 : 0,
      scale: m ? Number(m[3]) : 1,
      src: img ? img.src.slice(-40) : '',
      srcFull: img ? img.src : '',
      imgLoaded: !!(img && img.complete && img.naturalWidth > 0)
    };
  });
})()`;

/* 背景故障诊断：只在断言失败时执行，把状态机结果与 DOM 现状一起报出来 */
const DIAG_BG = [
  '(() => {',
  '  const P = window.__pvnM3.project();',
  '  const n = P.nodes[1];',
  '  const acts = n.performance ? n.performance.actions : [];',
  '  const layers = C.stage(P, n.id, [P.nodes[0].id]);',
  '  const st = PF.stateAt(PF.emptyState(), acts, Infinity, { P: P, layers: layers });',
  '  const box = document.querySelector("#layersCanvas");',
  '  const w = box.querySelector(".visual-layer[data-layer=ly_bg]");',
  '  const img = w ? w.querySelector("img") : null;',
  '  const before = img ? img.getAttribute("src") : "";',
  '  PF.applyDOM(box, layers, st, { P: P });',
  '  return {',
  '    acts: acts.map(a => a.type + ":" + a.target),',
  '    before: before, after: img ? img.getAttribute("src") : "",',
  '    parent: img && img.parentElement ? img.parentElement.className : "",',
  '    frame: !!(w && w.querySelector(".pf-frame")),',
  '    state: st.layers.ly_bg, layers: layers.map(l => l.id + ":" + l.asset),',
  '    assets: (P.assets || []).map(a => a.id + "=" + String(a.data).slice(-14)),',
  '    perf: window.__pvnM3.perfCount()',
  '  };',
  '})()'
].join('\n');

(async () => {
  const built = buildProject();
  createStore().createProject(PROJECT, built.p);
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: built.p.title, openedAt: new Date().toISOString() }]
  }));

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + USER_DATA], { cwd: ROOT, stdio: 'ignore', env });
  let editor, preview;
  try {
    const page = await waitPage(port, (u) => u.startsWith('paper://app/'));
    if (!page) throw new Error('编辑器窗口未出现');
    editor = await connect(page.webSocketDebuggerUrl);
    for (let i = 0; i < 80; i++) { if (await editor.ev(`!!window.__pvnM3 && document.querySelectorAll('#list .node').length > 0`)) break; await sleep(250); }
    const boot = await editor.ev(`window.__pvnM3.metrics()`);
    ok('真实窗口启动', boot);

    /* 1. 编辑器面板确实渲染出三条动作 */
    const panel = await editor.ev(`(() => ({
      count: document.querySelector('#perfCount').textContent,
      rows: [...document.querySelectorAll('#perfList .perf-row')].map(r => r.innerText.replace(/\\s+/g,' ').trim()),
      presets: [...document.querySelectorAll('#perfPresets button')].map(b => b.textContent)
    }))()`);
    if (panel.count !== '3' || panel.rows.length !== 3) throw new Error('演出面板没有渲染动作：' + JSON.stringify(panel));
    if (panel.presets.length !== 7) throw new Error('预设数量应为 7，实际 ' + panel.presets.length);
    ok('演出面板渲染（3 条动作 / 7 个预设）', { rows: panel.rows, presets: panel.presets.length });

    /* 演出面板取证：展开并把面板滚到视口中央，截图里能直接读到动作与预设 */
    await editor.ev(`(() => { const d = document.querySelector('#performancePanel'); d.open = true; d.scrollIntoView({ block: 'center' }); return true })()`);
    await sleep(250);
    report.screenshotPanel = path.relative(ROOT, await editor.shot(path.join(SHOTS, 'v080-performance-panel.png')));
    if (report.screenshotPanel) ok('演出面板截图', report.screenshotPanel);

    /* 2. 试玩：阻塞演出期间点击不推进，但把动画结算到终态 */
    await editor.ev(`window.__pvnM3.play()`);
    await sleep(120);
    const early = await editor.ev(READ_STAGE);
    const yuuEarly = early.find((x) => x.layer === 'ly_yuu');
    if (!yuuEarly || !(yuuEarly.opacity < 0.9)) throw new Error('角色出现没有从透明开始：' + JSON.stringify(yuuEarly));
    const posBefore = await editor.ev(`document.querySelector('#position').textContent`);
    await editor.ev(`window.__pvnM3.advance()`);
    await sleep(120);
    const posAfter = await editor.ev(`document.querySelector('#position').textContent`);
    if (posBefore !== posAfter) throw new Error('阻塞演出未播完就推进了剧情：' + posBefore + ' → ' + posAfter);
    const settled = await editor.ev(READ_STAGE);
    const yuuSettled = settled.find((x) => x.layer === 'ly_yuu');
    if (!yuuSettled || Math.abs(yuuSettled.opacity - 1) > 0.02) throw new Error('跳过演出后角色没有到终态：' + JSON.stringify(yuuSettled));
    ok('阻塞演出：点击先结算再放行（不跳句）', { opacityEarly: yuuEarly.opacity, opacitySettled: yuuSettled.opacity, transform: yuuSettled.transform });

    /* 3. 再点一次才进入第二句，并播放背景转场 / 表情 / 镜头 */
    await editor.ev(`window.__pvnM3.advance()`);
    /* 转场进行中：交叉淡化必须真的有一个在上层淡入的旧/新图，而不是瞬间换图 */
    await sleep(320);
    const mid = await editor.ev(`(() => {
      const host = document.querySelector('#stage') || document.querySelector('#scene');
      const ghost = host.querySelector(':scope > .pf-bg-ghost');
      return { ghost: !!ghost, opacity: ghost ? Number(getComputedStyle(ghost).opacity) : -1,
               bg: (document.querySelector('#layersCanvas .visual-layer[data-layer=ly_bg] img') || {}).src || '' };
    })()`);
    await sleep(1800);
    const n2 = await editor.ev(READ_STAGE);
    /* 桌面工程里的素材地址是 paper:// 受控 URL，不是原始 data URI：
       用「文件名」比对，paper:// / pvres:// / papergame:// / data: 都能通用。 */
    const live = await editor.ev('window.__pvnM3.project()');
    const fileOf = (id) => String(((live.assets.find((a) => a.id === id) || {}).data) || '').split('/').pop();
    const nightFile = fileOf('a_bg_night'), smileFile = fileOf('a_yuu_smile');
    const bgLayer = n2.find((x) => x.layer === 'ly_bg');
    const yuu2 = n2.find((x) => x.layer === 'ly_yuu');
    if (!bgLayer || bgLayer.srcFull.split('/').pop() !== nightFile) {
      const diag = await editor.ev(DIAG_BG);
      throw new Error('背景没有切到夜晚素材：' + JSON.stringify(diag));
    }
    if (!yuu2 || yuu2.srcFull.split('/').pop() !== smileFile) {
      throw new Error('表情没有切换到微笑：' + (yuu2 && yuu2.srcFull));
    }
    const cam = await editor.ev(`getComputedStyle(document.querySelector('#layersCanvas')).transform`);
    if (!/matrix/.test(cam)) throw new Error('镜头缩放没有生效：' + cam);
    const camScale = await editor.ev(`(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('#layersCanvas')).transform); return m.a; })()`);
    if (!(camScale > 1.05 && camScale < 1.15)) throw new Error('镜头缩放数值不对：' + camScale);
    ok('第二句：背景交叉淡化 + 表情切换 + 镜头推进', {
      midGhost: mid.ghost, midGhostOpacity: mid.opacity, bg: bgLayer.src, expr: yuu2.src, camScale
    });
    await editor.ev(`window.scrollTo(0, 0)`);
    await sleep(250);
    report.screenshotEditor = path.relative(ROOT, await editor.shot(path.join(SHOTS, 'v080-performance-editor.png')));

    /* 4. 完整预览：同一句的终态必须与编辑器一致 */
    await editor.ev(`document.querySelector('#fullPreview').click()`);
    const previewPage = await waitPage(port, (u) => u.startsWith('pvres://'), 60000);
    if (!previewPage) throw new Error('预览窗口未出现');
    preview = await connect(previewPage.webSocketDebuggerUrl);
    for (let i = 0; i < 120; i++) { if (await preview.ev(`!!document.getElementById('startGame')`)) break; await sleep(200); }
    await preview.ev(`document.getElementById('startGame').click()`);
    await sleep(200);
    if (await preview.ev(`(() => { const p=document.querySelector('#hint'); return p && /演出中/.test(p.textContent) })()`) !== true) {
      throw new Error('预览端阻塞演出没有提示');
    }
    await preview.ev(`document.getElementById('scene').click()`);
    await sleep(150);
    await preview.ev(`document.getElementById('scene').click()`);
    await sleep(2200);
    const pv = await preview.ev(READ_STAGE);
    const pvBg = pv.find((x) => x.layer === 'ly_bg');
    const pvYuu = pv.find((x) => x.layer === 'ly_yuu');
    if (!pvBg || pvBg.srcFull.split('/').pop() !== nightFile) throw new Error('预览端背景不一致：' + (pvBg && pvBg.srcFull));
    if (!pvYuu) throw new Error('预览端没有角色图层');
    if (Math.abs(pvYuu.dxPct - yuu2.dxPct) > 0.4) throw new Error('预览端角色位置与编辑器不一致：' + pvYuu.dxPct + '% vs ' + yuu2.dxPct + '%');
    if (Math.abs(pvYuu.scale - yuu2.scale) > 0.01) throw new Error('预览端角色缩放与编辑器不一致：' + pvYuu.scale + ' vs ' + yuu2.scale);
    if (Math.abs(pvYuu.opacity - 1) > 0.02) throw new Error('预览端角色透明度不是终态：' + pvYuu.opacity);
    const pvCam = await preview.ev(`(() => { const m = new DOMMatrix(getComputedStyle(document.getElementById('layers')).transform); return m.a; })()`);
    if (Math.abs(pvCam - camScale) > 0.02) throw new Error('预览端镜头与编辑器不一致：' + pvCam + ' vs ' + camScale);
    report.screenshotPreview = path.relative(ROOT, await preview.shot(path.join(SHOTS, 'v080-performance-preview.png')));
    ok('编辑器与发布运行时终态一致', { editorDxPct: yuu2.dxPct, previewDxPct: pvYuu.dxPct, scale: pvYuu.scale, camera: pvCam });

    /* 5. 存档 → 返回标题 → 继续游戏：舞台按 trail 重建，不需要再播动画 */
    await preview.ev(`(() => { document.getElementById('menuBtn').click(); document.getElementById('save').click(); document.getElementById('menuTitle').click(); return true })()`);
    await sleep(400);
    const contReady = await preview.ev(`!document.getElementById('continueGame').disabled`);
    if (contReady !== true) throw new Error('存档后「继续游戏」仍不可用');
    await preview.ev(`document.getElementById('continueGame').click()`);
    await sleep(700);
    const loaded = await preview.ev(READ_STAGE);
    const lYuu = loaded.find((x) => x.layer === 'ly_yuu');
    const lBg = loaded.find((x) => x.layer === 'ly_bg');
    if (!lYuu) throw new Error('读档后没有角色图层');
    if (Math.abs(lYuu.dxPct - yuu2.dxPct) > 0.4) throw new Error('读档后角色状态没有恢复：' + JSON.stringify(lYuu));
    if (Math.abs(lYuu.scale - yuu2.scale) > 0.01) throw new Error('读档后角色缩放没有恢复：' + lYuu.scale);
    if (!lBg || lBg.srcFull.split('/').pop() !== nightFile) throw new Error('读档后背景没有恢复：' + (lBg && lBg.srcFull));
    ok('读档重建舞台状态（无动画回放）', { dxPct: lYuu.dxPct, bg: lBg.src });

    /* 6. 第三句：全屏渐暗只作用于舞台，不遮挡对话框；跳过与播完同一个终态 */
    await preview.ev(`document.getElementById('scene').click()`);
    await sleep(120);
    await preview.ev(`document.getElementById('scene').click()`);
    await sleep(900);
    const fade = await preview.ev(`(() => {
      const host = document.querySelector('#scene') || document.querySelector('#stage');
      const dim = host.querySelector(':scope > .pf-dim');
      const line = document.getElementById('text');
      const r = line ? line.getBoundingClientRect() : null;
      const hit = r ? document.elementFromPoint(r.left + 8, r.top + 8) : null;
      return { dim: dim ? Number(getComputedStyle(dim).opacity) : -1,
               textVisible: !!(line && line.textContent.length), textOnTop: !!(hit && line.contains(hit)) };
    })()`);
    if (!(fade.dim > 0.95)) throw new Error('全屏渐暗没有到终态：' + JSON.stringify(fade));
    if (!fade.textVisible || !fade.textOnTop) throw new Error('渐暗遮罩盖住了对话框：' + JSON.stringify(fade));
    const pos3 = await preview.ev(`document.getElementById('text').textContent`);
    if (!/灯还亮着/.test(pos3)) throw new Error('第三句没有进入：' + pos3);
    ok('全屏渐暗只作用舞台，对话框仍在最上层', fade);
    preview.close();
    await editor.ev(`window.PaperHost.closePreview()`);
  } catch (e) {
    bad('performance-window', e.message);
  } finally {
    if (preview) preview.close();
    if (editor) editor.close();
    try { killTree(proc.pid); } catch {}
    fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'release', 'performance-window-smoke.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 1));
    process.exit(report.ok ? 0 : 1);
  }
})();
