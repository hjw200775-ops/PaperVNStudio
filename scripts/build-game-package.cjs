'use strict';
/*
 * 《晚风经过二楼走廊》Windows x64 发布包构建（V0.7 正式版）。
 *
 *   node scripts/build-game-package.cjs          # 出 ZIP + 单文件便携 EXE + 清单
 *   node scripts/build-game-package.cjs --prune  # 先删掉更早的中间产物，再构建
 *
 * 做法：把 dist/samples/wanfeng-ch01 的工程用现有 dist/game-html.js 生成自包含 HTML，
 * 塞进 game/ 这个独立播放器壳，用现有 Electron + electron-builder 同时打出
 * win-unpacked（→ ZIP）与单文件 portable EXE。
 *
 * 离线：Electron 本体用 node_modules/electron/dist，不下载；NSIS 组件（单文件便携版要用）
 * 走 npmmirror 镜像，可用 ELECTRON_BUILDER_BINARIES_MIRROR 覆盖。
 *
 * 签名：设置 CSC_LINK（.pfx/.p12 路径）与 CSC_KEY_PASSWORD 即可由 electron-builder 签名；
 * 没设置时如实跳过，并在清单里写明 signed=false，绝不伪造「已签名」。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { listZipEntries } = require('./zip-manifest.cjs');
const { writeZip } = require('./zip-writer.cjs');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const GAME_SRC = path.join(ROOT, 'game');
const OUT_ROOT = path.join(ROOT, 'release', 'game');
const STAGE = path.join(OUT_ROOT, 'stage');
/* 每次构建都用一个全新的工作目录：解包产物 300MB+，覆盖式重建要整目录删除，
 * 在受限环境里会被安全删除策略拦下。用新目录 + --prune 显式清理，行为可预测。 */
const WORK_ROOT = path.join(OUT_ROOT, 'build');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = path.join(WORK_ROOT, RUN_STAMP);
const BUILD_OUT = path.join(RUN_DIR, 'out');
const PKG_ROOT = path.join(RUN_DIR, 'pkg');

const gamePkg = JSON.parse(fs.readFileSync(path.join(GAME_SRC, 'package.json'), 'utf8'));
const SLUG = 'wanfeng-ch01';
const GAME_TITLE = '晚风经过二楼走廊';
const EXE_NAME = GAME_TITLE + '.exe';
const VERSION = gamePkg.version;
const ZIP_BASENAME = GAME_TITLE + '-' + VERSION + '-win-x64-独立试玩包';
const PORTABLE_NAME = GAME_TITLE + '-' + VERSION + '-win-x64-单文件便携版.exe';
const ICON_REL = path.join('build-resources', 'icon.ico');

const store = require('../desktop/project-store.cjs')();
const { buildPlayerHTML } = require('../dist/game-html.js');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
const step = text => console.log('[game] ' + text);

const PRUNE = process.argv.includes('--prune');

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push({ path: path.relative(base, abs).replace(/\\/g, '/'), bytes: st.size });
  }
  return out;
}

function pruneOldBuilds() {
  /* 早期版本把构建目录固定成 out/ 与 pkg/，一并按旧目录清理。 */
  const targets = [path.join(OUT_ROOT, 'out'), path.join(OUT_ROOT, 'pkg')];
  if (fs.existsSync(WORK_ROOT)) {
    for (const name of fs.readdirSync(WORK_ROOT)) targets.push(path.join(WORK_ROOT, name));
  }
  let freed = 0;
  for (const abs of targets) {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    try {
      freed += walk(abs).reduce((s, f) => s + f.bytes, 0);
      fs.rmSync(abs, { recursive: true, force: true });
    } catch (e) {
      console.log('[game] 无法清理 ' + abs + '：' + e.message + '（可在资源管理器里手动删除）');
    }
  }
  step('清理旧中间产物 ' + mb(freed));
}

/* ---------- 1. 读取并核对内置示例 ---------- */

