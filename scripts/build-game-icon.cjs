'use strict';
/*
 * 生成 Windows 应用图标：game/icon/icon.svg → game/build-resources/icon.ico
 *
 *   node scripts/build-game-icon.cjs
 *
 * 图标是矢量源文件，用 Electron 自己按 16–256 逐档渲染成 PNG，再打包成多尺寸 ICO
 * （Vista 起 ZIP 容器里的 ICO 允许每档存 PNG）。不需要装 ImageMagick，也不引入依赖。
 * 渲染时检查四角 alpha：透明通道丢了会立刻报错，而不是产出一张带白角的图标。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'game', 'icon', 'icon.svg');
const OUT_DIR = path.join(ROOT, 'game', 'build-resources');
const OUT_ICO = path.join(OUT_DIR, 'icon.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/* ---------------- 在 Electron 里渲染 ---------------- */

if (process.versions.electron) {
  const { app, BrowserWindow, nativeImage } = require('electron');
  const outDir = process.argv[3];
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const svg = fs.readFileSync(SVG_PATH, 'utf8');
    const win = new BrowserWindow({
      width: 320, height: 320, show: false, frame: false, transparent: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    win.setBackgroundColor('#00000000');
    await win.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>');

    /* 用 canvas 逐档重采样：窗口尺寸不变，避免截图与缩放抢帧导致边缘脏像素。 */
    const encoded = await win.webContents.executeJavaScript(`(async () => {
      const svg = ${JSON.stringify(svg)};
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('SVG 解码失败'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
      const out = {};
      for (const size of ${JSON.stringify(SIZES)}) {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        out[size] = canvas.toDataURL('image/png').split(',')[1];
      }
      return out;
    })()`);

    const problems = [];
    for (const size of SIZES) {
      const buf = Buffer.from(encoded[String(size)] || encoded[size] || '', 'base64');
      if (!buf.length) { problems.push(size + 'px 没有渲染结果'); continue; }
      const file = path.join(outDir, size + '.png');
      fs.writeFileSync(file, buf);

      /* 角上允许有圆角的抗锯齿半透明，但不能整块不透明；中心必须实心。 */
      const image = nativeImage.createFromBuffer(buf);
      const { width, height } = image.getSize();
      if (width !== size || height !== size) { problems.push(size + 'px 实际 ' + width + 'x' + height); continue; }
      const bmp = image.toBitmap();
      const alphaAt = (x, y) => bmp[(y * width + x) * 4 + 3];
      const corners = [alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)];
      const center = alphaAt(Math.floor(width / 2), Math.floor(height / 2));
      if (Math.max(...corners) > 200) problems.push(size + 'px 四角太实（alpha ' + corners.join('/') + '）');
      if (center < 250) problems.push(size + 'px 中心不实心（alpha ' + center + '）');
    }
    win.destroy();
    if (problems.length) {
      console.error('ICON RENDER FAIL ' + problems.join('；'));
      app.exit(1);
      return;
    }
    console.log('ICON RENDER OK ' + SIZES.join(', '));
    app.exit(0);
  }).catch(e => { console.error('ICON RENDER ERROR ' + e.message); app.exit(1); });
} else {
/* ---------------- 普通 Node：驱动 Electron、拼 ICO ---------------- */

  if (!fs.existsSync(SVG_PATH)) throw new Error('缺少图标源文件：' + SVG_PATH);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-icon-'));
  const electron = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    const r = spawnSync(electron, [__filename, '--render', tmp], { env, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error('图标渲染失败，Electron 退出码 ' + r.status);

    const entries = SIZES.map(size => {
      const file = path.join(tmp, size + '.png');
      if (!fs.existsSync(file)) throw new Error('缺少 ' + size + 'px 渲染结果');
      return { size, buf: fs.readFileSync(file) };
    });
    const ico = buildIco(entries);
    fs.writeFileSync(OUT_ICO, ico);
    console.log('ICON OK ' + OUT_ICO + '（' + entries.length + ' 档，' + (ico.length / 1024).toFixed(1) + ' KB）');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响产物 */ }
  }
}

/* 多尺寸 ICO：每档一个 PNG 段（Vista 起支持），宽度/高度 256 记作 0。 */
function buildIco(entries) {
  const sorted = entries.slice().sort((a, b) => a.size - b.size);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sorted.length, 4);
  const dirs = [];
  const blobs = [];
  let offset = 6 + 16 * sorted.length;
  for (const { size, buf } of sorted) {
    const d = Buffer.alloc(16);
    d.writeUInt8(size >= 256 ? 0 : size, 0);
    d.writeUInt8(size >= 256 ? 0 : size, 1);
    d.writeUInt8(0, 2);                 /* 调色板数 */
    d.writeUInt8(0, 3);                 /* 保留 */
    d.writeUInt16LE(1, 4);              /* 色平面 */
    d.writeUInt16LE(32, 6);             /* 位深 */
    d.writeUInt32LE(buf.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    blobs.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}
