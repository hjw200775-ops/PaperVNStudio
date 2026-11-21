'use strict';
/* V0.7 第一阶段：独立游戏包的边界。
 * 这些断言盯的是不能回退的约束，而不是「跑起来好看」：
 *   1. 游戏身份（appId / userData）与纸间编辑器分开，依赖版本不被悄悄换掉；
 *   2. 游戏壳没有 preload、IPC、Node 集成，内容只来自内置示例；
 *   3. 自写 ZIP 写入器把中文名写成 UTF-8，并在别的机器解压后仍是同一个名字。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = rel => JSON.parse(read(rel));

/* 1. 身份、依赖与打包范围 */
const game = readJson('game/package.json');
const editor = readJson('package.json');
assert.equal(game.build.appId, 'cn.papervnstudio.game.wanfeng-ch01');
assert.notEqual(game.build.appId, editor.build.appId, '游戏不能复用编辑器 appId');
assert.equal(game.build.productName, '晚风经过二楼走廊');
assert.equal(game.build.win.executableName, '晚风经过二楼走廊');
assert.equal(game.version, '0.7.1');
assert(!game.dependencies && !game.devDependencies, '游戏壳不应引入自己的依赖');
assert.deepEqual(game.build.files.slice().sort(), ['content/**', 'main.cjs', 'package.json'].sort(),
  '游戏包里只能有播放器入口、内容与 manifest');
assert.deepEqual(game.build.extraFiles.slice().sort(),
  ['LICENSE', 'NOTICE-素材与许可.txt', '试玩说明.txt'].sort(), '只额外带许可与试玩说明');

/* 正式版的发布信息：图标、版权、单文件便携 target */
const targets = game.build.win.target.map(t => t.target).sort();
assert.deepEqual(targets, ['dir', 'portable'], '正式版同时出解压目录与单文件便携 EXE');
assert.equal(game.build.win.icon, 'build-resources/icon.ico');
assert.equal(game.build.directories.buildResources, 'build-resources');
assert.match(game.build.copyright, /2026/, '需要版权信息');
assert.equal(game.build.win.legalTrademarks, '晚风经过二楼走廊');
assert.match(game.build.portable.artifactName, /单文件便携版/);

const ico = fs.readFileSync(path.join(ROOT, 'game', 'build-resources', 'icon.ico'));
assert.equal(ico.readUInt16LE(0), 0, 'ICO 保留字段');
assert.equal(ico.readUInt16LE(2), 1, 'ICO 类型必须是 icon');
const icoCount = ico.readUInt16LE(4);
assert(icoCount >= 8, 'ICO 应包含多档尺寸，实际 ' + icoCount);
const icoSizes = [];
for (let i = 0; i < icoCount; i++) icoSizes.push(ico.readUInt8(6 + 16 * i) || 256);
assert(icoSizes.includes(256) && icoSizes.includes(32) && icoSizes.includes(16),
  'ICO 至少要有 16/32/256：' + icoSizes.join(','));
assert(fs.existsSync(path.join(ROOT, 'game', 'icon', 'icon.svg')), '图标源文件应入库');

assert.equal(editor.devDependencies.electron, '45.3.2');
assert.equal(editor.devDependencies['electron-builder'], '26.18.0');
const installed = readJson('node_modules/electron/package.json').version;
assert.equal(installed, editor.devDependencies.electron,
  '本机 Electron 版本与 package.json 不一致，先 npm install 再打包');

