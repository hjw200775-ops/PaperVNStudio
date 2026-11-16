'use strict';
/* 工作区卫生检查：烟测工程不许再落进源码根目录，示例工程也不许被忽略规则遮蔽。
 * 这两件事都是实际踩过的坑（根目录残留 project.paper.json + assets/ + backups/），
 * 所以用断言钉住，而不是只写在文档里。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/* 1. 源码根目录只能是源码，不能带工程运行时目录 */
for (const stray of ['project.paper.json', 'assets', 'backups', 'user-projects', 'out', 'drafts']) {
  assert(!fs.existsSync(path.join(root, stray)),
    '源码根目录出现了工程运行时产物：' + stray + '；烟测必须改用系统临时目录');
}

/* 2. 忽略规则不能吃掉 assets/ 或 *.paper.json —— 否则以后的示例工程提交不进去 */
const ignoreLines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));
for (const line of ignoreLines) {
  const bad = /^(?:.*\/)?assets\/?$/.test(line) ||
    /^(?:.*\/)?project\.paper\.json$/.test(line) ||
    /^\*?\.paper\.json$/.test(line) ||
    /^\*\*?\/\*\.paper\.json$/.test(line);
  assert(!bad, '.gitignore 不应全局忽略工程内容：' + line);
}
assert(!ignoreLines.includes('project.paper.json'), '.gitignore 不应忽略 project.paper.json');

/* 3. 烟测脚本必须把工程建在 os.tmpdir() 下，且不得引用源码根目录下的工程文件 */
const smokeScripts = ['desktop-smoke.cjs', 'desktop-project-smoke.cjs', 'packaged-smoke.cjs'];
for (const name of smokeScripts) {
  const src = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
  assert(/mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)/.test(src),
    name + ' 必须用 fs.mkdtempSync(path.join(os.tmpdir(), …)) 建工程目录');
  assert(!/ROOT\s*,\s*['"]project\.paper\.json['"]/.test(src),
    name + ' 不能把工程写进源码根目录');
  assert(!/require\(['"]\.\.\/project\.paper\.json['"]\)/.test(src),
    name + ' 不能依赖源码根目录的工程文件');
}

/* 4. 桌面端运行时状态只进 userData，不落仓库 */
const main = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
assert(/recentFile\s*=\s*path\.join\(app\.getPath\('userData'\)/.test(main),
  '最近工程列表必须写在 userData 里');
assert(/draftDir\s*=\s*path\.join\(app\.getPath\('userData'\)/.test(main),
  '崩溃草稿必须写在 userData 里');

console.log('  ok  源码根目录无工程产物，忽略规则不遮蔽 assets/ 与 project.paper.json');
console.log('  ok  烟测脚本统一使用 os.tmpdir()，运行时状态只写 userData');
console.log('Workspace hygiene checks passed.');
