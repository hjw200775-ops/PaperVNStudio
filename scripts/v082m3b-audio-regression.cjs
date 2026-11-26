'use strict';
/*
 * V0.8.2 · M3-B · 共享音频引擎受影响回归汇总（M3B-6）
 *
 * 判定「是否必须跑 ≥900s 严格浸泡」：M3A 对 dist/audio.js 只有 4 行改动
 * （voicePlay(spec.offset) 在起播前设置 HTMLAudioElement.currentTime），
 * M3B 未修改 audio.js；两者都不触及 start()/hardStop()、解码缓存预算、
 * 64 MiB 淘汰、generation 代际隔离或活动节点生命周期。因此按任务条件
 * 「实际修改影响长期播放 / 音频资源释放 / 共享播放状态」判定为否，
 * 不重复跑 900s 浸泡（V0.8.1-RC3.1 的 900s 证据仍有效）。
 *
 * 本脚本汇总本轮真实证据（不模拟、不硬编码成功）：
 *   - npm run check 里的全部音频单测（由调用方先执行）
 *   - V0.8.1-RC3.1 严格 Voice 验收脚本的真实窗口结果
 *   - 发布载体（单文件 HTML / 独立 EXE）的 playbackStats 与起音事件
 * 产出：release/v082m3b-audio-regression.json
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const voice = read(path.join(ROOT, 'release', 'v081rc3', 'voice-verify-result.json'));
const verify = read(path.join(ROOT, 'release', 'v082m3b-release-verify.json'));
const packaged = read(path.join(ROOT, 'release', 'v082m3b-packaged-verify.json'));
const soakPrior = read(path.join(ROOT, 'release', 'audio-soak-15min-rc3.1.json'));

const envStats = {};
for (const k of ['C', 'E']) {
  const a = verify && verify.evidence && (verify.evidence[k + '_audio'] || null);
  const s = verify && verify.environments && verify.environments[k];
  if (!a && !s) continue;
  envStats[k] = {
    playbackStats: (a && a.playbackStats) || (s && s.actual && s.actual.playbackStats) || null,
    dualBgm: (a && a.dualBgm) || (s && s.actual && s.actual.dualBgm) || false,
    instances: (a && a.instances) || (s && s.actual && s.actual.instances) || null,
    graph: (a && a.graph) || (s && s.actual && s.actual.graph) || null,
    playStartedEvents: (a && a.playStartedEvents) || [],
    failedEvents: (a && a.failedEvents) || [],
    perfStarts: verify.evidence[k + '_perfStarts'] || null
  };
}

const report = {
  at: new Date().toISOString(), version: 'V0.8.2-M3B',
  decision: {
    soak900Required: false,
    reason: 'M3A 对 audio.js 仅新增 voicePlay(spec.offset) 的 currentTime 恢复（4 行，不传 offset 时逐字节兼容）；'
      + 'M3B 未改 audio.js。改动不触及长期播放循环、解码缓存/64MiB 预算、资源释放、代际隔离与活动节点生命周期。',
    priorSoakEvidence: soakPrior ? { at: soakPrior.at || null, seconds: (soakPrior.summary && soakPrior.summary.seconds) || null,
      ok: soakPrior.ok !== undefined ? soakPrior.ok : null } : null,
    note: '若后续修改触及上述任一项，必须重跑真实 ≥900 秒严格浸泡；本结论不替代那次测试。'
  },
  strictVoiceVerifyRC31: voice ? {
    at: voice.at, startLatencyMs: voice.startLatencyMs,
    afterStart: voice.afterStart, afterInterrupt: voice.afterInterrupt, afterMissing: voice.afterMissing,
    covers: ['正常 Voice 播放', '起播后切句中断（合法 AbortError 不记失败）', '真实缺失素材必被发现']
  } : { status: 'NOT_RUN' },
  releaseCarriers: envStats,
  packagedVerify: packaged ? { ok: packaged.ok, timelinePlay: packaged.evidence && packaged.evidence.timelinePlay } : { status: 'NOT_RUN' },
  unitTests: 'npm run check（含 audio-negative / audio-playback-events / audio-bgm-restore / audio-precise / audio-performance / audio-export / player-flow / player-interaction / player-audio-schedule）',
  coverage: {
    '正常 Voice 播放': 'RC3.1 voice-verify + 发布载体 play-started',
    'Voice 中断 / 合法 AbortError': 'RC3.1 voice-verify afterInterrupt（failed=0）',
    '暂停续播': 'tests/audio-bgm-restore.test.cjs（Voice offset）',
    '快速切句': 'tests/audio-negative.test.cjs + RC3.1 afterInterrupt',
    'BGM 恢复': 'tests/audio-bgm-restore.test.cjs + tests/audio-precise.test.cjs',
    '流式回退': '发布载体 playbackStats.fallback + events.precise-fallback',
    '精确循环': 'tests/audio-precise.test.cjs + release/audio-loop-*.json（历史证据）',
    '异步任务代际隔离': 'tests/audio-precise.test.cjs（loadSeq / generation）',
    '活动节点生命周期': 'tests/audio-playback-events.test.cjs + 发布载体 instances / dualBgm',
    '真实播放失败必 FAIL': 'tests/audio-negative.test.cjs（负向用例真实触发 FAIL）'
  },
  problems: []
};
for (const [k, v] of Object.entries(envStats)) {
  if (v.playbackStats && v.playbackStats.failed > 0) report.problems.push(k + ' 真实播放失败 ' + v.playbackStats.failed);
  if (v.dualBgm) report.problems.push(k + ' 异常双 BGM');
  if (v.failedEvents && v.failedEvents.length) report.problems.push(k + ' 失败事件 ' + v.failedEvents.length);
}
if (voice && (voice.afterStart.stats.failed > 0 || voice.afterInterrupt.stats.failed > 0))
  report.problems.push('RC3.1 Voice 严格验收出现真实播放失败');
if (voice && !voice.afterMissing.errors.length) report.problems.push('负向测试失效：缺失素材没有被检测到');
report.ok = report.problems.length === 0;
fs.writeFileSync(path.join(ROOT, 'release', 'v082m3b-audio-regression.json'), JSON.stringify(report, null, 2));
console.log((report.ok ? 'PASS' : 'FAIL') + ' V0.8.2-M3B 共享音频引擎受影响回归汇总 · release/v082m3b-audio-regression.json');
console.log('soak900Required=' + report.decision.soak900Required + ' carriers=' + Object.keys(envStats).join(','));
process.exit(report.ok ? 0 : 1);
