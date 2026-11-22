'use strict';
/* 连已运行的编辑器：改一句台词 → 保存 → 重载 → 检查素材仍可读。
 * 用法：node scripts/cdp-save-probe.cjs <port> <工程目录> */
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.argv[2] || 9335);
const DIR = path.resolve(process.argv[3] || 'dist/samples/wanfeng-ch01');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && String(t.url).startsWith('paper://'));
  if (!page) throw new Error('没有编辑器页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP 超时')), 10000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); };
  });
  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const s = pending.get(m.id); if (!s) return;
    pending.delete(m.id);
    if (m.error) s.reject(new Error(m.error.message)); else s.resolve(m.result);
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

  const marker = '素材往返 · ' + Date.now().toString().slice(-5);
  const edited = await ev(`(() => {
    const box = document.getElementById('body');
    if (!box) return 'no-text-box';
    box.value = ${JSON.stringify(marker)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(500);
  await ev(`document.getElementById('save').click()`);
  await sleep(3000);

  const disk = JSON.parse(fs.readFileSync(path.join(DIR, 'project.paper.json'), 'utf8'));
  const saved = (disk.nodes || []).find(n => n.text === marker);
  const hasData = JSON.stringify(disk).includes('data:image');

  await ev(`location.reload()`).catch(() => {});
  await sleep(3000);
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await ev(`document.querySelectorAll('#list .node').length > 0`).catch(() => false);
    if (!ready) await sleep(300);
  }
  const after = await ev(`(() => {
    const imgs = [...document.querySelectorAll('#layersCanvas img, #layers img')];
    return { loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
      scheme: imgs[0] ? String(imgs[0].src).slice(0, 40) : '' };
  })()`).catch(() => null);

  const out = { edited, marker, savedOnDisk: !!saved, diskHasDataUrl: hasData, reopened: after };
  out.ok = edited === 'ok' && !!saved && !hasData && after && after.loaded > 0;
  fs.writeFileSync('release/cdp-save-probe.json', JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 1));
  ws.close();
  process.exit(out.ok ? 0 : 1);
})().catch(e => { console.error('FAIL ' + ((e && e.message) || e)); process.exit(1); });
