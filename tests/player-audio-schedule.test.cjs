'use strict';
/* V0.8.2 · M3-B · 正式播放器音频演出调度方向（缺陷回归）
 *
 * M3B 实机发现的缺陷：dist/player.js 把 `!animate||prefersReduced()`（reduced 语义）
 * 传给参数名为 animate（「是否按时间轴挂定时器执行一次性音频」）的 runAudioPerformance。
 * 后果（双向）：
 *   正常播放（animate=true, reduced=false）→ 收到 false → 直接落终态，SFX/Voice 永不触发；
 *   读档/返回（animate=false）           → 收到 true  → 反而重放历史一次性音频。
 * 编辑器试玩走 app.js 的 syncPerfAudio，没有这个参数，所以 M3A 的三环境语义一致性
 * 测试发现不了；只有真实发布载体（单文件 HTML / 目录版 EXE）才会暴露。
 *
 * 本测试固化「参数方向」契约，防止再次取反；真实播放行为证据由
 * scripts/v082m3b-release-verify.cjs 在发布载体窗口里采集（play-started / playbackStats）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'dist', 'player.js'), 'utf8');

/* 1. 调用点：第 4 参必须是「正常播放且未减少动态效果」 */
/* 第一次出现是函数定义（第 4 参名为 animate），最后一次才是调用点；
   参数里含 prefersReduced() 的括号，因此按整行取到 `);` 为止 */
const lines = src.split('\n').filter(l => l.includes('runAudioPerformance(acts,before,after,'));
assert(lines.length >= 2, '找不到 runAudioPerformance 定义与调用点');
const callLine = lines[lines.length - 1];
const m = callLine.match(/runAudioPerformance\(acts,before,after,(.+)\);/);
assert(m, '调用点格式异常');
assert.equal(m[1].trim(), 'animate&&!prefersReduced()',
  'runAudioPerformance 的第 4 参被改回 reduced 语义：正常播放将不再触发 SFX/Voice');

/* 2. PF.play 的 reduced 参数语义不能被连带改错 */
const play = src.match(/PF\.play\(\{[^}]*reduced:\s*([^,}]+)/);
assert(play, '找不到 PF.play 的 reduced 参数');
assert.equal(play[1].trim(), '!animate||prefersReduced()',
  'PF.play 的 reduced 应保持「读档/返回/减少动态效果时直接落终态」');

/* 3. 执行器内部：animate=false 必须只落状态、绝不挂定时器 */
const body = src.slice(src.indexOf('function runAudioPerformance'), src.indexOf('function runPerformance'));
assert(/if\s*\(\s*!animate\s*\)\s*\{\s*audio\.applyAudioState\(perfAudioTarget\);return\s*\}/.test(body),
  'animate=false 分支必须直接落终态并 return');
assert(/setTimeout\(\(\)=>\{[\s\S]*?perfAudioAction\(s\.action\)/.test(body),
  'animate=true 分支必须按 slot 的 start 挂定时器执行音频动作');
assert(/s\.start\)\*1000/.test(body), '定时器延迟必须由 slot.start 决定（显式绝对 / 相对混排共用）');

/* 4. 调度槽来自 PF.schedule 且只过滤音频动作（与编辑器、时间轴预览同源） */
assert(/PF\.schedule\(acts\)\.filter\(s=>PF\.isAudioType\(s\.action\.type\)\)/.test(body),
  '音频槽必须由 PF.schedule 产生，不能另起一套排程');
assert(/if\(state!=='playing'\)return/.test(body), '换句后未执行的定时器必须作废（generation 语义）');

/* 5. 读档/跳过的结算路径不得重放一次性音频 */
const skip = src.slice(src.indexOf('function perfSkip'), src.indexOf('/* ---------- 舞台绘制'));
assert(/clearPerfAudio\(\)/.test(skip) && /applyAudioState\(perfAudioTarget\)/.test(skip),
  '跳过演出必须取消未执行音频动作并落终态，不重放历史 SFX/Voice');

/* 6. 编辑器试玩的等价执行器仍保持自己的方向（不因修复播放器而被误改） */
const app = fs.readFileSync(path.join(ROOT, 'dist', 'app.js'), 'utf8');
assert(/function syncPerfAudio\(\s*acts\s*,\s*before\s*,\s*after\s*,\s*fresh\s*\)/.test(app),
  '编辑器试玩 syncPerfAudio 签名不应被改动');
assert(/perfAudioTimers\.push\(setTimeout/.test(app),
  '编辑器试玩仍按 slot.start 挂定时器，与播放器语义等价');

console.log('PASS: V0.8.2-M3B 正式播放器音频演出调度方向正确（正常播放触发 / 读档不重放）');
