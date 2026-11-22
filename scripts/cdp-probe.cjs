'use strict';
/* 连上已在运行的编辑器（CDP），检查素材协议并截图。不自己启动 Electron。 */
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.argv[2] || 9333);
const OUT = process.argv[3] || 'docs/screenshots/v076-editor-assets.png';

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && String(t.url).startsWith('paper://'));
  if (!page) throw new Error('没有找到编辑器页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP 超时')), 10000);
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
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.text || ''));
    return r.result && r.result.value;
  };

  for (let i = 0; i < 40; i++) {
    if (await ev(`document.querySelectorAll('#list .node').length > 0`)) break;
    await sleep(300);
  }

  const out = {};
  out.nodes = await ev(`document.querySelectorAll('#list .node').length`);
  out.images = await ev(`(() => {
    const imgs = [...document.querySelectorAll('#layersCanvas img, #layers img')];
    return { count: imgs.length,
      loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
      allScheme: imgs.length > 0 && imgs.every(i => String(i.src).startsWith('paper://app/asset/')),
      sample: imgs[0] ? String(imgs[0].src).slice(0, 56) : '' };
  })()`);
  out.fetch = await ev(`(async () => {
    const img = document.querySelector('#layersCanvas img, #layers img');
    if (!img) return { note: 'no img' };
    try {
      const r = await fetch(img.src);
      return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
    } catch (e) { return { error: String(e) }; }
  })()`);
  out.host = await ev(`(async () => {
    const H = window.PaperHost || {};
    const keys = Object.keys(H);
    let status = null;
    try { status = H.bootstrap ? await H.bootstrap() : null; } catch (e) { status = String(e); }
    return { keys, status };
  })()`);
  out.projectSize = await ev(`(() => { try { return JSON.stringify(window.__probe || null).length; } catch { return -1; } })()`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const abs = path.resolve(OUT);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(shot.data, 'base64'));
  out.screenshot = OUT;
  out.ok = out.images.loaded > 0 && out.images.allScheme;

  fs.writeFileSync(path.resolve('release/cdp-probe.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 1));
  ws.close();
  process.exit(out.ok ? 0 : 1);
})().catch(e => { console.error('FAIL ' + ((e && e.message) || e)); process.exit(1); });
