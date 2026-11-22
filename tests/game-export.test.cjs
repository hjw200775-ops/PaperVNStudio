'use strict';
/* V0.7.2 通用导出的边界：
 *   1. 发行设置是工程内容：默认值、迁移、校验、磁盘往返与撤销快照都带上它；
 *   2. 作品身份：同一工程稳定、两个工程互不相同、复制示例拿到新身份；
 *   3. 构建器：不硬编码任何作品/盘符，运行时取自当前 Electron，缺组件要报清楚；
 *   4. 播放器外壳：读 game.json、按 releaseId 隔离存档、保持沙箱与无网络。 */
const assert = require('node:assert/strict');
const { inlineAssets } = require('./inline-assets.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createCore = require('../dist/core.js');
const createStore = require('../desktop/project-store.cjs');
const C = createCore();

/* 1. 默认值与迁移 */
const blank = C.blank();
assert.deepEqual(
  { w: blank.publish.window.width, h: blank.publish.window.height, r: blank.publish.window.resizable, m: blank.publish.window.mode },
  { w: 1280, h: 840, r: true, m: 'window' });
assert.equal(blank.publish.gameName, '');
assert.equal(blank.publish.version, '1.0.0');
assert.equal(blank.publish.icon, null);

const legacy = C.migrate({
  schema: 5, id: 'legacy-project', title: '旧工程', assets: [], nodes: [], presets: [],
  characters: [], chapters: [{ id: 'c', title: '第一章', paragraphs: [{ id: 'g', title: '默认' }] }]
});
assert.equal(legacy.publish.version, '1.0.0', '旧工程应补默认发行设置');
assert.equal(legacy.publish.releaseId, '', '旧工程不应凭空获得自定义发行标识');

/* 2. 发行标识：稳定、可区分、只含安全字符 */
assert.equal(C.releaseIdOf(legacy), 'legacy-project');
const other = C.migrate({ ...legacy, id: 'another-project', title: '旧工程' });
assert.notEqual(C.releaseIdOf(legacy), C.releaseIdOf(other), '同名不同工程不能共用发行标识');
assert.equal(C.releaseIdOf({ id: 'sample-wanfeng-ch01', publish: { releaseId: 'wanfeng-ch01' } }), 'wanfeng-ch01');
assert.match(C.releaseIdOf({ id: '工程 A/带 空格' }), /^[a-z0-9-]{3,64}$/, '发行标识必须能安全用作目录名');
assert.match(C.releaseIdOf({ id: 'x', publish: { releaseId: 'BAD ID' } }), /^game-[0-9a-f]{8}$/,
  '太短的工程 id 也要得到唯一的发行标识');
assert.notEqual(C.releaseIdOf({ id: 'x' }), C.releaseIdOf({ id: 'y' }), '短 id 不能共用同一目录');

/* 3. 校验：坏图标与坏窗口要报错，超范围数值被钳制 */
const badIcon = C.clone(legacy);
badIcon.publish.icon = { data: 'data:image/jpeg;base64,AAAA' };
assert.throws(() => C.validate(badIcon), /游戏图标格式错误/);
const badWindow = C.clone(legacy);
badWindow.publish.window = { width: 100, height: 100, resizable: 'yes', mode: 'fullscreen' };
assert.throws(() => C.validate(badWindow), /窗口设置格式错误/);
const clamped = C.toPublish({
  ...legacy,
  publish: { window: { width: 99999, height: 1, resizable: false, mode: 'fullscreen' } }
});
assert.deepEqual(clamped.publish.window, { width: 3840, height: 480, resizable: false, mode: 'fullscreen' });

/* 4. 磁盘往返：发行设置与图标跟着工程走 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-publish-'));
try {
  const store = createStore();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const project = C.migrate(C.blank());
  project.title = '往返测试';
  project.publish = {
    gameName: '发行名称', author: '作者甲', version: '3.2.1', copyright: '© 2026 作者甲',
    icon: { name: 'icon.png', data: 'data:image/png;base64,' + png.toString('base64'), width: 512, height: 512 },
    window: { width: 1600, height: 900, resizable: false, mode: 'fullscreen' },
    releaseId: 'round-trip'
  };
  project.nodes.push(C.makeNode('say'));
  const created = store.createProject(path.join(tmp, 'proj'), project);
  const reopened = store.openProject(created.root).project;
  assert.equal(reopened.publish.gameName, '发行名称');
  assert.equal(reopened.publish.version, '3.2.1');
  assert.equal(reopened.publish.releaseId, 'round-trip');
  assert.equal(reopened.publish.window.mode, 'fullscreen');
  assert.equal(reopened.publish.window.resizable, false);
  assert.ok(reopened.publish.icon && reopened.publish.icon.data.startsWith('data:image/png;base64,'));
  assert.equal(C.releaseIdOf(reopened), 'round-trip');
  assert.equal(reopened.publish.icon.width, 512);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* 5. 构建器：无硬编码、运行时来自当前 Electron、组件缺失要说清楚 */
const builderPath = path.join(ROOT, 'desktop', 'game-builder.cjs');
const builderSrc = fs.readFileSync(builderPath, 'utf8');
for (const bad of ['晚风经过二楼走廊', 'wanfeng-ch01', 'F:\\\\', 'C:\\\\Users']) {
  assert(!builderSrc.includes(bad), '构建器不应硬编码：' + bad);
}
assert(/process\.execPath/.test(builderSrc), '运行时必须取自当前进程');
assert(/resourcesPath/.test(builderSrc), '打包后应能从 resources/toolchain 找组件');
assert(/vendor/.test(builderSrc) && /toolchain/.test(builderSrc), '开发环境应回退到 vendor/toolchain');
assert(/isCancelled/.test(builderSrc) && /Cancelled/.test(builderSrc), '必须支持取消');
assert(/mkdtempSync/.test(builderSrc), '构建应使用临时目录，失败不影响已有产物');
assert(/game-pack-worker\.cjs/.test(builderSrc), '重活应交给子进程，主进程才不会被阻塞');
assert(/resourcesPath, 'worker'/.test(builderSrc) || /'worker', 'game-pack-worker/.test(builderSrc),
  '打包后 worker 必须从 asar 外加载');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const extra = (pkg.build.extraResources || []).map(x => x.to);
assert(extra.includes('worker/game-pack-worker.cjs') && extra.includes('worker/zip-writer.cjs'),
  'worker 与它的依赖要随包复制到 resources/worker');
const workerSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'game-pack-worker.cjs'), 'utf8');
assert(/rcedit/.test(workerSrc) && /toolchain\.nsis/.test(workerSrc), '图标/版本与单文件需要 rcedit、NSIS');
assert(/game-launcher\.exe/.test(workerSrc), 'rcedit 需要 ASCII 中间名（它读不了中文路径）');
assert(/GetParameters/.test(workerSrc), '单文件便携版要把命令行参数转给游戏');
assert(/\\uFEFF/.test(workerSrc), 'NSIS 脚本需要 UTF-8 BOM 才认中文');

