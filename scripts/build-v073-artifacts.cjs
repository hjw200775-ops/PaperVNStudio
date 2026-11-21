'use strict';
/* 生成 V0.7.3 交付物：独立 HTML 试玩版 + Windows 游戏包（ZIP，含被引用的 3 首 BGM）。
 * 用法：node_modules/electron/dist/electron.exe scripts/build-v073-artifacts.cjs */
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'desktop', 'project-store.cjs'))();
const builder = require(path.join(ROOT, 'desktop', 'game-builder.cjs'))({
  repoRoot: ROOT, execPath: process.execPath, resourcesPath: process.resourcesPath, isPackaged: false
});
const { buildPlayerHTML } = require(path.join(ROOT, 'dist', 'game-html.js'));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const sampleDir = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
  const project = store.openProject(sampleDir).project;

  /* 1. 独立 HTML 试玩版 */
  const htmlDir = path.join(ROOT, 'release', 'html');
  fs.mkdirSync(htmlDir, { recursive: true });
  const audioReport = {};
  const html = buildPlayerHTML(project, undefined, audioReport);
  const htmlFile = path.join(htmlDir, '晚风经过二楼走廊-0.7.3-试玩版.html');
  fs.writeFileSync(htmlFile, html, 'utf8');
  console.log('HTML ' + htmlFile + ' ' + html.length + ' bytes');
  console.log('AUDIO included=' + audioReport.audio.included.length + ' excluded=' + audioReport.audio.excluded.length);

  /* 2. Windows 游戏包（ZIP 解压版，内含真实 EXE） */
  const outDir = path.join(ROOT, 'release', 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const result = await builder.build({
    project, type: 'zip', outDir, overwrite: true,
    onProgress: p => { if (p.percent % 20 < 4) console.log('  [' + Math.round(p.percent) + '%] ' + p.label); },
    isCancelled: () => false
  }, { nativeImage });
  console.log('GAME ' + result.artifact);
  console.log('BYTES ' + result.bytes + ' SHA ' + result.sha256 + ' EXE ' + result.exeName);
  app.exit(0);
}).catch(e => { console.error('FAIL ' + (e && e.stack || e)); app.exit(1); });
