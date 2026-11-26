'use strict';
/* V0.8.2 · M3-B · 软件版本标识一致性（单一来源：package.json 的 version / versionLabel）
 *
 * 历史问题：界面右上角仍是 0.6.2、便携版目录仍叫 0.8.1、package-lock 还是 0.3.1。
 * 本测试把「软件版本来源」约束为 package.json，并强制下列位置与之一致：
 *   package-lock.json（顶层 + packages[""]）/ 编辑器界面版本 / 指南标题 / 窗口标题 /
 *   README 徽章 / 构建清单生成器。
 *
 * 同时显式保护「有独立技术含义、绝不能跟着软件版本改」的字段：
 *   内置示例 sampleVersion、工程 schema、存档格式版本、作品 publish.version。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const pkg = JSON.parse(read('package.json'));
const { version, versionLabel } = pkg;
assert.equal(typeof version, 'string', 'package.json.version 必须存在');
assert.equal(typeof versionLabel, 'string', 'package.json.versionLabel 必须存在');
/* 开发阶段标识：本轮必须是 M3B，且不得写成正式 V0.8.2 发布版 */
assert.equal(versionLabel, 'V0.8.2-M3B', '本轮必须使用明确的 V0.8.2-M3B 开发阶段标识');
assert.equal(version, '0.8.2-M3B', '构建产物目录名来自 package.json.version');
assert.equal(versionLabel, 'V' + version, 'versionLabel 与 version 必须同源');

/* 1. package-lock 必须同步（历史遗漏过） */
const lock = JSON.parse(read('package-lock.json'));
assert.equal(lock.version, version, 'package-lock.json 顶层版本落后');
assert.equal(lock.packages[''].version, version, 'package-lock.json packages[""] 版本落后');

/* 2. 编辑器界面 / 指南 / 窗口标题 */
const indexHtml = read('dist/index.html');
assert(indexHtml.includes('<b>' + versionLabel + '</b>'), '编辑器界面版本未跟随 versionLabel');
assert(!/示例与标题背景版 <b>0\.6\.2<\/b>/.test(indexHtml), '界面仍显示历史 0.6.2');
const appJs = read('dist/app.js');
assert(appJs.includes("modal('" + versionLabel + ' · 使用指南\''), '使用指南标题未跟随 versionLabel');
const mainCjs = read('desktop/main.cjs');
assert(mainCjs.includes("title: '纸间 PaperVNStudio · " + versionLabel + "'"), '窗口标题未跟随 versionLabel');

/* 3. README 徽章；构建清单生成器必须引用 pkg.versionLabel（不硬编码） */
assert(read('README.md').includes('badge/version-0.8.2--M3B'), 'README 版本徽章未更新');
const buildDir = read('scripts/build-win-dir.cjs');
assert(buildDir.includes("'PaperVNStudio-' + pkg.version + '-win-x64'"), '便携版目录名必须由 pkg.version 生成');
assert(buildDir.includes('versionLabel: pkg.versionLabel'), '构建清单必须写入 versionLabel');
/* V0.8.2 系列验收脚本必须跟随当前版本，不能残留 0.8.1 便携版路径 */
for (const f of ['scripts/v082m1a-ui-verify.cjs', 'scripts/v082m1b-ui-verify.cjs', 'scripts/v082m2a-ui-verify.cjs',
  'scripts/v082m2b-ui-verify.cjs', 'scripts/v082m3a-avsync.cjs', 'scripts/v082m3a-runtime-consistency.cjs']) {
  assert(read(f).includes("'PaperVNStudio-' + require('../package.json').version + '-win-x64'"),
    f + ' 仍硬编码旧版本便携版路径');
}
/* 导出前资源预检必须与 core 同口径，把时间轴演出里的素材算作已引用 */
const rr = read('scripts/resource-report.cjs');
assert(rr.includes('background.change') && rr.includes("startsWith('audio.')"),
  'resource-report 漏扫 node.performance.actions 的素材引用');

/* 4. 独立技术含义的版本字段不得被误改 */
const notice = JSON.parse(read('dist/samples/wanfeng-ch01/NOTICE.json'));
assert.equal(notice.sampleVersion, '0.6.2', '内置示例数据版本有独立含义，不能跟着软件版本改');
assert(read('scripts/build-sample.cjs').includes("sampleVersion: '0.6.2'"), '示例生成器版本不能改');
const core = require('../dist/core.js')();
assert.equal(core.blank().schema, 6, '工程 schema 版本有独立含义');
assert.equal(core.blank().publish.version, '1.0.0', '作品 publish.version 是作品自己的版本，不是软件版本');
/* game/ 是《晚风》独立试玩包的作品包，版本属于作品自身，与编辑器软件版本无关 */
assert.equal(JSON.parse(read('game/package.json')).version, '0.7.1', '《晚风》作品包版本不得被误改');

console.log('PASS: V0.8.2-M3B 软件版本标识一致（' + versionLabel + '），独立技术版本字段未被误改');