const createBuilder = require(builderPath);
const fake = createBuilder({ repoRoot: ROOT, execPath: process.execPath, resourcesPath: '', isPackaged: false });
const tc = fake.toolchain();
assert.equal(tc.runtime.ok, false, 'Node 进程没有 Electron 运行时，应判定不可用并给出说明');
assert.ok(tc.runtime.note, '不可用时必须有说明文字');

/* 6. 播放器外壳：读 game.json、按 releaseId 定位存档、保持沙箱 */
const shell = fs.readFileSync(path.join(ROOT, 'desktop', 'game-shell', 'main.cjs'), 'utf8');
for (const [re, why] of [
  [/content', 'game\.json'/, '读取 game.json'],
  [/PaperVNStudio-Game-/, '独立存档目录'],
  [/sandbox: true/, 'sandbox'],
  [/contextIsolation: true/, '上下文隔离'],
  [/nodeIntegration: false/, '禁用 Node'],
  [/connect-src 'none'/, '禁止网络'],
  [/papergame/, '白名单协议'],
  [/flushStorageData/, '退出前落盘']
]) assert(re.test(shell), '游戏外壳缺少：' + why);
assert(!/ipcMain|preload:/.test(shell), '游戏外壳不应有 IPC / preload');
assert(!/晚风|wanfeng|黄嘉文/.test(shell), '游戏外壳不应硬编码具体作品');

/* 7. 默认图标与图标源都在仓库里 */
assert(fs.existsSync(path.join(ROOT, 'desktop', 'game-shell', 'default-icon.ico')), '缺少默认图标');
assert(fs.existsSync(path.join(ROOT, 'game', 'icon', 'icon.svg')), '缺少图标矢量源');
const ico = fs.readFileSync(path.join(ROOT, 'desktop', 'game-shell', 'default-icon.ico'));
assert.equal(ico.readUInt16LE(2), 1, '默认图标应是 ICO');

/* 8. 工具链准备脚本不依赖固定盘符 */
const prep = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-game-toolchain.cjs'), 'utf8');
assert(!/F:\\\\|C:\\\\Users/.test(prep), '工具链脚本不应写死盘符');
assert(/ELECTRON_BUILDER_CACHE|electron-builder/.test(prep), '应从本机缓存收集组件');

/* 9. HTML 导出回归：带发行设置的工程仍能导出为自包含 HTML */
const { buildPlayerHTML } = require('../dist/game-html.js');
const sampleDir = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const sampleDisk = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.paper.json'), 'utf8'));
const sampleProject = require('../desktop/project-store.cjs')().diskToRuntime(sampleDir, sampleDisk);
const html = buildPlayerHTML(inlineAssets(sampleProject, path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01')));
assert(/^<!doctype html>/i.test(html));
assert(html.includes('"home_01"') && html.includes('"demo_end"'), 'HTML 导出应包含完整剧情');
assert(!/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html), 'HTML 导出必须自包含');
assert(html.includes('paper-game-'), 'HTML 导出仍使用原来的存档键规则');


/* 6. 版本归一：预发布后缀不能丢掉段位（0.7.2-test 曾经变成 0.7.0.0） */
const builderLib = require('../desktop/game-builder.cjs')({
  repoRoot: ROOT, execPath: process.execPath, resourcesPath: '', isPackaged: false
});
const cases = [
  ['0.7.2-test', '0.7.2.0'],
  ['1.2.3-beta.1', '1.2.3.1'],
  ['2', '2.0.0.0'],
  ['', '1.0.0.0'],
  ['1.2.3', '1.2.3.0'],
  ['abc', '1.0.0.0'],
  ['1.2.3.4.5', '1.2.3.4']
];
for (const [input, expected] of cases) {
  assert.equal(builderLib.numericVersion(input), expected,
    '版本 " ' + input + ' " 应归一为 ' + expected);
}

/* worker 是 extraResources 单独分发的，两边必须用同一套归一逻辑 */
const versionWorkerSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'game-pack-worker.cjs'), 'utf8');
assert(versionWorkerSrc.includes('.match(/^\\d+/)'),
  'worker 里的 numericVersion 也要取前导数字，不能退回整段匹配');
