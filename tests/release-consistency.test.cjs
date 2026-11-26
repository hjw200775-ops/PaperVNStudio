'use strict';
/* V0.8.2 · M3-B · 发布运行时一致性回归（单文件 HTML 载体）
 *
 * 目的：证明「创作者在时间轴里编排的演出」完整进入正式发布产物，且不会因
 * 「只内嵌被引用素材」的裁剪逻辑而丢失仅在演出动作里出现的资源。
 *
 * 覆盖：
 *   1) node.performance.actions 全字段逐字段保留（id/type/target/params/duration/delay/
 *      easing/blocking/mode/enabled/start），含显式绝对 start 与相对 after/parallel 混排、
 *      同刻多动作、零时长、阻塞/非阻塞；
 *   2) 显式 start、duration、delay、mode、动作 ID、循环区间（loopStart/loopEnd/loopMode）、
 *      音频演出参数（fadeIn/curve/key/duck/volume）、Ducking 参数不丢失；
 *   3) 仅在演出动作中引用的 BGM（含交叉淡化）/ SFX / Voice / 背景图片必须被内嵌；
 *      完全未引用的音频必须被裁剪；图片裁剪开启时也不能漏掉演出引用；
 *   4) 共享运行时（player / core / effects / audio / performance）同源嵌入；
 *   5) 单文件 HTML 自包含：不引用 paper:// / pvres:// / papergame:// 或任何外部地址；
 *   6) 产物里的动作表经 PF.schedule 求得的排程顺序与编辑器端一致（确定性）。
 *
 * 本测试不启动 Electron，纯 Node 可复现；真实窗口验收见 scripts/v082m3b-release-verify.cjs。
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildGameHTML, assertSelfContained } = require('../dist/export.js');
const { paperPlayer, paperPlayerCSS } = require('../dist/player.js');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');
const createPaperAudio = require('../dist/audio.js');
const createPaperPerformance = require('../dist/performance.js');

const C = createVNCore();
const PF = createPaperPerformance();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const img = id => ({ id, name: id, kind: 'bg', width: 1, height: 1, data: 'data:image/png;base64,' + PNG });
const aud = id => ({ id, name: id, categories: ['bgm'], data: 'data:audio/wav;base64,' + WAV,
  mime: 'audio/wav', ext: 'wav', bytes: 44, duration: 1 });

/* 统一发布验收动作表：与 M3B 隔离测试工程使用同一套语义（不依赖具体图层）。 */
function releaseActions() {
  const mk = (id, type, target, params, dur, patch) => {
    const a = PF.make(id, type, target, { params, duration: dur });
    if (patch) Object.assign(a, patch);
    return a;
  };
  return [
    /* 相对（无 start）与显式绝对（有 start）混排 */
    mk('m3b_rel_fade', 'screen.fade', '', { to: 60, color: 'black' }, 0.5, { mode: 'after', blocking: false, delay: 0.1 }),
    mk('m3b_abs_zoom', 'camera.zoom', '', { scale: 125 }, 0.8, { start: 1.2, mode: 'parallel' }),
    mk('m3b_abs_char', 'character.move', 'char:lin', { x: 55, y: 70 }, 0.8, { start: 1.2, mode: 'parallel', blocking: true }),
    /* 零时长瞬时事件 + 同刻多动作（确定性排序靠列表顺序） */
    mk('m3b_zero_flash', 'screen.flash', '', { color: 'white' }, 0, { start: 2.0 }),
    mk('m3b_same_a', 'audio.sfx.play', '', { audioId: 'sfx_perf_only', volume: 85, key: 'k_a' }, 0.3, { start: 3.0 }),
    mk('m3b_same_b', 'audio.voice.play', '', { audioId: 'voice_perf_only', volume: 100, duck: true }, 0.5, { start: 3.0 }),
    /* 仅在演出动作里引用的背景 / BGM（交叉淡化）/ 循环区间 / 音频演出参数 */
    mk('m3b_bg_only', 'background.change', 'bg', { assetId: 'bg_perf_only', transition: 'crossfade' }, 0.8, { start: 3.4 }),
    mk('m3b_crossfade', 'audio.bgm.crossfade', '',
      { audioId: 'bgm_perf_only', volume: 70, duration: 1.6, curve: 'equalPower', loopMode: 'region', loopStart: 0.25, loopEnd: 0.8 },
      1.6, { start: 3.6 }),
    mk('m3b_duck', 'audio.ducking', '', { enabled: true, level: 35, attack: 0.22, release: 0.8 }, 0.3, { start: 3.6 }),
    mk('m3b_nonblock', 'character.opacity', 'char:lin', { opacity: 60 }, 0.5, { start: 5.0, blocking: false, mode: 'after' })
  ];
}

