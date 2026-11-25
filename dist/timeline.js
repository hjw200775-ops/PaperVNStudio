/* V0.8.2-M0 · 时间轴数据层（Timeline Data Layer）
 *
 * 把「动作列表」升级为「可视化多轨演出编辑器」的统一数据入口，不重写 performance.js 的
 * 调度（schedule）与求值（stateAt）。关键原则：
 *
 *   单一数据源：动作列表（node.performance.actions）是唯一事实来源。
 *   时间轴事件是它的「物化视图」（带绝对 start/end），编辑时把时间写回动作的 start 字段。
 *   不维护两份独立数据，因此不可能失去同步。
 *
 * 时间语义：
 *   - 旧工程（无 start）：after / parallel + delay 简写，schedule() 算出绝对时间（不变）。
 *   - 时间轴（有 start）：start 字段优先，schedule() 直接按绝对时间排。
 *
 * 音频副作用：
 *   - 状态音频（BGM/总线/Ducking）进 stateAt() 的目标状态，拖动播放头可安全求值。
 *   - 一次性音频（SFX/Voice）是外部副作用，只在正常播放的起点触发，拖动播放头不重放。
 */
function createTimeline(PF) {
  const TRACKS = {
    'background.change': '背景',
    'camera.move': '镜头', 'camera.zoom': '镜头',
    'screen.fade': '特效', 'screen.flash': '特效', 'screen.shake': '特效',
    'audio.bgm.play': 'BGM', 'audio.bgm.stop': 'BGM', 'audio.bgm.crossfade': 'BGM',
    'audio.bgm.volume': 'BGM', 'audio.bgm.loop': 'BGM',
    'audio.sfx.play': 'SFX', 'audio.sfx.stop': 'SFX',
    'audio.voice.play': 'Voice', 'audio.voice.stop': 'Voice',
    'audio.bus.volume': '混音', 'audio.ducking': '混音',
    wait: '等待'
  };
  const CHAR_TYPES = ['character.show', 'character.hide', 'character.move', 'character.scale', 'character.opacity', 'character.expression', 'character.bob'];

  /* 动作 → 轨道名。角色按 char:<id> 拆子轨道，为未来多角色子轨道预留。 */
  function trackOf(action) {
    const t = action && action.type;
    if (CHAR_TYPES.indexOf(t) >= 0) {
      const cid = String((action.target || '') === 'bg' ? '' : (action.target || '')).replace(/^char:/, '');
      return cid ? ('角色·' + cid) : '角色';
    }
    return TRACKS[t] || '其他';
  }
  function isOneShotAudio(type) {
    return type === 'audio.sfx.play' || type === 'audio.sfx.stop' ||
      type === 'audio.voice.play' || type === 'audio.voice.stop';
  }

  /* 物化视图：动作列表 → 带绝对 start/end 的事件。action 保留完整引用，绝无信息丢失。 */
  function toTimeline(actions) {
    const slots = PF.schedule(actions || []);
    return slots.map((s) => ({
      action: s.action,
      id: s.action.id, type: s.action.type, target: s.action.target,
      start: +s.start.toFixed(3), end: +s.end.toFixed(3),
      duration: s.action.duration || 0, blocking: !!s.blocking,
      track: trackOf(s.action), oneShot: isOneShotAudio(s.action.type)
    }));
  }

  /* 播放头定位：返回 t 时刻的舞台状态（含状态音频目标，不含一次性音效/配音）。
     复用 stateAt，与正常播放、跳过完全同一套求值。t=Infinity 即终态。 */
  function scrubState(before, actions, t, ctx) {
    return PF.stateAt(before, actions, t, ctx);
  }

  /* 正常播放时，某个时间点应触发的一次性音频（SFX/Voice）。拖动播放头不调用它。 */
  function audioSideEffectsAt(actions, t) {
    const eps = 0.001;
    return PF.schedule(actions || []).filter((s) =>
      isOneShotAudio(s.action.type) && s.start <= t + eps && s.start >= t - eps);
  }

  /* 把时间写回动作（单一数据源就地更新；撤销/重做由调用方 checkpoint 处理）。 */
  function setStart(action, t) {
    const v = Number(t);
    action.start = Number.isFinite(v) && v >= 0 ? +v.toFixed(3) : 0;
    return action;
  }
  function clearStart(action) { delete action.start; return action; }

  function totalDuration(actions) { return PF.totalDuration(actions); }
  function blockUntil(actions) { return PF.blockUntil(actions); }

  return { toTimeline, scrubState, audioSideEffectsAt, setStart, clearStart, totalDuration, blockUntil, trackOf, isOneShotAudio };
}
if (typeof module !== 'undefined') module.exports = createTimeline;
