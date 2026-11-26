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

  /* ---------- V0.8.2 M1-A · 片段拖动的纯交互状态机 ----------
     不含任何 DOM，也不持有 action 引用，因此自动化测试可以直接验证：
       · 交互期间只产出「预览秒数」，绝不修改任何动作数据；
       · 松手（up）且确有位移才提交一次，调用方据此执行唯一一次 edit()+setStart()；
       · 无位移 / Esc / pointercancel / lostpointercapture 一律不提交，不留半成品。
     一次拖动 = 一个撤销步骤，由调用方只调用一次 edit() 保证。 */
  function createDragSession() {
    let s = null;
    const THRESHOLD_PX = 3;
    const r3 = (v) => +Number(v).toFixed(3);

    function begin(id, origStart, startClientX, pxPerSec, pointerId) {
      if (s) return false;
      const o = Number(origStart);
      s = {
        id, origStart: Number.isFinite(o) && o >= 0 ? o : 0,
        startX: Number(startClientX) || 0,
        pxPerSec: Number(pxPerSec) > 0 ? Number(pxPerSec) : 1,
        pointerId, preview: Number.isFinite(o) && o >= 0 ? o : 0,
        moved: false, done: false
      };
      return true;
    }
    function move(clientX, pointerId) {
      if (!s || s.done) return null;
      if (pointerId != null && s.pointerId != null && pointerId !== s.pointerId) return null;
      const dx = (Number(clientX) || 0) - s.startX;
      if (Math.abs(dx) >= THRESHOLD_PX) s.moved = true;
      s.preview = Math.max(0, r3(s.origStart + dx / s.pxPerSec));
      return { active: true, id: s.id, previewStart: s.preview, deltaSec: r3(dx / s.pxPerSec), moved: s.moved };
    }
    /* reason: 'up' | 'cancel' | 'escape' | 'lostcapture' | 'nodechange' */
    function finish(reason, clientX, pointerId) {
      if (!s || s.done) return { commit: false, reason: reason || 'none', stale: true };
      if (reason === 'up' && clientX != null) move(clientX, pointerId);
      const commit = reason === 'up' && s.moved;
      const out = commit
        ? { commit: true, id: s.id, start: s.preview, from: s.origStart, reason }
        : { commit: false, id: s.id, reason: reason || 'none', moved: s.moved };
      s.done = true; s = null;
      return out;
    }
    function state() {
      return s ? { id: s.id, origStart: s.origStart, preview: s.preview, moved: s.moved } : null;
    }
    return { begin, move, finish, state };
  }

  /* ================= V0.8.2 M1-B · 编辑交互纯逻辑 =================
     全部不含 DOM、不持有工程引用，组件与 Node 测试共用同一套语义。
     写回工程仍由调用方在一次 edit() 内完成，因此每次有效操作只产生一个撤销步骤。 */
  const r3 = (v) => +Number(v).toFixed(3);                 /* 统一 1ms 精度，杜绝浮点持续漂移 */
  const clampN = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
  const cloneAction = (a) => JSON.parse(JSON.stringify(a));
  const MAX_DURATION = 30;                                /* 与 PF.validate / core.checkPerformance 一致 */
  const MAX_START = 86400;

  function setDuration(action, d) { action.duration = clampN(r3(d), 0, MAX_DURATION); return action; }
  function setStartAndDuration(action, s, d) { setStart(action, s); return setDuration(action, d); }

  /* ---------- 片段长度调整（左右边缘） ----------
     right：保持 start 不变，只改 duration（end 可移动）；
     left ：保持 end 不变，改 start 与 duration。
     零时长事件不允许拉伸（组件不显示手柄），start/duration 永不为负。 */
  function createResizeSession() {
    let s = null;
    const THRESHOLD_PX = 3;
    function begin(id, edge, origStart, origDuration, startClientX, pxPerSec, pointerId) {
      if (s || (edge !== 'left' && edge !== 'right')) return false;
      const st = Number(origStart), du = Number(origDuration);
      if (!Number.isFinite(st) || !Number.isFinite(du) || du <= 0) return false;
      s = {
        id, edge, origStart: r3(st), origDuration: r3(du), origEnd: r3(st + du),
        startX: Number(startClientX) || 0,
        pxPerSec: Number(pxPerSec) > 0 ? Number(pxPerSec) : 1,
        pointerId, moved: false, done: false,
        start: r3(st), duration: r3(du), end: r3(st + du)
      };
      return true;
    }
    function move(clientX, pointerId) {
      if (!s || s.done) return null;
      if (pointerId != null && s.pointerId != null && pointerId !== s.pointerId) return null;
      const dx = (Number(clientX) || 0) - s.startX;
      if (Math.abs(dx) >= THRESHOLD_PX) s.moved = true;
      const dt = dx / s.pxPerSec;
      if (s.edge === 'right') {
        const end = clampN(r3(s.origEnd + dt), s.origStart, s.origStart + MAX_DURATION);
        s.start = s.origStart; s.duration = r3(end - s.origStart); s.end = r3(end);
      } else {
        const start = clampN(r3(s.origStart + dt), 0, s.origEnd);
        s.start = r3(start); s.duration = r3(s.origEnd - start); s.end = s.origEnd;
      }
      return { active: true, id: s.id, edge: s.edge, start: s.start, duration: s.duration,
        end: s.end, deltaSec: r3(dt), moved: s.moved };
    }
    function finish(reason, clientX, pointerId) {
      if (!s || s.done) return { commit: false, reason: reason || 'none', stale: true };
      if (reason === 'up' && clientX != null) move(clientX, pointerId);
      const changed = s.start !== s.origStart || s.duration !== s.origDuration;
      const commit = reason === 'up' && s.moved && changed;
      const out = commit
        ? { commit: true, id: s.id, edge: s.edge, start: s.start, duration: s.duration, end: s.end,
          from: { start: s.origStart, duration: s.origDuration }, reason }
        : { commit: false, id: s.id, edge: s.edge, reason: reason || 'none', moved: s.moved };
      s.done = true; s = null;
      return out;
    }
    function state() { return s ? { id: s.id, edge: s.edge, start: s.start, duration: s.duration, moved: s.moved } : null; }
    return { begin, move, finish, state };
  }

  /* ---------- 时间吸附 ----------
     参考：网格 / 所有片段 start 与 end / 播放头 / 0。
     阈值按屏幕像素换算（SNAP_PX / pxPerSec），不同缩放下手感一致；
     Alt 临时关闭；结果统一 r3，避免浮点漂移。 */
  function createSnapper() {
    const SNAP_PX = 8;
    const GRID_CHOICES = [0, 0.1, 0.25, 0.5, 1];
    function snap(t, ctx) {
      const c = ctx || {}, grid = Number(c.grid) || 0;
      const raw = Math.max(0, Number(t) || 0);
      if (!grid || c.alt) return { time: r3(raw), snapped: false, target: null, kind: 'off' };
      const pps = Number(c.pxPerSec) > 0 ? Number(c.pxPerSec) : 1;
      const threshold = SNAP_PX / pps;
      const candidates = [{ t: 0, kind: 'zero' }];
      const k = Math.round(raw / grid);
      for (const kk of [k - 1, k, k + 1]) {
        const g = r3(kk * grid);
        if (g >= 0) candidates.push({ t: g, kind: 'grid' });
      }
      for (const ev of c.events || []) {
        candidates.push({ t: r3(ev.start), kind: 'start' }, { t: r3(ev.end), kind: 'end' });
      }
      if (c.playhead != null && Number.isFinite(Number(c.playhead))) candidates.push({ t: r3(c.playhead), kind: 'playhead' });
      let best = null, dist = Infinity;
      for (const x of candidates) {
        const d = Math.abs(x.t - raw);
        if (d < dist) { dist = d; best = x; }
      }
      if (best && dist <= threshold) return { time: best.t, snapped: true, target: best.t, kind: best.kind };
      return { time: r3(raw), snapped: false, target: null, kind: 'none' };
    }
    /* 缩放很大（pxPerSec 高）→ 建议更细网格；很小 → 更粗网格 */
    function gridForZoom(pxPerSec) {
      const p = Number(pxPerSec) || 1;
      return p >= 160 ? 0.1 : p >= 70 ? 0.25 : p >= 30 ? 0.5 : 1;
    }
    return { snap, gridForZoom, SNAP_PX, GRID_CHOICES };
  }

  /* ---------- 多选 ---------- */
  function createSelectionModel() {
    let sel = new Set(), anchor = null;
    function list() { return [...sel]; }
    function click(id, mods, order) {
      const m = mods || {};
      if (m.shift && anchor && Array.isArray(order) && order.length) {
        const a = order.indexOf(anchor), b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          sel = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
          return list();
        }
      }
      if (m.ctrl || m.meta) { if (sel.has(id)) sel.delete(id); else sel.add(id); anchor = id; }
      else { sel = new Set([id]); anchor = id; }
      return list();
    }
    return {
      click, list, has: (id) => sel.has(id), size: () => sel.size,
      clear: () => { sel.clear(); anchor = null; },
      set: (ids) => { sel = new Set(ids || []); anchor = (ids && ids[0]) || null; },
      toggle: (id) => { if (sel.has(id)) sel.delete(id); else sel.add(id); anchor = id; },
      anchor: () => anchor
    };
  }

  /* ---------- 批量移动：保持选中片段之间的相对间隔 ----------
     所有片段加同一个 delta；delta 被钳制到 >= -min(start)，因此不会出现负时间。
     一次 finish('up') 只提交一次，调用方用一次 edit() 写回全部选中动作。 */
  function createBatchDragSession() {
    let s = null;
    const THRESHOLD_PX = 3;
    function begin(items, startClientX, pxPerSec, pointerId) {
      if (s || !Array.isArray(items) || !items.length) return false;
      const clean = items.map((it) => ({ id: it.id, start: r3(clampN(Number(it.start), 0, MAX_START)) }));
      s = {
        items: clean, minStart: Math.min(...clean.map((x) => x.start)),
        startX: Number(startClientX) || 0,
        pxPerSec: Number(pxPerSec) > 0 ? Number(pxPerSec) : 1,
        pointerId, moved: false, done: false, delta: 0,
        preview: clean.map((x) => ({ ...x }))
      };
      return true;
    }
    function move(clientX, pointerId) {
      if (!s || s.done) return null;
      if (pointerId != null && s.pointerId != null && pointerId !== s.pointerId) return null;
      const dx = (Number(clientX) || 0) - s.startX;
      if (Math.abs(dx) >= THRESHOLD_PX) s.moved = true;
      const delta = Math.max(-s.minStart, dx / s.pxPerSec);
      s.delta = r3(delta);
      s.preview = s.items.map((it) => ({ id: it.id, start: r3(it.start + delta) }));
      return { active: true, items: s.preview, deltaSec: s.delta, moved: s.moved };
    }
    function finish(reason, clientX, pointerId) {
      if (!s || s.done) return { commit: false, reason: reason || 'none', stale: true };
      if (reason === 'up' && clientX != null) move(clientX, pointerId);
      const commit = reason === 'up' && s.moved && s.delta !== 0;
      const out = commit
        ? { commit: true, items: s.preview, deltaSec: s.delta, reason }
        : { commit: false, reason: reason || 'none', moved: s.moved };
      s.done = true; s = null;
      return out;
    }
    function state() { return s ? { delta: s.delta, items: s.preview, moved: s.moved } : null; }
    return { begin, move, finish, state };
  }

  /* ---------- 复制 / 粘贴 / 复制选中 ----------
     剪贴板只保存动作快照与排程时间，不复制素材文件；粘贴时生成新 ID、
     保留多个动作之间的时间间隔、以播放头（或指定时间）为起点、写绝对 start。 */
  function cloneForClipboard(events, ids) {
    const want = new Set(ids || []);
    return (events || []).filter((e) => want.has(e.id)).map((e) => ({
      action: cloneAction(e.action), start: e.start, end: e.end, duration: e.duration
    }));
  }
  function materializePaste(clip, atTime, newId) {
    if (!clip || !clip.length) return [];
    const base = Math.min(...clip.map((c) => Number(c.start) || 0));
    const at = clampN(Number(atTime), 0, MAX_START);
    return clip.map((c) => {
      const a = cloneAction(c.action);
      a.id = typeof newId === 'function' ? newId() : String(a.id) + '_copy';
      a.start = r3(clampN(at + (Number(c.start) || 0) - base, 0, MAX_START));
      return a;                       /* 显式 start 保证粘贴位置固定，相对语义由 schedule 忽略 */
    });
  }
  function materializeDelete(actions, ids) {
    const want = new Set(ids || []);
    return (actions || []).filter((a) => !want.has(a.id));
  }

  /* ---------- 轨道组织（显示状态，不写工程） ---------- */
  const FIXED_TRACKS = ['背景', '镜头', '特效', 'BGM', 'SFX', 'Voice', '混音', '等待', '其他'];
  function groupTracks(events, o) {
    const opt = o || {}, map = new Map();
    for (const ev of events || []) {
      if (!map.has(ev.track)) map.set(ev.track, []);
      map.get(ev.track).push(ev);
    }
    const names = [];
    for (const f of FIXED_TRACKS) if (map.has(f) || opt.showEmpty) names.push(f);
    const chars = [...map.keys()].filter((n) => n.indexOf('角色') === 0).sort();
    if (chars.length) names.push(...chars);
    else if (opt.showEmpty) names.push('角色');
    for (const n of map.keys()) if (!names.includes(n)) names.push(n);
    return names.map((n) => ({
      name: n, events: map.get(n) || [], isChar: n.indexOf('角色') === 0,
      charId: n.indexOf('角色·') === 0 ? n.slice(3) : '',
      empty: !map.has(n)
    }));
  }

  return { toTimeline, scrubState, audioSideEffectsAt, setStart, clearStart,
    totalDuration, blockUntil, trackOf, isOneShotAudio, createDragSession,
    setDuration, setStartAndDuration, createResizeSession, createSnapper,
    createSelectionModel, createBatchDragSession, cloneForClipboard,
    materializePaste, materializeDelete, groupTracks, FIXED_TRACKS, r3, MAX_DURATION, MAX_START };
}
if (typeof module !== 'undefined') module.exports = createTimeline;