function readSample() {
  const main = path.join(SAMPLE_DIR, store.MAIN_FILE);
  if (!fs.existsSync(main)) throw new Error('缺少内置示例：' + main);
  const disk = JSON.parse(fs.readFileSync(main, 'utf8'));
  store.validateDisk(disk);
  const project = store.diskToRuntime(SAMPLE_DIR, disk);
  const notice = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'NOTICE.json'), 'utf8'));

  const ids = project.nodes.map(n => n.id);
  if (project.nodes.length !== 45) throw new Error('示例应为 45 个节点，实际 ' + project.nodes.length);
  if (ids[0] !== 'home_01' || ids[ids.length - 1] !== 'demo_end') {
    throw new Error('示例首尾不是 home_01 → demo_end：' + ids[0] + ' → ' + ids[ids.length - 1]);
  }
  if (project.assets.length !== 8) throw new Error('示例应为 8 张图片，实际 ' + project.assets.length);
  if ((project.characters || []).length !== 2) throw new Error('示例应有两个角色');
  if ((project.audioAssets || []).length) throw new Error('示例不应带音频素材；拒绝把测试语音打进游戏包');
  if (project.titleBackground !== 'asset_title_home_corridor') throw new Error('标题背景不是家中二楼走廊图');
  if (!project.assets.some(a => a.id === project.titleBackground && /^data:image\//.test(a.data))) {
    throw new Error('标题背景素材缺失或未内嵌');
  }
  const road = project.nodes.find(n => n.id === 'road_17');
  if (!road) throw new Error('缺少 road_17');
  const effects = road.effects || [];
  const closeup = effects.find(e => e.type === 'scale' && e.layer === 'linyou');
  const blur = effects.find(e => e.type === 'blur' && e.layer === 'background');
  if (!closeup || closeup.to !== 120 || !blur || blur.to !== 8) {
    throw new Error('road_17 的人物特写 / 背景虚化设置与已确认版本不一致');
  }
  if (project.nodes[0].type !== 'say' || !/早餐|开学/.test(project.nodes[0].text)) {
    throw new Error('正文首句不是已确认的早餐场景');
  }
  return { project, notice };
}

/* ---------- 2. 生成自包含 HTML ---------- */

function buildContent(project) {
  const html = buildPlayerHTML(project);
  if (!/^<!doctype html>/i.test(html)) throw new Error('导出的 HTML 结构异常');
  if (html.length > 48 * 1024 * 1024) throw new Error('游戏内容超过 48MB，超出首版便携包范围');
  const structural = html.slice(0, html.indexOf('<script>') + 8);
  const forbidden = [
    [/paper:\/\//i, '内部 paper:// 协议'],
    [/file:\/\//i, '本机 file:// 地址'],
    [/\bhttps?:\/\//i, '远程地址'],
    [/[A-Za-z]:\\/, '本机盘符路径'],
    [/\/f\//i, '本机开发路径']
  ];
  for (const [re, label] of forbidden) {
    if (re.test(structural)) throw new Error('游戏内容含' + label + '，拒绝打包');
  }
  for (const id of ['home_01', 'road_17', 'demo_end']) {
    if (!html.includes('"' + id + '"')) throw new Error('游戏内容缺少节点 ' + id);
  }
  return html;
}

/* ---------- 3. 组装播放器壳 ---------- */

const NOTICE_TEXT = notice => [
  '《晚风经过二楼走廊》第一章节选 · Windows 独立试玩包',
  '',
  '作品：' + notice.label,
  '作者：' + notice.author,
  '范围：' + notice.scope,
  '美术：' + notice.art,
  '用途：' + notice.usage,
  '',
  '许可：' + notice.licensing,
  '',
  '软件部分（纸间 PaperVNStudio 播放器外壳）以 MIT 许可证发布，完整文本见本目录 LICENSE。',
  '本包是试玩与验收用发布包，不构成公开出版；小说与美术素材的权利归作者所有。',
  '内置示例版本：' + notice.sampleVersion + '；打包版本：' + VERSION + '。',
  ''
].join('\r\n');

const PLAY_TEXT = [
  '《晚风经过二楼走廊》独立试玩包 · 怎么玩',
  '',
  '两种打开方式，任选一种：',
  '  · 单文件便携版：直接双击「' + PORTABLE_NAME + '」，无需解压；',
  '  · 解压目录版：解压整个文件夹，双击里面的「' + EXE_NAME + '」。',
  '',
  '窗口打开即是标题页：开始游戏 / 继续游戏 / 设置。',
  '点击画面或按空格推进；Esc 打开游戏内菜单（保存、读取、设置、返回标题）。',
  '断网也能玩：所有图片都内嵌在游戏内容里，窗口不会发起任何网络请求。',
  '',
  '存档在哪：',
  '  %APPDATA%\\PaperVNStudio-Game-wanfeng-ch01',
  '  （与纸间编辑器、内置示例的存档分开存放；两种打开方式共用同一份存档）',
  '',
  '移动文件夹：',
  '  解压目录可以改名、搬到别的盘；单文件便携版也可以换位置，存档仍在原处。',
  '',
  '卸载：',
  '  删除解压出来的文件夹或那个单文件 EXE 即可；想清掉存档，再删上面那个 APPDATA 目录。',
  '',
  '发行说明：',
  '  本包未附带代码签名证书，Windows 可能提示「未知发布者」；校验请比对随包 manifest 的 SHA-256。',
  ''
].join('\r\n');

function stageApp(html, notice) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'content'), { recursive: true });
  fs.mkdirSync(path.join(STAGE, 'build-resources'), { recursive: true });
  fs.copyFileSync(path.join(GAME_SRC, 'main.cjs'), path.join(STAGE, 'main.cjs'));
  fs.copyFileSync(path.join(GAME_SRC, 'package.json'), path.join(STAGE, 'package.json'));
  fs.writeFileSync(path.join(STAGE, 'content', 'index.html'), html, 'utf8');
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'));
  const icon = path.join(GAME_SRC, ICON_REL);
  if (!fs.existsSync(icon)) throw new Error('缺少应用图标 ' + ICON_REL + '，先运行 node scripts/build-game-icon.cjs');
  fs.copyFileSync(icon, path.join(STAGE, ICON_REL));
  fs.writeFileSync(path.join(STAGE, 'NOTICE-素材与许可.txt'), NOTICE_TEXT(notice), 'utf8');
  fs.writeFileSync(path.join(STAGE, '试玩说明.txt'), PLAY_TEXT, 'utf8');
  return STAGE;
}

/* ---------- 4. 调 electron-builder ---------- */

function electronDist() {
  const custom = process.env.PAPER_GAME_ELECTRON_DIST;
  if (custom) return path.resolve(custom);
  const local = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(local, 'electron.exe'))) {
    throw new Error('本机没有可用的 Electron 分发：' + local + '（先 npm install，或设置 PAPER_GAME_ELECTRON_DIST）');
  }
  return local;
}

