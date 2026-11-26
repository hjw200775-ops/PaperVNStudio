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
  let active = false, lastT = 0, boundaryInclusive = false, bgmOffset = 0, voiceResume = null;
  let startWall = 0, startT = 0, anchorSet = false;   /* 音画同步锚点：预览起播时的墙钟与计划时间 */
  const syncSamples = [];                 /* 每个音频事件的计划时间 vs 实际派发时间偏差 */
  const STALE_MS = 500;                   /* 一次性音频的「严重过期」阈值：超过则不补发 */
  const dbg = { applies: 0, fired: 0, oneShots: 0, stateEvents: 0, stops: 0, skippedStale: 0,
    last: '', err: '', lastT: 0, active: false, bgmOffset: 0, voiceResume: null, recent: [] };

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
  function recordSync(planned) {
    if (!anchorSet) return;
    const dispatched = now();
    const expected = startWall + (planned - startT) * 1000;
    syncSamples.push({ planned: +planned.toFixed(3), driftMs: +(dispatched - expected).toFixed(2) });
    if (syncSamples.length > 4000) syncSamples.shift();
  }
  function scan(from, to, inclusive) {
    const slots = audioSlotsSorted();
    let fired = 0;
    for (const s of slots) {
      if (!inRange(s.start, from, to, inclusive)) continue;
      const oneShot = TL.isOneShotAudio(s.action.type);
      /* 掉帧恢复后「严重过期」的一次性音频跳过补发，避免渲染恢复瞬间播放大量历史音效。
         持久状态命令（BGM/总线音量/循环/Ducking）永远不跳过，恢复到当前正确状态；
         短时掉帧（≤ STALE_MS）仍按「执行」规则补触发，不无声遗漏。 */
      if (oneShot && anchorSet && (to - s.start) * 1000 > STALE_MS) {
        dbg.skippedStale++;
        dbg.recent.push({ type: s.action.type, planned: +s.start.toFixed(3), wall: now(), skipped: 'stale' });
        if (dbg.recent.length > 60) dbg.recent.shift();
        continue;
      }
      try {
        perfAudioAction(s.action);
        fired++; dbg.last = s.action.type;
        recordSync(s.start);
        dbg.recent.push({ type: s.action.type, planned: +s.start.toFixed(3), wall: now() });
        if (dbg.recent.length > 60) dbg.recent.shift();
        if (oneShot) dbg.oneShots++; else dbg.stateEvents++;
      } catch (e) { dbg.err = String((e && e.message) || e); }
    }
    dbg.fired += fired;
    return fired;
  }
  function stopAudio(recordPos) {
    const r = currentRuntime();
    if (!r) return;
    if (recordPos) {
      try {
        const snap = r.snapshot();
        if (snap && snap.bgm && Number.isFinite(snap.bgm.time)) bgmOffset = Number(snap.bgm.time) || 0;
        /* M3A：暂停即保存正在播的 Voice 位置，继续时续播剩余部分（不再从头重播）。 */
        if (snap && snap.voice && snap.voice.audioId && Number.isFinite(snap.voice.time)) {
          const acts = getActions() || [];
          const va = acts.find((a) => a && a.type === 'audio.voice.play' && a.params && a.params.audioId === snap.voice.audioId);
          voiceResume = {
            audioId: snap.voice.audioId,
            offset: Number(snap.voice.time) || 0,
            volume: va && Number.isFinite(va.params.volume) ? va.params.volume / 100 : 1,
            duck: !(va && va.params.duck === false)
          };
        } else voiceResume = null;
      } catch (e) {}
    } else {
      voiceResume = null;
    }
    try { r.stopAll(); } catch (e) { dbg.err = String((e && e.message) || e); }
    dbg.stops++; hint();
  }

  function onEvent(name, e) {
    const t = Number(e && e.t) || 0;
    switch (name) {
      case 'previewStart':                 /* 从头或任意时间开始：落地状态、起点事件首个推进命中 */
        active = true; lastT = t; boundaryInclusive = true; bgmOffset = 0; voiceResume = null;
        syncSamples.length = 0;            /* 全新播放会话：清空上一会话的同步样本，冷/热态独立统计 */
        startWall = now(); startT = t; anchorSet = true;
        applyStateAt(t);
        break;
      case 'previewResume':                /* 继续：按暂停时记录的位置恢复 BGM，并续播 Voice 剩余部分 */
        active = true; lastT = t; boundaryInclusive = true;
        if (voiceResume) {
          const r = currentRuntime();
          if (r && typeof r.voicePlay === 'function') {
            try {
              r.voicePlay({ audioId: voiceResume.audioId, volume: voiceResume.volume, duck: voiceResume.duck, offset: voiceResume.offset });
            } catch (e2) { dbg.err = String((e2 && e2.message) || e2); }
          }
          voiceResume = null;
        }
        startWall = now(); startT = t; anchorSet = true;
        applyStateAt(t, bgmOffset);
        break;
      case 'previewSeek':                  /* 拖动定位：只落状态音频，绝不重放一次性事件 */
        lastT = t; boundaryInclusive = false; voiceResume = null;
        startWall = now(); startT = t; anchorSet = true;
        applyStateAt(t);
        break;
      case 'previewLoop':                  /* 区间回绕到 a：重建 a 时刻状态，区间内事件下一轮重新触发 */
        active = true; lastT = t; boundaryInclusive = true; bgmOffset = 0; voiceResume = null;
        startWall = now(); startT = t; anchorSet = true;
        applyStateAt(t);
        break;
      case 'previewPause':                 /* 暂停：画面冻结，音频同步停，记录 BGM/Voice 位置供继续恢复 */
        active = false;
        stopAudio(true);
        break;
      case 'previewStop':                  /* 停止：清理本预览全部播放任务，恢复起点，无残留声音 */
        active = false; lastT = 0; boundaryInclusive = false; bgmOffset = 0; voiceResume = null;
        stopAudio(false);
        break;
      case 'previewEnd':                   /* 自动结束：补扫最后一段，一次性音频自然收尾 */
        if (active && t > lastT) scan(lastT, t, boundaryInclusive);
        active = false; boundaryInclusive = false;
        break;
      default: break;
    }
    dbg.lastT = lastT; dbg.active = active; dbg.bgmOffset = bgmOffset; dbg.voiceResume = voiceResume ? { ...voiceResume } : null;
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
  function syncStats() {
    if (!syncSamples.length) return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, minMs: 0 };
    const d = syncSamples.map((s) => Math.abs(s.driftMs)).sort((a, b) => a - b);
    const n = d.length;
    const mean = d.reduce((a, b) => a + b, 0) / n;
    const q = (p) => d[Math.min(n - 1, Math.ceil(p * n) - 1)];
    return { count: n, meanMs: +mean.toFixed(2), p50Ms: +q(0.5).toFixed(2), p95Ms: +q(0.95).toFixed(2), maxMs: +d[n - 1].toFixed(2), minMs: +d[0].toFixed(2) };
  }
  function dispose() { active = false; lastT = 0; boundaryInclusive = false; bgmOffset = 0; voiceResume = null; stopAudio(false); }
  return { onEvent, onTick, dispose, syncStats, debug: () => ({ ...dbg, sync: syncStats(), syncSamples: syncSamples.slice(-200) }) };
}
if (typeof module !== 'undefined') module.exports = createPreviewAudioDriver;
