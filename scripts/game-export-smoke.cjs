'use strict';
/* 开发期快速验证：用真实 Electron 主进程跑一遍通用构建器（不上界面）。
 *   node_modules/electron/dist/electron.exe scripts/game-export-smoke.cjs zip
 *   node_modules/electron/dist/electron.exe scripts/game-export-smoke.cjs portable
 * 产物写到系统临时目录，只用于定位构建问题；正式验收走 game-export-acceptance.cjs。 */
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const os = require('node:os');

const createStore = require(path.join(ROOT, 'desktop', 'project-store.cjs'));
const createBuilder = require(path.join(ROOT, 'desktop', 'game-builder.cjs'));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const store = createStore();
  const sampleDir = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
  const disk = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.paper.json'), 'utf8'));
  store.validateDisk(disk);
  const project = store.diskToRuntime(sampleDir, disk);

  const builder = createBuilder({
    repoRoot: ROOT, execPath: process.execPath,
    resourcesPath: process.resourcesPath, isPackaged: false
  });
  console.log('TOOLCHAIN', JSON.stringify(builder.toolchain(), null, 1));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-export-out-'));
  const type = ['portable', 'folder'].includes(process.argv[2]) ? process.argv[2] : 'zip';
  try {
    const r = await builder.build({
      project, type, outDir, overwrite: true,
      onProgress: p => console.log('  [' + p.percent + '%] ' + p.label + (p.detail ? ' · ' + p.detail : '')),
      isCancelled: () => false
    }, { nativeImage });
    console.log('BUILD OK', JSON.stringify({ artifact: r.artifact, bytes: r.bytes, sha: r.sha256, stages: r.stages }, null, 1));
    app.exit(0);
  } catch (e) {
    console.error('BUILD FAIL', e.stack || e.message);
    app.exit(1);
  }
});
