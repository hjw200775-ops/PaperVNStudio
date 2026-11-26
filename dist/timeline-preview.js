/* V0.8.2 · M2-A · 时间轴连续视觉预览控制器
 *
 * 本轮只负责「时间」：单调时钟推进、状态机、播放区间与循环、播放头时间、事件钩子。
 * 每帧把当前绝对时间交给 onTick(t)，由编辑器用 TL.scrubState()/PF.stateAt() + PF.applyDOM()
 * 求视觉状态；控制器绝不写工程数据、绝不创建撤销记录、绝不执行音频副作用。
 *
 * M2B 接口准备：previewStart / previewPause / previewResume / previewSeek /
 * previewStop / previewLoop / previewEnd 只 emit，不播放音频；完整音视频同步在 M2B 接入。
 */
function createPreviewController(opts) {
  const o = opts || {};
  const now = o.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const raf = o.raf || ((cb) => (typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame(cb) : setTimeout(() => cb(now()), 16)));
  const cancelRaf = o.cancelRaf || ((id) => {
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(id);
    else clearTimeout(id);
  });
  const onTick = o.onTick || (() => {});
  const onState = o.onState || (() => {});
  const onEvent = o.onEvent || (() => {});
  const getTotal = o.total || (() => 1);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const STATES = ['idle', 'playing', 'paused', 'stopped', 'ended'];
  let state = 'idle', curT = 0, anchorT = 0, anchorWall = 0, startT = 0;
  let range = null, loop = false, follow = true, disposed = false;
  let rafId = null, activeRaf = 0, generation = 0, loopCount = 0;
  const events = [];
  const frames = { count: 0, worstMs: 0, sumMs: 0, lastWall: 0, firstWall: 0 };

  function bounds() {
    const total = Math.max(0.001, Number(getTotal()) || 0.001);
    const a = range ? clamp(Number(range.start), 0, total) : 0;
    const b = range ? clamp(Number(range.end), a + 0.001, total) : total;
    return { a, b: Math.max(a + 0.001, b), total };
  }
  function emit(name, detail) {
    const e = { name, t: +curT.toFixed(3), at: now(), generation };
    if (detail) Object.assign(e, detail);
    events.push(e);
    if (events.length > 60) events.shift();
    onEvent(name, e);
  }
  function setState(s) { state = s; onState(s); }
  function framesReset() {
    frames.count = 0; frames.worstMs = 0; frames.sumMs = 0;
    frames.firstWall = now(); frames.lastWall = frames.firstWall;
  }
  function cancelLoop() {
    if (rafId != null) { try { cancelRaf(rafId); } catch (_) {} }
    rafId = null; activeRaf = 0;
  }
  function schedule() {
    if (disposed || state !== 'playing') return;
    cancelLoop();                        /* 幂等：永远只有一个 rAF 在跑 */
    activeRaf = 1;
    rafId = raf(() => { frame(now()); schedule(); });
  }
  function frame(wall) {
    if (state !== 'playing' || disposed) return;
    const w = Number.isFinite(Number(wall)) ? Number(wall) : now();
    const dt = Math.max(0, w - frames.lastWall);
    frames.lastWall = w;
    frames.count++;
    frames.sumMs += dt;
    frames.worstMs = Math.max(frames.worstMs, dt);

    const { a, b, total } = bounds();
    let t = anchorT + (w - anchorWall) / 1000;   /* 单调时钟求绝对时间，不累加固定增量 */
    if (t >= b) {
      if (loop && range) {
        loopCount++;
        curT = a; anchorT = a; anchorWall = w;
        emit('previewLoop', { from: +b.toFixed(3), to: +a.toFixed(3), count: loopCount });
        onTick(curT);                            /* 回到起点重新求舞台状态，不累积 */
        return;
      }
      curT = b;
      setState('ended');
      cancelLoop();
      emit('previewEnd', { end: +b.toFixed(3) });
      onTick(curT);
      return;
    }
    curT = clamp(t, a, Math.max(b, total));
    onTick(curT);
  }

  function beginPlaying(t0, eventName) {
    const { a, total } = bounds();
    curT = clamp(Number(t0) || 0, a, total);
    anchorT = curT; anchorWall = now();
    generation++;
    framesReset();
    setState('playing');
    emit(eventName, { from: +curT.toFixed(3) });
    onTick(curT);                              /* 立即求初态 */
    schedule();
    return state;
  }
  function play(from) {
    if (disposed) return state;
    const { a, total } = bounds();
    const t = Number.isFinite(Number(from)) ? clamp(Number(from), a, total) : curT;
    if (state === 'playing') {                 /* 多次启动不产生重复播放任务 */
      if (t !== curT) seek(t);
      return state;
    }
    if (state === 'paused') return resume();
    startT = range ? a : 0;
    return beginPlaying(t, 'previewStart');
  }
  function pause() {
    if (state !== 'playing' || disposed) return state;
    const { b } = bounds();
    const w = now();
    curT = clamp(anchorT + (w - anchorWall) / 1000, 0, b);
    cancelLoop();
    setState('paused');
    emit('previewPause', { t: +curT.toFixed(3) });
    return state;
  }
  function resume() {
    if (state !== 'paused' || disposed) return state;
    return beginPlaying(curT, 'previewResume');
  }
  function stop() {
    if (disposed) return state;
    cancelLoop();
    curT = startT;
    setState('stopped');
    emit('previewStop', { t: +curT.toFixed(3) });
    onTick(curT);
    return state;
  }
  function replay() {
    if (disposed) return state;
    cancelLoop();
    curT = 0; startT = 0;
    const { a, total } = bounds();
    return beginPlaying(clamp(range ? a : 0, 0, total), 'previewStart');
  }
  function seek(t) {
    if (disposed) return state;
    const { a, b, total } = bounds();
    curT = clamp(Number(t) || 0, a, Math.max(b, total));
    if (state === 'playing') { anchorT = curT; anchorWall = now(); }
    emit('previewSeek', { t: +curT.toFixed(3) });
    onTick(curT);
    return state;
  }
  function setRange(a, b) {
    const { total } = bounds();
    const s = clamp(Number(a) || 0, 0, total);
    const e = clamp(Number(b) || 0, s + 0.001, total);
    range = { start: +s.toFixed(3), end: +e.toFixed(3) };
    startT = s;
    if (state === 'playing' && (curT < s || curT > e)) seek(s);
    return range;
  }
  function clearRange() {
    range = null; startT = 0;
    return null;
  }
  function setLoop(v) { loop = !!v; return loop; }
  function setFollow(v) { follow = !!v; return follow; }
  /* 编辑、撤销重做、删除、切换节点：停止旧计划并递增代际，绝不混入新计划数据。 */
  function invalidate(reason) {
    cancelLoop();
    generation++;
    if (state !== 'idle' && state !== 'stopped') emit('previewStop', { reason: reason || 'invalidate' });
    curT = 0; startT = 0;
    setState('stopped');
    return state;
  }
  function dispose() {
    cancelLoop();
    disposed = true;
    setState('idle');
  }
  function fps() {
    const span = (frames.lastWall - frames.firstWall) / 1000;
    return span > 0 ? +(frames.count / span).toFixed(1) : 0;
  }
  function snapshot() {
    const { a, b, total } = bounds();
    return {
      state, curT: +curT.toFixed(3), startT, total: +total.toFixed(3),
      range: range ? { ...range } : null, rangeBounds: { a: +a.toFixed(3), b: +b.toFixed(3) },
      loop, follow, activeRaf, loopCount, generation, disposed,
      frames: { count: frames.count, worstMs: +frames.worstMs.toFixed(2), avgMs: frames.count ? +(frames.sumMs / frames.count).toFixed(2) : 0, fps: fps() },
      eventNames: events.map((e) => e.name),
      events: events.slice(-12)
    };
  }
  return {
    play, pause, resume, stop, replay, seek,
    setRange, clearRange, setLoop, setFollow,
    invalidate, dispose, snapshot, frame, STATES
  };
}
if (typeof module !== 'undefined') module.exports = createPreviewController;
