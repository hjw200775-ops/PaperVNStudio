'use strict';
/*
 * 准备随纸间分发的构建组件（V0.7.2 通用导出）。
 *
 *   node scripts/prepare-game-toolchain.cjs
 *
 * 从本机已有缓存里收集，不联网下载：
 *   - NSIS（makensis + Stubs/Plugins/Include）：electron-builder 下载过的组件缓存；
 *   - rcedit：electron-winstaller 自带的官方 rcedit。
 * 结果放 vendor/toolchain/，打包纸间时通过 extraResources 进 resources/toolchain，
 * 用户导出游戏时就能离线构建，不需要 npm、Node 或开发机路径。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'toolchain');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function cacheRoots() {
  const roots = [];
  if (process.env.ELECTRON_BUILDER_CACHE) roots.push(process.env.ELECTRON_BUILDER_CACHE);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  roots.push(path.join(local, 'electron-builder', 'Cache'));
  return roots.filter(p => fs.existsSync(p));
}

function findNsis() {
  for (const root of cacheRoots()) {
    for (const name of fs.readdirSync(root)) {
      if (!/^nsis-3\./.test(name)) continue;
      const base = path.join(root, name);
      if (!fs.statSync(base).isDirectory()) continue;
      for (const sub of fs.readdirSync(base)) {
        const candidate = path.join(base, sub);
        if (fs.existsSync(path.join(candidate, 'makensis.exe'))) {
          return { dir: candidate, version: name.replace(/^nsis-/, '') };
        }
      }
    }
  }
  return null;
}

function findRcedit() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function copyDir(src, dest, skip = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip.includes(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function sizeOf(dir) {
  let total = 0;
  const walk = d => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

function main() {
  const nsis = findNsis();
  const rcedit = findRcedit();
  const problems = [];
  if (!nsis) problems.push('没有找到 NSIS 缓存（electron-builder 下载目录），单文件便携版将不可用');
  if (!rcedit) problems.push('没有找到 rcedit（node_modules/electron-winstaller），无法写入图标与版本信息');
  if (problems.length) {
    console.error('TOOLCHAIN FAIL\n  - ' + problems.join('\n  - '));
    console.error('\n提示：先在开发机上跑一次 `npm run build:win:portable` 让 electron-builder 下载 NSIS，再重试。');
    process.exit(2);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'nsis'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'rcedit'), { recursive: true });

  /* 只带 Windows 需要的部分：linux/mac 目录与示例脚本不带，省 ~8MB。 */
  copyDir(nsis.dir, path.join(OUT, 'nsis'), ['linux', 'mac', 'Menu', 'Contrib', 'Docs', 'Examples']);
  fs.copyFileSync(rcedit, path.join(OUT, 'rcedit', 'rcedit-x64.exe'));

  const makensis = path.join(OUT, 'nsis', 'makensis.exe');
  const probe = spawnSync(makensis, ['/VERSION'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) {
    console.error('TOOLCHAIN FAIL：makensis 无法运行：' + ((probe.stdout || probe.stderr || '').trim()));
    process.exit(2);
  }

  const meta = {
    format: 'papervn-toolchain',
    formatVersion: 1,
    nsis: { version: nsis.version, binary: 'nsis/makensis.exe', selfReported: (probe.stdout || '').trim() },
    rcedit: { version: 'vendor', binary: 'rcedit/rcedit-x64.exe',
      sha256: sha256(fs.readFileSync(rcedit)) },
    preparedAt: new Date().toISOString(),
    note: '由 scripts/prepare-game-toolchain.cjs 从本机缓存收集；打包纸间时随 resources/toolchain 分发。'
  };
  fs.writeFileSync(path.join(OUT, 'toolchain.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log('TOOLCHAIN OK ' + OUT);
  console.log('  NSIS ' + nsis.version + ' · ' + (sizeOf(path.join(OUT, 'nsis')) / 1024 / 1024).toFixed(1) + ' MB');
  console.log('  rcedit ' + (fs.statSync(path.join(OUT, 'rcedit', 'rcedit-x64.exe')).size / 1024).toFixed(0) + ' KB');
  console.log('  总计 ' + (sizeOf(OUT) / 1024 / 1024).toFixed(1) + ' MB');
}

main();
