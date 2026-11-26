/* V0.8.2 · M2-B · 时间轴预览音频驱动（纯逻辑，可注入、可测试）
 *
 * 时间轴预览的音频消费者：订阅 7 个预览事件（previewStart/Pause/Resume/Seek/Stop/Loop/End）
 * 与每帧 onTick(t)，让视觉单调时钟与音频事件按时间轴对齐，又不重写音频引擎。
 * 本文件不含 DOM、不持有工程引用；所有依赖由调用方注入，因此可在 Node 中用 mock runtime
 * 做确定性单测，浏览器里由 app.js 注入真实 runtime / perfAudioAction。
 *
 * 关键不变式（与 stateAt 的「t <= slot.start 即跳过」语义严格互补）：
 *   · applyStateAt(t) 落地的是「严格小于 t」的历史累积（BGM/bus/ducking 目标状态），
 *     因此从任意时间开始 / seek / 循环回绕时，一次性落地终态、绝不重放历史切换过程。
 *   · scan(from, to) 触发「>= from」的音频事件（含 bgm/sfx/voice/bus/ducking），
 *     正常播放复用 perfAudioAction；首次推进用闭区间 [from, to]（起点事件要命中），
 *     之后用半开区间 (from, to]（上一帧已处理到 from，绝不重复触发）。
 *   · 一次性音频（SFX/Voice）只在正常向前推进时触发；seek/start 只落状态、不重放历史。
 *   · 暂停/停止/seek 递增代际并清空在途任务，过期异步结果由 audio.js 的 loadSeq 丢弃。
 * 竞态与生命周期：复用 audio.js 既有 generation/loadSeq；driver 自身维护 active/lastT，
 * 停止即 stopAll()，不遗留无主播放节点。
 */
function createPreviewAudioDriver(opts) {
  const o = opts || {};
  const PF = o.PF, TL = o.TL;
  const P = o.P || null;
  const getActions = o.getActions || (() => []);
  const getLayers = o.getLayers || (() => []);
  const getBefore = o.getBefore || (() => (PF ? PF.emptyState() : {}));
  const perfAudioAction = o.perfAudioAction || (() => {});
  const rt = o.runtime || (() => null);
  const hint = o.hint || (() => {});
  const now = o.now || (() => Date.now());
  let active = false, lastT = 0, boundaryInclusive = false, bgmOffset = 0;
  const dbg = { applies: 0, fired: 0, oneShots: 0, stateEvents: 0, stops: 0,
    last: '', err: '', lastT: 0, active: false, bgmOffset: 0, recent: [] };

  function currentRuntime() { try { return rt(); } catch (e) { return null; } }

  function audioTarget(t) {
    const before = getBefore(), acts = getActions(), layers = getLayers();
    try {
      const st = TL.scrubState(before, acts, t, { P, layers });
      return st && st.audio;
    } catch (e) { dbg.err = String((e && e.message) || e); return null; }
  }
  function applyStateAt(t, offset) {
    const r = currentRuntime(), audio = audioTarget(t);
    if (!r || !audio) return false;
    try {
      r.applyAudioState(audio, offset != null ? { offset: Number(offset) || 0 } : undefined);
      dbg.applies++; hint(); return true;
    } catch (e) { dbg.err = String((e && e.message) || e); return false; }
  }
  function audioSlotsSorted() {
    const acts = getActions();
    if (!acts || !acts.length) return [];
    return PF.schedule(acts)
      .filter((s) => PF.isAudioType(s.action.type))
      .sort((a, b) => a.start - b.start);   /* 稳定排序：同 start 保持动作列表原始顺序，确定执行顺序 */
  }
  function inRange(start, from, to, inclusive) {
    return inclusive ? (start >= from && start <= to) : (start > from && start <= to);
  }
  function scan(from, to, inclusive) {
    const slots = audioSlotsSorted();
    let fired = 0;
    for (const s of slots) {
      if (!inRange(s.start, from, to, inclusive)) continue;
      try {
        perfAudioAction(s.action);
        fired++; dbg.last = s.action.type;
        dbg.recent.push({ type: s.action.type, planned: +s.start.toFixed(3), wall: now() });
        if (dbg.recent.length > 60) dbg.recent.shift();
        if (TL.isOneShotAudio(s.action.type)) dbg.oneShots++; else dbg.stateEvents++;
      } catch (e) { dbg.err = String((e && e.message) || e); }
    }
    dbg.fired += fired;
    return fired;
  }
  function stopAudio(recordPos) {
    const r = currentRuntime();
    if (!r) return;
    if (recordPos) {
      try { const snap = r.snapshot(); if (snap && snap.bgm && Number.isFinite(snap.bgm.time)) bgmOffset = Number(snap.bgm.time) || 0; } catch (e) {}
    }
    try { r.stopAll(); } catch (e) { dbg.err = String((e && e.message) || e); }
    dbg.stops++; hint();
  }

  function onEvent(name, e) {
    const t = Number(e && e.t) || 0;
    switch (name) {
      case 'previewStart':                 /* 从头或任意时间开始：落地状态、起点事件首个推进命中 */
        active = true; lastT = t; boundaryInclusive = true; bgmOffset = 0;
        applyStateAt(t);
        break;
      case 'previewResume':                /* 继续：按暂停时记录的位置恢复 BGM */
        active = true; lastT = t; boundaryInclusive = true;
        applyStateAt(t, bgmOffset);
        break;
      case 'previewSeek':                  /* 拖动定位：只落状态音频，绝不重放一次性事件 */
        lastT = t; boundaryInclusive = false;
        applyStateAt(t);
        break;
      case 'previewLoop':                  /* 区间回绕到 a：重建 a 时刻状态，区间内事件下一轮重新触发 */
        active = true; lastT = t; boundaryInclusive = true; bgmOffset = 0;
        applyStateAt(t);
        break;
      case 'previewPause':                 /* 暂停：画面冻结，音频同步停，记录 BGM 位置供继续恢复 */
        active = false;
        stopAudio(true);
        break;
      case 'previewStop':                  /* 停止：清理本预览全部播放任务，恢复起点，无残留声音 */
        active = false; lastT = 0; boundaryInclusive = false; bgmOffset = 0;
        stopAudio(false);
        break;
      case 'previewEnd':                   /* 自动结束：补扫最后一段，一次性音频自然收尾 */
        if (active && t > lastT) scan(lastT, t, boundaryInclusive);
        active = false; boundaryInclusive = false;
        break;
      default: break;
    }
    dbg.lastT = lastT; dbg.active = active; dbg.bgmOffset = bgmOffset;
  }
  function onTick(t) {
    if (!active) return;
    const to = Number(t) || 0;
    if (to <= lastT) return;               /* 定位/回绕的立即 tick：不前进，保留 boundaryInclusive */
    scan(lastT, to, boundaryInclusive);
    lastT = to;
    boundaryInclusive = false;
    dbg.lastT = lastT;
  }
  function dispose() { active = false; lastT = 0; boundaryInclusive = false; bgmOffset = 0; stopAudio(false); }
  return { onEvent, onTick, dispose, debug: () => ({ ...dbg }) };
}
if (typeof module !== 'undefined') module.exports = createPreviewAudioDriver;
