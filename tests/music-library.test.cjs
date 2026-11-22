'use strict';
/* V0.7.3 音乐素材库与场景配乐：模型、引用、导出过滤的静态约束。
 * 真实播放行为由 scripts/music-acceptance.cjs 在窗口里验。 */
const assert = require('node:assert');
const { inlineAssets } = require('./inline-assets.cjs');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'desktop/project-store.cjs'))();
const C = require(path.join(ROOT, 'dist/core.js'))();
const { buildPlayerHTML } = require(path.join(ROOT, 'dist/game-html.js'));

const sampleDir = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const p = store.openProject(sampleDir).project;

/* 1. 六首入库，标签齐全，按 trackId 可定位 */
assert.equal(p.audioAssets.length, 6, '示例工程应有 6 首 BGM');
const byTrack = new Map(p.audioAssets.map(a => [a.meta && a.meta.trackId, a]));
for (const id of ['ost_01_title', 'ost_02_morning', 'ost_03_school_road',
  'ost_04_playful', 'ost_05_after_school', 'ost_06_night']) {
  const a = byTrack.get(id);
  assert(a, '缺少曲目：' + id);
  assert.equal(a.ext, 'ogg', id + ' 应保持 OGG 原格式');
  assert.equal(a.mime, 'audio/ogg');
  assert(a.meta.category, id + ' 缺少分类');
  assert(Array.isArray(a.meta.moodTags) && a.meta.moodTags.length, id + ' 缺少情绪标签');
}

/* 2. 只有三首被引用：标题 + 两个场景入口 */
const referenced = C.referencedAudioIds(p);
assert.equal(referenced.length, 3, '当前剧情只应引用 3 首，实际 ' + referenced.length);
assert(referenced.includes(byTrack.get('ost_01_title').id));
assert(referenced.includes(byTrack.get('ost_02_morning').id));
assert(referenced.includes(byTrack.get('ost_03_school_road').id));
for (const id of ['ost_04_playful', 'ost_05_after_school', 'ost_06_night']) {
  assert.equal(C.audioUsage(p, byTrack.get(id).id).length, 0, id + ' 不应被引用');
}

/* 3. 只有段落入口有音乐指令，其余句子靠继承 */
const withBgm = p.nodes.filter(n => n.audio && n.audio.bgm && n.audio.bgm.action === 'play');
assert.equal(withBgm.length, 2, '只应有两个场景入口写 play，实际 ' + withBgm.length);
assert.equal(withBgm.filter(n => n.audio.bgm.audioId === byTrack.get('ost_02_morning').id).length, 1);
assert.equal(withBgm.filter(n => n.audio.bgm.audioId === byTrack.get('ost_03_school_road').id).length, 1);
assert(p.nodes.filter(n => n.audio && n.audio.bgm).length <= 2, '不得逐句写背景音乐指令');

/* 4. 标题音乐独立存在，且能算进引用 */
assert(p.titleMusic && p.titleMusic.audioId === byTrack.get('ost_01_title').id, '标题音乐应指向主题曲');
assert.equal(p.titleMusic.loop, true, '标题音乐默认循环');
assert(C.audioUsage(p, p.titleMusic.audioId).some(u => u.where === '标题音乐'), '标题音乐要计入引用');

/* 5. 导出只内嵌被引用的三首，其余留在工程里 */
const report = {};
const html = buildPlayerHTML(inlineAssets(p, sampleDir), undefined, report);
assert.equal(report.audio.library, 6);
assert.equal(report.audio.included.length, 3, '包内只应有 3 首');
assert.equal(report.audio.excluded.length, 3, '应排除另外 3 首');
for (const a of report.audio.included) {
  assert(html.includes(a.id), '被引用的 ' + a.id + ' 应内嵌进 HTML');
}
for (const a of report.audio.excluded) {
  assert(!html.includes('"id":"' + a.id + '"'), '未引用的 ' + a.id + ' 不应进包');
}
assert(/data:audio\/ogg;base64,/.test(html), 'OGG 应内嵌为 data URI，不依赖外部文件');

/* 6. 磁盘往返保留标签与标题音乐（换机器/恢复备份不丢） */
assert(p.titleMusic && p.titleMusic.audioId, '读回后标题音乐仍在');
const reopened = store.openProject(sampleDir).project;
assert.deepEqual(reopened.audioAssets.map(a => a.meta.trackId).sort(),
  p.audioAssets.map(a => a.meta.trackId).sort(), '标签随工程保存');
assert.deepEqual(reopened.titleMusic, p.titleMusic);

/* 7. 剧情与演出没有被音乐改动波及：节点数、文本、表情引用保持 */
assert.equal(p.nodes.length, 45, '原作 45 个节点不得改动');
assert.equal(p.nodes.filter(n => n.speakerId).length > 0, true, '角色绑定仍在');
const sampleDisk = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.paper.json'), 'utf8'));
assert.equal(sampleDisk.nodes.filter(n => n.audio && n.audio.bgm).length, 2, '磁盘上也只有两个入口有音乐指令');

console.log('  ok  六首 OGG 入库，分类/情绪标签与 trackId 完整');
console.log('  ok  只有标题 + 两个场景入口引用音乐，其余句子继承');
console.log('  ok  导出只内嵌被引用的 3 首，磁盘往返保留标签与标题音乐');