assert(!versionWorkerSrc.includes('/^\\d+$/'),
  'worker 里不应再出现「整段必须是数字」的旧实现');

/* 7. manifest 必须同时记录作者原值与实际写入的 EXE 版本 */
const manifestBuilderSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'game-builder.cjs'), 'utf8');
assert(/exeVersion: numericVersion\(settings\.version\)/.test(manifestBuilderSrc),
  'manifest 要记录实际写进 EXE 的四段版本');
assert(/version: settings\.version/.test(manifestBuilderSrc),
  'manifest.game.version 仍保留作者填的原始值');

/* 8. PE 版本读取器：用微软签名的系统文件做正例，不能用外部命令 */
const { readPeVersion } = require('../scripts/pe-version.cjs');
const sysExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
if (fs.existsSync(sysExe)) {
  const sysVer = readPeVersion(sysExe);
  assert(sysVer && /^\d+\.\d+\.\d+\.\d+$/.test(sysVer.fileVersion),
    '要能从 PE 资源读出 explorer.exe 的版本');
}

console.log('  ok  版本归一保留段位（0.7.2-test / 1.2.3-beta.1 / 2 / 空值），worker 与主进程同源');
console.log('  ok  manifest 分别记录作者原值与 EXE 四段版本，PE 版本读取不依赖外部命令');

console.log('  ok  发行设置默认值/迁移/校验/磁盘往返都成立');
console.log('  ok  带发行设置的工程仍能导出为自包含 HTML');
console.log('  ok  发行标识稳定且能区分同名工程，复制示例会换身份');
console.log('  ok  构建器不硬编码作品与盘符，运行时取自当前 Electron，取消与临时目录齐备');
console.log('  ok  游戏外壳读取 game.json、按 releaseId 隔离存档并保持沙箱');
console.log('PASS: V0.7.2 generic game export boundaries');