/* 2. 游戏壳的安全边界 */
const main = read('game/main.cjs');
const must = [
  [/sandbox:\s*true/, 'sandbox: true'],
  [/contextIsolation:\s*true/, 'contextIsolation: true'],
  [/nodeIntegration:\s*false/, 'nodeIntegration: false'],
  [/nodeIntegrationInWorker:\s*false/, 'nodeIntegrationInWorker: false'],
  [/webSecurity:\s*true/, 'webSecurity: true'],
  [/PaperVNStudio-Game-/, '独立 userData 目录'],
  [/requestSingleInstanceLock/, '单实例锁'],
  [/url\.pathname !== '\/index\.html'/, '协议白名单只放 index.html'],
  [/connect-src 'none'/, 'CSP 禁止网络连接'],
  [/onBeforeRequest/, '拦截 http(s) 请求'],
  [/setPermissionRequestHandler/, '拒绝权限申请'],
  [/setWindowOpenHandler/, '拒绝新窗口']
];
for (const [re, why] of must) assert(re.test(main), '游戏主进程缺少：' + why);
for (const [re, why] of [[/ipcMain|ipcRenderer|contextBridge/, 'IPC / preload 桥'],
  [/preload\s*:/, 'preload'],
  [/nodeIntegration:\s*true/, 'Node 集成'],
  [/sandbox:\s*false/, '关闭沙箱'],
  [/webSecurity:\s*false/, '关闭 webSecurity'],
  [/require\('\.\.\/dist/, '编辑器源码']]) {
  assert(!re.test(main), '游戏壳不该包含：' + why);
}

/* 3. 内容来自内置示例，且是同一套导出 */
const createStore = require('../desktop/project-store.cjs');
const { buildPlayerHTML } = require('../dist/game-html.js');
const store = createStore();
const sampleDir = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const disk = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.paper.json'), 'utf8'));
store.validateDisk(disk);
const project = store.diskToRuntime(sampleDir, disk);
assert.equal(project.nodes.length, 45);
assert.equal(project.nodes[0].id, 'home_01');
assert.equal(project.nodes[project.nodes.length - 1].id, 'demo_end');
assert.equal(project.assets.length, 8);
/* V0.7.3：示例带六首正式 OST，包内只允许出现的三首被引用曲目，
   不得混入早期测试用的占位语音。 */
const audioIds = (project.audioAssets || []).map(a => a.meta && a.meta.trackId).filter(Boolean);
assert(audioIds.every(id => /^ost_0[1-6]_/.test(id)), '游戏包不得混入测试语音，只允许 OST 曲目');
const html = buildPlayerHTML(project);
const structural = html.slice(0, html.indexOf('<script>') + 8);
assert(!/paper:\/\/|file:\/\/|https?:\/\//i.test(structural), '游戏内容不能引用协议 / 本机 / 远程地址');
const embeddedAudio = (html.match(/data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/gi) || []).length;
assert(embeddedAudio <= 3, '未引用的曲目不应进包，实际内嵌 ' + embeddedAudio + ' 段');
assert(html.includes('asset_title_home_corridor'), '标题背景应是家中二楼走廊');
assert(html.includes('林澈！'), 'road_17 台词应保持原作');
for (const n of project.nodes) assert(html.includes('"' + n.id + '"'), '缺少节点 ' + n.id);
assert(html.length < 48 * 1024 * 1024, '游戏内容体积超出首版便携包范围');

/* 4. ZIP：中文名按 UTF-8 写入，内容可原样解回 */
const { writeZip } = require('../scripts/zip-writer.cjs');
const { listZipEntries } = require('../scripts/zip-manifest.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-game-zip-'));
try {
  const inner = path.join(tmp, 'src', '晚风 目录');
  fs.mkdirSync(inner, { recursive: true });
  const body = Buffer.from('第一句：九月。开学后的第二周。\n'.repeat(40), 'utf8');
  fs.writeFileSync(path.join(inner, '正文 一.txt'), body);
  fs.writeFileSync(path.join(tmp, 'src', 'LICENSE'), 'MIT\n');
  const zipPath = path.join(tmp, 'pkg.zip');
  const info = writeZip(zipPath, path.join(tmp, 'src'), '晚风 顶层');
  assert.equal(info.entries, 3, '两个文件 + 一个子目录（顶层目录由文件名前缀表达）');

  const entries = listZipEntries(zipPath);
  const names = entries.map(e => e.name);
  assert(names.includes('晚风 顶层/晚风 目录/正文 一.txt'), '中文文件名在 ZIP 里被改写：' + names.join(', '));
  assert(entries.every(e => e.utf8Flag), 'ZIP 必须置 UTF-8 文件名标志位');
  const target = entries.find(e => e.name.endsWith('正文 一.txt'));
  const head = fs.readFileSync(zipPath);
  const nameLen = head.readUInt16LE(target.localOffset + 26);
  const extraLen = head.readUInt16LE(target.localOffset + 28);
  const start = target.localOffset + 30 + nameLen + extraLen;
  const packed = head.subarray(start, start + target.compressed);
  const restored = target.method === 8 ? zlib.inflateRawSync(packed) : packed;
  assert.deepEqual(restored, body, 'ZIP 里的内容解压后应完全一致');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* 5. 构建与验收脚本自身不夹带开发机路径，且验收对象是解压后的成品 */
const build = read('scripts/build-game-package.cjs');
const accept = read('scripts/game-package-acceptance.cjs');
for (const [name, src] of [['build-game-package.cjs', build], ['game-package-acceptance.cjs', accept],
  ['zip-writer.cjs', read('scripts/zip-writer.cjs')], ['zip-manifest.cjs', read('scripts/zip-manifest.cjs')]]) {
  assert(!/[A-Za-z]:\\\\(?:新建文件夹|Users)/.test(src), name + ' 里出现本机绝对路径');
}
assert(/buildPlayerHTML/.test(build), '构建必须复用唯一的导出入口');
assert(/nodes\.length !== 45/.test(build), '构建必须核对 45 个节点');
assert(!/--dir'/.test(build), '正式版要同时出 dir 与 portable，不能只跑 --dir');
assert(/portableCandidates/.test(build) && /PORTABLE_NAME/.test(build), '构建要收集并输出单文件便携 EXE');
assert(/listZip|writeZip/.test(build));
assert(/extract\(/.test(accept), '验收必须先解压');
assert(!/npm run desktop|serve\.cjs/.test(accept), '验收不能用源码启动冒充成品');
assert(/sha256/.test(accept), '验收要报告 SHA-256');
assert(/CSC_LINK/.test(build) && /readPeSignature/.test(build), '构建要支持签名并如实检测签名状态');
assert(/signed: exeSig\.signed/.test(build), '清单里的签名状态必须来自真实 PE 检测，不能写死');

/* 6. 签名检测：用微软签名的系统程序做正例，用未签名文件做负例 */
const buildLib = require('../scripts/build-game-package.cjs');
const signedProbe = buildLib.readPeSignature(path.join(process.env.SystemRoot || 'C:\Windows', 'explorer.exe'));
if (signedProbe.isPe) {
  assert(signedProbe.signed, '签名检测器必须能认出微软签名的 explorer.exe');
  assert(signedProbe.certBytes > 0, '已签名文件应有证书表长度');
}
const unsignedProbe = buildLib.readPeSignature(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'));
assert(unsignedProbe.isPe && !unsignedProbe.signed, 'Electron 本体未签名，应判定为 signed=false');
assert(!buildLib.signingStatus().configured || process.env.CSC_LINK || process.env.WIN_CSC_LINK,
  '未配置 CSC_LINK 时不能声称已配置证书');
process.env.CSC_LINK = 'C:\temp\fake.pfx';
assert(buildLib.signingStatus().configured && buildLib.signingStatus().source === 'CSC_LINK',
  '配置 CSC_LINK 后应识别为已配置');
delete process.env.CSC_LINK;

console.log('  ok  签名检测：微软签名文件判定为已签名，未签名文件判定为未签名，CSC_LINK 生效');
console.log('  ok  正式版信息：多档 ICO 图标、版权与商标字段、dir + portable 双 target');
console.log('  ok  游戏壳 sandbox / 上下文隔离 / 无 Node / 无 preload / 无 IPC，协议与网络都收窄');
console.log('  ok  内容来自内置示例：45 节点、8 图、只带被引用的 BGM，road_17 与标题图保持原作');
console.log('  ok  ZIP 中文名为 UTF-8 且内容可还原，验收脚本只认解压后的成品');
console.log('PASS: V0.7 standalone game package boundaries');