function signingStatus() {
  const link = process.env.CSC_LINK || process.env.WIN_CSC_LINK || '';
  return { configured: !!link, source: link ? (process.env.CSC_LINK ? 'CSC_LINK' : 'WIN_CSC_LINK') : '' };
}

function readPeSignature(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    fs.readSync(fd, dos, 0, 64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) return { isPe: false, signed: false, reason: '不是 PE 文件' };
    const peOff = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(26);
    fs.readSync(fd, pe, 0, 26, peOff);
    if (pe.readUInt32LE(0) !== 0x00004550) return { isPe: false, signed: false, reason: 'PE 头签名异常' };
    const magic = pe.readUInt16LE(24);
    const dirStart = peOff + 24 + (magic === 0x20b ? 112 : 96);
    const dir = Buffer.alloc(8);
    fs.readSync(fd, dir, 0, 8, dirStart + 4 * 8);        /* 证书表是数据目录第 5 项 */
    const size = dir.readUInt32LE(4);
    return { isPe: true, signed: size > 0, certBytes: size };
  } finally {
    fs.closeSync(fd);
  }
}

function runBuilder() {
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error('未找到 electron-builder，请先 npm install');
  fs.mkdirSync(BUILD_OUT, { recursive: true });
  const args = [
    cli, '--win', '--x64',
    '-c.electronVersion=' + require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
    '-c.electronDist=' + electronDist(),
    '-c.directories.output=' + BUILD_OUT
  ];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  /* 单文件便携版要用 NSIS；GitHub 常被阻断，默认走 npmmirror。已配置的镜像不覆盖。 */
  if (!env.ELECTRON_BUILDER_BINARIES_MIRROR) {
    env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
  }
  const sign = signingStatus();
  step('electron-builder --win --x64（dir + portable）· 签名：'
    + (sign.configured ? '已配置证书（' + sign.source + '）' : '未配置证书，跳过'));
  const r = spawnSync(process.execPath, args, { cwd: STAGE, env, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('electron-builder 失败，退出码 ' + r.status);

  const unpacked = path.join(BUILD_OUT, 'win-unpacked');
  if (!fs.existsSync(path.join(unpacked, EXE_NAME))) {
    throw new Error('打包结果里没有 ' + EXE_NAME + '：' + unpacked);
  }
  const portableCandidates = fs.readdirSync(BUILD_OUT)
    .filter(f => f.toLowerCase().endsWith('.exe') && /单文件便携版|portable/i.test(f));
  if (!portableCandidates.length) throw new Error('没有生成单文件便携版 EXE：' + BUILD_OUT);

  const portableSource = path.join(BUILD_OUT, portableCandidates[0]);
  const portable = path.join(OUT_ROOT, PORTABLE_NAME);
  fs.rmSync(portable, { force: true });
  fs.renameSync(portableSource, portable);
  return { unpacked, portable, sign, portableNames: portableCandidates };
}

/* ---------- 5. 检查包内只含播放器所需文件 ---------- */

function inspectPackage(unpacked) {
  const asarPath = path.join(unpacked, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) throw new Error('缺少 resources/app.asar');
  const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
  const entries = asar.listPackage(asarPath).map(p => p.replace(/\\/g, '/'));
  const expected = ['/main.cjs', '/package.json', '/content/index.html'];
  for (const e of expected) {
    if (!entries.includes(e)) throw new Error('app.asar 缺少 ' + e);
  }
  const extra = entries.filter(e => !expected.includes(e) && e !== '/content');
  if (extra.length) throw new Error('app.asar 混入了不该随包的文件：' + extra.join(', '));

  const asarBuf = fs.readFileSync(asarPath);
  const asarText = asarBuf.toString('utf8');
  for (const needle of ['PaperVNStudio-src', '新建文件夹', 'desktop/main.cjs', 'dist/app.js',
    'paper://app', 'project.paper.json', 'test.cjs', 'electron-builder']) {
    if (asarText.includes(needle)) throw new Error('app.asar 里出现了不该出现的字符串：' + needle);
  }
  if (fs.existsSync(path.join(unpacked, 'resources', 'app.asar.unpacked'))) {
    throw new Error('出现 app.asar.unpacked，说明有文件被排除在 asar 之外，需要确认来源');
  }
  return { asarPath, entries, asarBytes: asarBuf.length };
}

/* ---------- 6. 打 ZIP ---------- */

function makePackageDir(unpacked, topName) {
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  const target = path.join(PKG_ROOT, topName);
  fs.renameSync(unpacked, target);            /* 只重命名，不复制 300MB */
  return target;
}

function makeZip(pkgDir) {
  const zipPath = path.join(OUT_ROOT, ZIP_BASENAME + '.zip');
  fs.rmSync(zipPath, { force: true });
  const info = writeZip(zipPath, pkgDir, path.basename(pkgDir));
  step('ZIP 写入 ' + info.entries + ' 个条目（UTF-8 文件名）· 原始 ' + mb(info.rawBytes)
    + ' → 压缩 ' + mb(info.packedBytes));
  return zipPath;
}

/* ---------- 7. 清单 ---------- */

function iconInfo() {
  const ico = path.join(GAME_SRC, ICON_REL);
  const buf = fs.readFileSync(ico);
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(buf.readUInt8(6 + 16 * i) || 256);
  return { source: 'game/icon/icon.svg', ico: ICON_REL.replace(/\\/g, '/'), sizes,
    bytes: buf.length, sha256: sha256(buf) };
}

function writeManifest({ zipPath, pkgDir, portable, html, project, notice, asarInfo, sign }) {
  const zipBytes = fs.statSync(zipPath).size;
  const files = walk(pkgDir).sort((a, b) => a.path.localeCompare(b.path));
  const entries = listZipEntries(zipPath).map(e => e.name);
  const portableBytes = fs.statSync(portable).size;
  const exeSig = readPeSignature(path.join(pkgDir, EXE_NAME));
  const portableSig = readPeSignature(portable);
  const manifest = {
    format: 'papervn-game-package',
    formatVersion: 2,
    game: { id: SLUG, title: project.title, author: notice.author, version: VERSION },
    platform: 'win32-x64',
    entry: {
      exe: EXE_NAME, relativeTo: path.basename(pkgDir), note: '解压后进入该目录，双击 EXE',
      portable: PORTABLE_NAME, portableNote: '单文件便携版，无需解压，双击即玩'
    },
    zip: { file: path.basename(zipPath), bytes: zipBytes, sizeLabel: mb(zipBytes), sha256: sha256(fs.readFileSync(zipPath)) },
    portable: {
      file: path.basename(portable), bytes: portableBytes, sizeLabel: mb(portableBytes),
      sha256: sha256(fs.readFileSync(portable)),
      signature: { signed: portableSig.signed, certBytes: portableSig.certBytes || 0 }
    },
    unpacked: { dir: path.basename(pkgDir), bytes: files.reduce((s, f) => s + f.bytes, 0), files: files.length },
    signature: {
      signed: exeSig.signed, certBytes: exeSig.certBytes || 0,
      certificateConfigured: sign.configured,
      note: exeSig.signed ? 'EXE 内含 Authenticode 签名' : '未配置代码签名证书，构建未签名；Windows 可能提示「未知发布者」'
    },
    icon: iconInfo(),
    inputs: {
      sample: { nodes: project.nodes.length, images: project.assets.length,
        audioAssets: (project.audioAssets || []).length, firstNode: project.nodes[0].id,
        lastNode: project.nodes[project.nodes.length - 1].id,
        titleBackground: project.titleBackground, sampleVersion: notice.sampleVersion },
      html: { bytes: html.length, selfContained: true },
      asar: { bytes: asarInfo.asarBytes, entries: asarInfo.entries },
      electron: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
      electronBuilder: require(path.join(ROOT, 'node_modules', 'electron-builder', 'package.json')).version
    },
    zipEntries: entries,
    builtAt: new Date().toISOString(),
    builtOn: os.platform() + '-' + os.arch()
  };
  const manifestPath = path.join(OUT_ROOT, ZIP_BASENAME + '.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifest, manifestPath };
}

/* ---------- main ---------- */

function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  if (PRUNE) pruneOldBuilds();

  step('核对内置示例 dist/samples/' + SLUG);
  const { project, notice } = readSample();
  step('  ' + project.nodes.length + ' 节点 · ' + project.assets.length + ' 图 · 0 音频 · 标题图 '
    + project.titleBackground);

  step('生成自包含 HTML（dist/game-html.js → player.js）');
  const html = buildContent(project);
  step('  ' + mb(Buffer.byteLength(html)));

  step('组装播放器壳 game/ → release/game/stage（含 ' + ICON_REL + '）');
  stageApp(html, notice);

  const built = runBuilder();
  step('检查包内容（只允许播放器所需文件）');
  const asarInfo = inspectPackage(built.unpacked);

  step('压成 ZIP（解压目录 + EXE + 运行资源）');
  const pkgDir = makePackageDir(built.unpacked, GAME_TITLE + '-' + VERSION + '-win-x64');
  const zipPath = makeZip(pkgDir);
  const { manifest, manifestPath } = writeManifest({
    zipPath, pkgDir, portable: built.portable, html, project, notice, asarInfo, sign: built.sign
  });

  console.log('');
  console.log('GAME PACKAGE OK · ' + VERSION);
  console.log('  ZIP       ' + zipPath);
  console.log('  大小      ' + manifest.zip.sizeLabel + '（' + manifest.zip.bytes + ' 字节）');
  console.log('  SHA-256   ' + manifest.zip.sha256);
  console.log('  解压后    ' + manifest.unpacked.dir + '\\' + EXE_NAME);
  console.log('  单文件版  ' + built.portable);
  console.log('  单文件大小 ' + manifest.portable.sizeLabel + '（' + manifest.portable.bytes + ' 字节）');
  console.log('  单文件SHA ' + manifest.portable.sha256);
  console.log('  图标      ' + manifest.icon.sizes.join('/') + ' px · ' + (manifest.icon.bytes / 1024).toFixed(1) + ' KB');
  console.log('  签名      ' + (manifest.signature.signed ? '已签名' : '未签名（未配置 CSC_LINK）'));
  console.log('  清单      ' + manifestPath);
  console.log('  中间产物  ' + path.dirname(pkgDir) + '（约 ' + mb(manifest.unpacked.bytes) + '，可用 --prune 清理）');
}

if (require.main === module) main();

/* 给测试用：签名检测与签名配置判断都是纯函数，便于单独验证。 */
module.exports = { readPeSignature, signingStatus };