function releaseProject() {
  const p = C.sample();
  p.title = 'M3B 发布运行时一致性测试';
  /* 图层只引用 bg_layer；bg_perf_only 只出现在演出动作里；unused_img 完全未被引用。 */
  p.assets = [img('bg_layer'), img('bg_perf_only'), img('unused_img')];
  p.audioAssets = [aud('bgm_perf_only'), aud('sfx_perf_only'), aud('voice_perf_only'), aud('unused_audio')];
  p.nodes[0].sceneMode = 'own';
  p.nodes[0].layers = [{ id: 'L1', asset: 'bg_layer', name: '背景', kind: 'bg', x: 0, y: 0, w: 100, h: 100,
    fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none' }];
  p.nodes[0].performance = { version: 1, actions: releaseActions() };
  /* 不设置 titleMusic / node.audio 引用，保证四个 *_perf_only 素材「只在演出动作里被引用」。 */
  assert(C.validate(p), '测试工程必须通过核心校验');
  return p;
}

const deps = () => ({ player: paperPlayer, coreFactory: createVNCore, effectFactory: createPaperEffects,
  audioFactory: createPaperAudio, performanceFactory: createPaperPerformance, css: paperPlayerCSS, esc });

/* 用一个只捕获入参的假 player 工厂执行内嵌 <script>，取出产物里真正的工程数据。
   buildGameHTML 生成的是 `(player)(data, coreFactory, effects, audio, performance)`，
   其余工厂只作为函数表达式求值、不会执行，因此无需 DOM stub。 */
function embeddedProject(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(m, '导出 HTML 必须含内嵌脚本');
  const sandbox = { __captured: null };
  vm.runInNewContext(m[1], sandbox, { timeout: 5000 });
  assert(sandbox.__captured, '内嵌脚本没有把工程数据交给播放器');
  /* 跨 vm realm 的对象原型不同，deepStrictEqual 会因 realm 而非内容判失败；
     规整回当前 realm 后再比较，不改变任何字段，也不放宽断言。 */
  return JSON.parse(JSON.stringify(sandbox.__captured));
}
function captureHTML(p, extra) {
  const capture = function (project) { globalThis.__captured = project; };
  return buildGameHTML(p, Object.assign(deps(), { player: capture }, extra || {}));
}

const p = releaseProject();
const acts = p.nodes[0].performance.actions;

/* ---------- 1. 演出数据逐字段完整进入产物 ---------- */
const html = captureHTML(p);
assertSelfContained(html);
const got = embeddedProject(html);
const gotActs = got.nodes[0].performance.actions;
assert.equal(got.nodes[0].performance.version, 1, '演出版本号必须保留');
assert.equal(gotActs.length, acts.length, '动作数量不能变');
assert.deepEqual(gotActs, acts, '演出动作必须逐字段原样进入单文件 HTML（含 start / delay / mode / params）');

/* 逐项点名任务要求的字段，避免 deepEqual 通过但语义被悄悄合并 */
const byId = new Map(gotActs.map(a => [a.id, a]));
assert.equal(byId.get('m3b_abs_zoom').start, 1.2, '显式绝对 start 必须保留');
assert.equal(byId.get('m3b_abs_char').start, 1.2, '同刻多动作的 start 必须保留');
assert.equal(byId.get('m3b_rel_fade').start, undefined, '相对动作不能被补写绝对 start');
assert.equal(byId.get('m3b_rel_fade').delay, 0.1, 'delay 必须保留');
assert.equal(byId.get('m3b_abs_char').mode, 'parallel', 'parallel 模式必须保留');
assert.equal(byId.get('m3b_rel_fade').mode, 'after', 'after 模式必须保留');
assert.equal(byId.get('m3b_abs_char').blocking, true, '阻塞标记必须保留');
assert.equal(byId.get('m3b_nonblock').blocking, false, '非阻塞标记必须保留');
assert.equal(byId.get('m3b_zero_flash').duration, 0, '零时长事件必须保留');
assert.equal(byId.get('m3b_same_a').target, '', '动作 target 必须保留');
assert.ok(byId.get('m3b_rel_fade').easing, '缓动字段必须保留');
assert.ok(byId.get('m3b_rel_fade').enabled === true, '启用标记必须保留');
for (const a of gotActs) assert.equal(typeof a.id, 'string', '动作 ID 必须保留且为字符串');

/* ---------- 2. 循环区间 / 音频演出参数完整 ---------- */
const cf = byId.get('m3b_crossfade').params;
assert.deepEqual(
  { audioId: cf.audioId, volume: cf.volume, duration: cf.duration, curve: cf.curve, loopMode: cf.loopMode, loopStart: cf.loopStart, loopEnd: cf.loopEnd },
  { audioId: 'bgm_perf_only', volume: 70, duration: 1.6, curve: 'equalPower', loopMode: 'region', loopStart: 0.25, loopEnd: 0.8 },
  '交叉淡化的音频演出参数与循环区间不能丢失');
assert.deepEqual(byId.get('m3b_duck').params,
  { enabled: true, level: 35, attack: 0.22, release: 0.8 }, 'Ducking 参数不能丢失');
assert.equal(byId.get('m3b_same_a').params.key, 'k_a', 'SFX 独立 key 不能丢失');
assert.equal(byId.get('m3b_same_b').params.duck, true, 'Voice duck 参数不能丢失');
assert.equal(PF.schedule(gotActs).length, acts.length, '产物动作表必须可正常排程');
assert.deepEqual(PF.schedule(gotActs).map(s => s.action.id), PF.schedule(acts).map(s => s.action.id),
  '产物里的排程顺序（同刻确定性）必须与编辑器一致');

/* ---------- 3. 仅在演出动作中引用的素材不能被裁剪 ---------- */
const report = {};
const htmlWithReport = captureHTML(p, { report });
assert(htmlWithReport.length > 0);
assert(report.resources, '导出报告应含资源裁剪统计');
const includedAudio = new Set(report.audio.included.map(a => a.id));
for (const id of ['bgm_perf_only', 'sfx_perf_only', 'voice_perf_only']) {
  assert(includedAudio.has(id), '仅在演出动作中引用的音频被错误裁剪：' + id);
  assert(html.includes(id), '单文件 HTML 缺少仅在演出动作中引用的音频：' + id);
  assert(html.includes('data:audio/wav;base64,'), '音频必须以 data URI 内嵌');
}
assert(!includedAudio.has('unused_audio'), '完全未引用的音频应被裁剪');
assert(!html.includes('unused_audio'), '单文件 HTML 不应携带未引用音频');
assert(html.includes('bg_perf_only'), '仅在 background.change 里引用的背景图片必须内嵌');

/* 引用裁剪开启时（目录版 / ZIP 由发布构建器走这条），演出引用同样不能漏 */
const filtered = captureHTML(p, { filterImages: true });
const filteredProject = embeddedProject(filtered);
const keptImg = new Set(filteredProject.assets.map(a => a.id));
assert(keptImg.has('bg_layer'), '图层引用的图片必须保留');
assert(keptImg.has('bg_perf_only'), '仅演出动作引用的背景图片不能被裁剪');
assert(!keptImg.has('unused_img'), '未引用图片在裁剪模式下应被排除');
assert.deepEqual(filteredProject.nodes[0].performance.actions, acts, '图片裁剪不得改动演出动作表');

/* core 的引用扫描是裁剪的唯一事实来源：显式断言它覆盖演出动作 */
const refAudio = new Set(C.referencedAudioIds(p));
for (const id of ['bgm_perf_only', 'sfx_perf_only', 'voice_perf_only']) {
  assert(refAudio.has(id), 'referencedAudioIds 漏掉演出音频引用：' + id);
}
assert(new Set(C.referencedImageIds(p)).has('bg_perf_only'), 'referencedImageIds 漏掉演出背景引用');

/* ---------- 4. 共享运行时同源嵌入（必须用真实 player 工厂生成的产物检查） ---------- */
const realHtml = buildGameHTML(p, deps());
assertSelfContained(realHtml);
for (const mark of ['audio.bgm.crossfade', 'perfAudioAction', 'playbackStats', 'createPaperPerformance', 'createPaperAudio']) {
  assert(realHtml.includes(mark), '单文件 HTML 缺少共享运行时片段：' + mark);
}
assert(realHtml.includes('PF.schedule') || realHtml.includes('.schedule('), '演出排程运行时必须随产物发布');
assert(realHtml.includes('paperPlayer') || realHtml.includes('function paperPlayer'), '正式播放器必须随产物发布');

/* ---------- 5. 单文件 HTML 资源地址必须全部内嵌（不依赖本机协议） ----------
   注意：运行时代码里出现 pvres:// / papergame:// 字符串是「预览与包内模式的判断注释」，
   不是资源依赖；因此断言对象是内嵌工程里的资源 data 与结构部分，而不是整段脚本文本。 */
const resourceUrls = [
  ...got.assets.map(a => a.data || ''),
  ...got.audioAssets.map(a => a.data || '')
];
assert(resourceUrls.length > 0, '产物必须携带资源');
for (const u of resourceUrls) {
  assert(/^data:(image\/(png|jpeg|webp)|audio\/[a-z0-9.+-]+);base64,/i.test(u),
    '单文件 HTML 的资源必须是内嵌 data URI，实际：' + String(u).slice(0, 60));
}
const structural = realHtml.split('<script>')[0];
for (const proto of ['paper://', 'pvres://', 'papergame://']) {
  assert(!structural.includes(proto), '结构部分不应依赖 ' + proto);
}
assert(!/<script[^>]+\bsrc=/i.test(realHtml), '单文件 HTML 不得引用外部脚本');
assert(!/\b(?:src|href)\s*=\s*["'](?:file:\/\/|https?:\/\/)/i.test(structural),
  '结构部分不得含本机 / 远程地址');

/* ---------- 6. 目录版 / 包内模式（papergame://）同样完整携带演出数据 ---------- */
const external = JSON.parse(JSON.stringify(p));
for (const a of external.assets) a.data = 'papergame://asset/' + a.id;
for (const a of external.audioAssets) a.data = 'papergame://audio/' + a.id;
const extHtml = captureHTML(external, { mode: 'external' });
const extProject = embeddedProject(extHtml);
assert.deepEqual(extProject.nodes[0].performance.actions, acts,
  '包内模式（papergame://）同样不能改动演出动作表');
for (const a of extProject.assets) assert(/^papergame:\/\//.test(a.data), '包内模式资源地址应为 papergame://');
assert(extProject.audioAssets.every(a => /^papergame:\/\//.test(a.data)), '包内模式音频地址应为 papergame://');
const extIncluded = new Set(extProject.audioAssets.map(a => a.id));
for (const id of ['bgm_perf_only', 'sfx_perf_only', 'voice_perf_only']) {
  assert(extIncluded.has(id), '包内模式也不能裁剪仅在演出动作里引用的音频：' + id);
}

console.log('PASS: V0.8.2-M3B 发布运行时一致性（演出数据全字段 / 演出专属素材不裁剪 / 共享运行时同源 / 单文件自包含）');
