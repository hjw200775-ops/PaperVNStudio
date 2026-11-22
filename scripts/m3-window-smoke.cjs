'use strict';
/*
 * V0.7.6-M3 真实 Electron 窗口冒烟：流式暂存 → 受控 URL 解码 → 保存落盘 → 预览。
 * 不靠 Node 模拟渲染；所有素材可见性与协议加载都在真实窗口里验证。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-m3-window-'));
const USER_DATA = path.join(WORK, 'user-data');
const PROJECT = path.join(WORK, 'project');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const report = { at: new Date().toISOString(), ok: true, stages: {}, problems: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d }; console.log('  ok  ' + n); };
const bad = (n, m) => { report.ok = false; report.problems.push(n + '：' + m); report.stages[n] = { ok: false, message: m }; console.log('  FAIL ' + n + ' — ' + m); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
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
async function httpJson(url, ms = 1500) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
async function waitPage(port, match, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find(x => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(250);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP 超时')), 12000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; };
  const shot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  return { send, ev, shot, close: () => { try { ws.close(); } catch {} } };
}

(async () => {
  const imagePath = path.join(WORK, 'stage-bg.png'), audioPath = path.join(WORK, 'stage-voice.wav');
  const imageBytes = png(640, 360, 7), audioBytes = wav(1);
  fs.writeFileSync(imagePath, imageBytes); fs.writeFileSync(audioPath, audioBytes);

  /* 预置一个空工程，让 bootstrap 自动打开它，保存时不再弹目录选择框。 */
  const seed = C.blank(); seed.title = 'M3 窗口验收'; seed.nodes.push(C.makeNode('say'));
  seed.nodes[0].paragraphId = seed.chapters[0].paragraphs[0].id;
  createStore().createProject(PROJECT, seed);
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: seed.title, openedAt: new Date().toISOString() }]
  }));

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + USER_DATA], { cwd: ROOT, stdio: 'ignore', env });
  let editor;
  try {
    const page = await waitPage(port, u => u.startsWith('paper://app/'));
    if (!page) throw new Error('编辑器窗口未出现');
    editor = await connect(page.webSocketDebuggerUrl);
    for (let i = 0; i < 60; i++) { if (await editor.ev(`!!window.__pvnM3 && document.querySelectorAll('#list .node').length > 0`)) break; await sleep(250); }
    const boot = await editor.ev(`window.__pvnM3.metrics()`);
    ok('真实窗口启动并打开工程', boot);

    /* 1. 主进程流式暂存：返回 URL + 哈希，不含 Base64。 */
    const staged = await editor.ev(`(async () => {
      const H = window.PaperHost;
      const imgs = await H.stageFiles({ kind:'image', files:${JSON.stringify([imagePath])}, multiple:true });
      const auds = await H.stageFiles({ kind:'audio', files:${JSON.stringify([audioPath])}, multiple:true });
      return { imgs, auds };
    })()`);
    if (!staged.imgs.files[0] || !staged.auds.files[0]) throw new Error('暂存未返回素材：' + JSON.stringify(staged));
    const img = staged.imgs.files[0], audio = staged.auds.files[0];
    if (/base64/i.test(JSON.stringify(staged))) throw new Error('暂存结果包含 Base64');
    if (!/^paper:\/\/app\/staging\/[a-f0-9]{64}\.png$/.test(img.dataUrl)) throw new Error('暂存 URL 无效：' + img.dataUrl);
    if (img.sha256 !== sha(imageBytes) || audio.sha256 !== sha(audioBytes)) throw new Error('哈希不一致');
    ok('asset:stage 流式导入（无 Base64、哈希正确）', { image: img.sha256.slice(0, 12), audio: audio.sha256.slice(0, 12) });

    /* 2. 在真实编辑器状态里引用暂存素材并渲染。 */
    const injected = await editor.ev(`(() => {
      const M = window.__pvnM3, q = M.project();
      const a = { id:'a_m3', name:'stage-bg.png', kind:'bg', data:${JSON.stringify(img.dataUrl)},
        sha256:${JSON.stringify(img.sha256)}, bytes:${imageBytes.length}, width:640, height:360 };
      const au = { id:'au_m3', name:'stage-voice', categories:['voice'], data:${JSON.stringify(audio.dataUrl)},
        sha256:${JSON.stringify(audio.sha256)}, bytes:${audioBytes.length}, mime:'audio/wav', ext:'wav', duration:1 };
      q.assets=[a]; q.audioAssets=[au]; q.titleBackground=a.id;
      q.nodes[0].sceneMode='own';
      q.nodes[0].layers.push({id:'l_m3',asset:a.id,name:a.name,kind:a.kind,x:0,y:0,w:100,h:100,
        fit:'contain',opacity:100,hidden:false,locked:false,motion:'none',characterId:'',expressionId:''});
      q.nodes[0].audio={ voice:{ audioId:au.id, volume:1 } };
      M.setProject(q); return M.metrics();
    })()`);
    if (!injected.assets) throw new Error('注入失败：' + JSON.stringify(injected));
    await sleep(600);
    const decoded = await editor.ev(`(async () => {
      const imgs=[...document.querySelectorAll('#layersCanvas img, #stage img')];
      let fetched=null,probe=null;
      if(imgs[0])try{
        const r=await fetch(imgs[0].src),buf=await r.arrayBuffer();
        fetched={status:r.status,type:r.headers.get('content-type'),bytes:buf.byteLength};
        const b64=btoa(String.fromCharCode.apply(null,new Uint8Array(buf).subarray(0,2048)));
        const test=src=>new Promise(res=>{const im=new Image();im.onload=()=>res({ok:true,w:im.naturalWidth});im.onerror=e=>res({ok:false,err:String(e&&e.type||e)});im.src=src});
        probe={url:await test(imgs[0].src),data:await test('data:image/png;base64,'+btoa(String.fromCharCode.apply(null,new Uint8Array(buf))))};
      }catch(e){fetched=String(e)}
      return { count:imgs.length, loaded:imgs.filter(i=>i.complete&&i.naturalWidth>0).length,
        urls:imgs.map(i=>String(i.src).slice(0,48)), metrics:window.__pvnM3.metrics(),
        natural:imgs.map(i=>i.naturalWidth), complete:imgs.map(i=>i.complete), fetched, probe };
    })()`);
    if (!decoded.loaded) throw new Error('暂存图片没有在真实窗口解码：' + JSON.stringify(decoded));
    ok('paper://app/staging 在真实窗口解码显示', { count: decoded.count, loaded: decoded.loaded,
      natural: decoded.natural, fetched: decoded.fetched, probe: decoded.probe });
    report.screenshotEditor = path.relative(ROOT, await editor.shot(path.join(SHOTS, 'v076-m3-staged-import.png')));

    /* 3. 保存：工程 JSON 只保留相对路径，素材复制进工程目录。 */
    const saved = await editor.ev(`(async () => { const r = await window.__pvnM3.save(); return r; })()`);
    if (!saved || saved.ok === false) throw new Error('保存失败：' + JSON.stringify(saved));
    const disk = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));
    if (JSON.stringify(disk).includes('base64,') || JSON.stringify(disk).includes('staging/')) throw new Error('磁盘工程仍含 Base64 或暂存地址');
    if (!fs.existsSync(path.join(PROJECT, disk.assets[0].file))) throw new Error('素材没有落盘');
    ok('保存后工程与素材一致（无 Base64 / 无暂存地址）', { file: disk.assets[0].file });

    /* 4. 完整预览：真实预览窗口按 pvres:// 加载刚导入的素材。 */
    await editor.ev(`document.querySelector('#fullPreview').click()`);
    const previewPage = await waitPage(port, u => u.startsWith('pvres://'), 40000);
    if (!previewPage) throw new Error('预览窗口未出现');
    const preview = await connect(previewPage.webSocketDebuggerUrl);
    for (let i = 0; i < 100; i++) { if (await preview.ev(`!!document.getElementById('startGame')`)) break; await sleep(200); }
    if (!await preview.ev(`!!document.getElementById('startGame')`)) throw new Error('预览页面没有就绪');
    await preview.ev(`document.getElementById('startGame').click()`);
    for (let i = 0; i < 60; i++) {
      if (await preview.ev(`(() => { const a=[...document.querySelectorAll('#layers img')];
        return a.length>0 && a.every(i=>i.complete&&i.naturalWidth>0); })()`)) break;
      await sleep(200);
    }
    const previewState = await preview.ev(`(() => {
      const imgs=[...document.querySelectorAll('#layers img')];
      return { count:imgs.length, loaded:imgs.filter(i=>i.complete&&i.naturalWidth>0).length,
        allPvres:imgs.length>0&&imgs.every(i=>String(i.src).startsWith('pvres://')),
        urls:imgs.map(i=>String(i.src).slice(0,56)), audio:(()=>{try{return paperGameState().audio}catch(e){return null}})() };
    })()`);
    if (!previewState.loaded || !previewState.allPvres) throw new Error('预览素材未加载：' + JSON.stringify(previewState));
    ok('完整预览窗口按需加载暂存素材', previewState);
    report.screenshotPreview = path.relative(ROOT, await preview.shot(path.join(SHOTS, 'v076-m3-preview.png')));
    preview.close();
    await editor.ev(`window.PaperHost.closePreview()`);
  } catch (e) {
    bad('m3-window-smoke', e.message);
  } finally {
    if (editor) editor.close();
    try { killTree(proc.pid); } catch {}
    fs.writeFileSync(path.join(ROOT, 'release', 'm3-window-smoke.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 1));
    process.exit(report.ok ? 0 : 1);
  }
})();

function killTree(pid) { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
