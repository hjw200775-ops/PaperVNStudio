'use strict';
/*
 * V0.8.0 · Windows x64 可运行版本（免安装目录版）。
 *
 * 为什么不用 electron-builder：本机运行环境的 node 被注入了 safe-delete 钩子，
 * electron-builder 解包时会 fs.rm 临时目录，被钩子拦成「回收站失败」而中断。
 * 这里直接组装 Electron 运行时目录，产物同样是「双击 exe 就能跑」的独立程序：
 *
 *   release/PaperVNStudio-<version>-win-x64/
 *     PaperVNStudio.exe          ← electron.exe 改名
 *     resources/app/             ← dist/ + desktop/ + package.json（不打包 asar，便于核对）
 *
 * 用法：node scripts/build-win-dir.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'release', 'PaperVNStudio-' + pkg.version + '-win-x64');

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (filter && !filter(e.name, e)) continue;
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst, filter);
    else fs.copyFileSync(src, dst);
  }
}

function main() {
  if (!fs.existsSync(path.join(ELECTRON_DIR, 'electron.exe'))) {
    throw new Error('找不到 Electron 运行时，请先 npm install：' + ELECTRON_DIR);
  }
  /* 递归删旧产物会被本机注入的 safe-delete 钩子拦下（上千文件需要人工确认）。
     重命名让路即可，旧目录由构建者自行清理。 */
  if (fs.existsSync(OUT)) {
    const prev = OUT + '.old-' + Date.now();
    fs.renameSync(OUT, prev);
    console.log('  旧产物已改名为 ' + path.basename(prev));
  }
  fs.mkdirSync(OUT, { recursive: true });

  /* 1) Electron 运行时本体（去掉默认应用与调试符号） */
  const skip = new Set(['default_app.asar', 'resources']);
  for (const e of fs.readdirSync(ELECTRON_DIR, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    if (e.name.endsWith('.pdb')) continue;
    const src = path.join(ELECTRON_DIR, e.name), dst = path.join(OUT, e.name);
    if (e.isDirectory()) copyDir(src, dst, (n) => !n.endsWith('.pdb'));
    else fs.copyFileSync(src, dst);
  }
  /* Electron 自带 locales / *.pak 已随上一步复制；resources 单独处理 */
  fs.mkdirSync(path.join(OUT, 'resources'), { recursive: true });

  /* 2) 应用本体：只带运行需要的目录，不带测试、脚本、素材与备份 */
  const appDir = path.join(OUT, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  copyDir(path.join(ROOT, 'dist'), path.join(appDir, 'dist'), (n) => !n.endsWith('.map'));
  copyDir(path.join(ROOT, 'desktop'), path.join(appDir, 'desktop'), (n) => n !== 'build-resources' && !n.endsWith('.pdb'));
  /* 导出目录版游戏要用到 vendor/toolchain（rcedit、图标合成）。漏掉它，
     用户手里的编辑器会在「发行」面板报「缺少 rcedit 构建组件」——本轮实际踩到过。 */
  if (fs.existsSync(path.join(ROOT, 'vendor'))) {
    copyDir(path.join(ROOT, 'vendor'), path.join(appDir, 'vendor'), (n) => !n.endsWith('.pdb'));
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
  if (fs.existsSync(path.join(ROOT, 'LICENSE'))) fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(appDir, 'LICENSE'));

  /* 3) 可执行文件改名：Windows 上用户只会看到这一个入口 */
  const exe = path.join(OUT, 'PaperVNStudio.exe');
  fs.renameSync(path.join(OUT, 'electron.exe'), exe);

  /* 4) 统计与清单 */
  let bytes = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { bytes += fs.statSync(f).size; files++; }
    }
  };
  walk(OUT);
  const manifest = {
    at: new Date().toISOString(), product: 'PaperVNStudio', version: pkg.version, versionLabel: pkg.versionLabel,
    platform: 'win32-x64', electron: require('electron/package.json').version,
    exe: path.relative(ROOT, exe).replace(/\\/g, '/'), bytes, files,
    note: '免安装目录版：解压后双击 PaperVNStudio.exe。运行时为官方 Electron，应用代码在 resources/app/。'
  };
  fs.writeFileSync(path.join(OUT, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'release', 'portable-dir-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify(manifest, null, 1));
}

main();
