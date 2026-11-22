'use strict';
/* 用大型合成工程真实导出「独立游戏目录」与 ZIP 发布包，记录体积与耗时。
 * node_modules/electron/dist/electron.exe scripts/export-large.cjs [--type folder|zip|both] */
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'F:/pvn-large-project';
const OUT = path.join(ROOT, 'release', 'exports');
const TYPE = (() => {
  const i = process.argv.indexOf('--type');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'folder';
})();

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'desktop', 'project-store.cjs'))();
  const builder = require(path.join(ROOT, 'desktop', 'game-builder.cjs'))({
    repoRoot: ROOT, execPath: process.execPath, resourcesPath: process.resourcesPath, isPackaged: false
  });
  const project = store.openProject(PROJECT).project;
  fs.mkdirSync(OUT, { recursive: true });

  const types = TYPE === 'both' ? ['folder', 'zip'] : [TYPE];
  for (const type of types) {
    const t0 = Date.now();
    const r = await builder.build({
      project, type, outDir: OUT, overwrite: true,
      onProgress: p => { if (p.percent % 25 < 3) console.log('  [' + Math.round(p.percent) + '%] ' + p.label + (p.detail ? ' · ' + p.detail : '')); },
      isCancelled: () => false
    }, { nativeImage });
    const manifest = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
    console.log(JSON.stringify({
      type, artifact: r.artifact, exeName: r.exeName,
      bytes: r.bytes, mb: +(r.bytes / 1048576).toFixed(1),
      sha256: r.sha256, ms: Date.now() - t0,
      resources: manifest.resources, pages: manifest.artifact
    }, null, 1));
  }
  app.exit(0);
}).catch(e => { console.error('FAIL ' + ((e && e.stack) || e)); app.exit(1); });
