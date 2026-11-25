/* V0.8.2 · M1-A · 编辑器内时间轴面板（单节点最小可用闭环）
 *
 * 设计边界（务必保持）：
 *  - 时间轴不是第二份数据。每次 render() 都重新调用 TL.toTimeline(getActions())，
 *    片段只是动作列表的只读投影；松手时才由调用方用 edit()+TL.setStart() 写回一个动作。
 *  - 片段拖动「交互过程中」只改本片段 DOM 的 left（临时预览），不改任何 action。
 *  - 播放头 scrub 只委托 opts.scrub(t) 更新舞台，不触发 SFX/Voice、不切换/重启 BGM、
 *    不创建音频实例。组件自身从不调用 audioSideEffectsAt。
 *  - Esc / 无位移 / pointercancel / lostpointercapture / 切换节点一律取消拖动，不留半成品。
 */
function createTimelinePanel(opts) {
  const TL = opts.TL, PF = opts.PF;
  const LABEL_W = 78;                       // 左侧轨道名列宽（与 CSS 保持一致）
  const lanes = opts.lanes;                 // #tlLanes
  const drag = TL.createDragSession();
  const dbg = {
    renderCount: 0, scrubCalls: 0, oneShotTriggers: 0,
    clipDragCommits: 0, clipDragCancels: 0, lastCommit: null,
    lastCancel: null, playheadT: 0, clipCount: 0, trackCount: 0,
    nodeKey: '', previewOnly: true
  };
  let pxPerSec = 1, total = 1, curT = 0, pad = null, ph = null, clipEls = new Map(), lastEvents = [];
  let scrubActive = false, scrubPointer = null, activeClip = null, activePointer = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (v) => Number(v || 0).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function setText(id, text) { const e = document.getElementById(id); if (e) e.textContent = text; }
  function laneWidth() { return Math.max(60, (lanes.getBoundingClientRect().width || 320) - LABEL_W); }

  /* ---------- 渲染：唯一事实来源 = 动作列表 ---------- */
  function render() {
    if (!lanes) return;
    dbg.renderCount++;
    const actions = opts.getActions() || [];
    const events = TL.toTimeline(actions);
    lastEvents = events;
    const realTotal = TL.totalDuration(actions);
    total = Math.max(realTotal, 1);                 // 空动作也给 1s 可视刻度
    pxPerSec = laneWidth() / total;
    curT = clamp(curT, 0, total);
    dbg.clipCount = events.length;

    const tracks = [];
    for (const ev of events) if (!tracks.includes(ev.track)) tracks.push(ev.track);
    dbg.trackCount = tracks.length;
    dbg.nodeKey = opts.getNodeKey ? opts.getNodeKey() : '';

    lanes.replaceChildren();
    clipEls = new Map();

    /* 时间刻度 */
    const ruler = el('div', 'tl-ruler', lanes);
    const step = total <= 6 ? 1 : total <= 15 ? 2 : total <= 40 ? 5 : 10;
    for (let t = 0; t <= total + 0.0001; t += step) {
      const tick = el('span', 'tl-tick' + (t === 0 ? ' tl-tick-first' : ''), ruler);
      tick.style.left = (LABEL_W + t * pxPerSec) + 'px';
      tick.textContent = (Number.isInteger(t) ? t : t.toFixed(1)) + 's';
    }

    /* 拖动播放头的透明层：铺在轨道区底层，片段在上层，两者互不遮挡 */
    pad = el('div', 'tl-pad', lanes);
    pad.style.left = LABEL_W + 'px';
    bindScrub(pad);

    /* 轨道与片段 */
    if (!events.length) {
      const row = el('div', 'tl-lane tl-lane-empty', lanes);
      const name = el('div', 'tl-lane-name', row); name.textContent = '演出';
      const body = el('div', 'tl-lane-body', row);
      const empty = el('div', 'tl-empty', body);
      empty.textContent = '这句还没有演出动作 · 在右侧「舞台演出」添加动作后这里会自动出现片段';
    } else {
      for (const track of tracks) {
        const row = el('div', 'tl-lane', lanes);
        const name = el('div', 'tl-lane-name', row); name.textContent = track;
        const body = el('div', 'tl-lane-body', row);
        body.style.left = LABEL_W + 'px';
        for (const ev of events.filter(x => x.track === track)) buildClip(ev, body);
      }
    }

    /* 播放头（pointer-events:none，只作指示） */
    ph = el('div', 'tl-playhead', lanes);
    ph.style.left = (LABEL_W + curT * pxPerSec) + 'px';
    el('div', 'tl-playhead-knob', ph);

    setText('tlTime', fmt(curT) + ' / ' + fmt(realTotal) + 's');
    renderSelection(events);
    if (opts.refreshHead) opts.refreshHead({ total: realTotal, tracks: tracks.length, clips: events.length });
  }

  function buildClip(ev, body) {
    const a = ev.action;
    const absolute = a && a.start !== undefined;
    const zero = !(ev.duration > 0);
    const clip = el('div', 'tl-clip' + (zero ? ' tl-clip-zero' : '') +
      (absolute ? ' tl-clip-absolute' : '') + (ev.id === opts.getSelectedId() ? ' active' : ''), body);
    clip.dataset.tlClip = ev.id;
    clip.dataset.tlTrack = ev.track;
    clip.style.left = (ev.start * pxPerSec) + 'px';
    clip.style.width = Math.max(zero ? 3 : 2, ev.duration * pxPerSec) + 'px';
    clip.style.background = opts.colorOf ? opts.colorOf(ev.track) : '#b7c9b8';
    const meta = (PF.TYPES[ev.type] || {});
    clip.textContent = (zero ? '◆ ' : '') + (meta.name || ev.type) +
      (ev.oneShot ? ' ♪' : '') + (ev.blocking ? ' ▣' : '') + (absolute ? ' ●' : '');
    clip.title = (meta.name || ev.type) + ' · 轨道 ' + ev.track +
      ' · ' + ev.start + 's → ' + ev.end + 's · 时长 ' + ev.duration + 's' +
      (absolute ? ' · 绝对开始时间（延迟 / 与上一段 不参与调度）' : ' · 相对时间（after/parallel + delay）') +
      (zero ? ' · 零时长瞬时事件' : '') + (ev.oneShot ? ' · 一次性音频（仅正常播放触发）' : '');
    clipEls.set(ev.id, clip);
    clip.addEventListener('pointerdown', (e) => beginClipDrag(e, ev, clip));
    clip.addEventListener('pointermove', onClipMove);
    clip.addEventListener('pointerup', onClipUp);
    clip.addEventListener('pointercancel', onClipCancel);
    clip.addEventListener('lostpointercapture', onClipLost);
  }

  /* ---------- 片段拖动：只预览，松手才写回 ---------- */
  function beginClipDrag(e, ev, clip) {
    if (e.button !== 0 || opts.isPlaying()) return;
    e.preventDefault(); e.stopPropagation();
    /* 关键：按下时不整条重绘 lanes，否则浏览器会丢失正在捕获的 pointer 目标，
       真实用户拖动会中途断掉。这里只做轻量高亮 + 属性面板同步。 */
    if (opts.setSelectedId) opts.setSelectedId(ev.id, true);
    clipEls.forEach((c, id) => c.classList.toggle('active', id === ev.id));
    renderSelection(lastEvents);
    activeClip = clip; activePointer = e.pointerId;
    try { clip.setPointerCapture(e.pointerId); } catch (_) { /* 捕获失败仍靠 document 兜底 */ }
    drag.begin(ev.id, ev.start, e.clientX, pxPerSec, e.pointerId);
    clip.classList.add('dragging');
  }
  function onClipMove(e) {
    if (!drag.state()) return;
    const m = drag.move(e.clientX, e.pointerId);
    if (!m) return;
    /* 临时预览：只改这一个片段的 DOM 位置，动作数据、其它片段、播放头都不动 */
    const clip = clipEls.get(m.id);
    if (clip) {
      clip.style.left = (m.previewStart * pxPerSec) + 'px';
      clip.classList.add('preview');
    }
    setText('tlDragHint', '拖到 ' + m.previewStart.toFixed(3) + 's（松手才写入）');
  }
  function onClipUp(e) {
    if (!drag.state()) return;
    const r = drag.finish('up', e.clientX, e.pointerId);
    settleDrag(r);
  }
  function onClipCancel() { if (drag.state()) settleDrag(drag.finish('cancel')); }
  function onClipLost() {
    /* pointerup 之后浏览器也会触发 lostpointercapture；此时 drag 已结束，必须忽略 */
    if (drag.state()) settleDrag(drag.finish('lostcapture'));
  }
  function settleDrag(r) {
    const clip = activeClip;
    if (clip) {
      clip.classList.remove('dragging', 'preview');
      if (activePointer != null) { try { clip.releasePointerCapture(activePointer); } catch (_) {} }
    }
    activeClip = null; activePointer = null;
    setText('tlDragHint', '');
    if (r.commit) {
      dbg.clipDragCommits++;
      dbg.lastCommit = { id: r.id, from: r.from, to: r.start, reason: r.reason };
      /* 唯一一次写回：调用方用 edit() + TL.setStart()，因此一次拖动 = 一个撤销步骤 */
      if (opts.commitStart) opts.commitStart(r.id, r.start);
      else render();
    } else {
      if (!r.stale) { dbg.clipDragCancels++; dbg.lastCancel = { reason: r.reason, moved: !!r.moved }; }
      render();                                  // 取消：清掉临时预览，回到真实调度
    }
  }

  /* ---------- 播放头 scrub：只预览画面 ---------- */
  function bindScrub(node) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || opts.isPlaying()) return;
      e.preventDefault();
      scrubActive = true; scrubPointer = e.pointerId;
      try { node.setPointerCapture(e.pointerId); } catch (_) {}
      setPlayheadFromX(e.clientX);
    });
    node.addEventListener('pointermove', (e) => {
      if (!scrubActive || (scrubPointer != null && e.pointerId !== scrubPointer)) return;
      setPlayheadFromX(e.clientX);
    });
    const end = () => { scrubActive = false; scrubPointer = null; };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('lostpointercapture', end);
  }
  function setPlayheadFromX(clientX) {
    const rect = lanes.getBoundingClientRect();
    setPlayhead(clamp((clientX - rect.left - LABEL_W) / pxPerSec, 0, total));
  }
  function setPlayhead(t) {
    curT = clamp(Number(t) || 0, 0, total);
    dbg.playheadT = curT;
    if (ph) ph.style.left = (LABEL_W + curT * pxPerSec) + 'px';
    setText('tlTime', fmt(curT) + ' / ' + fmt(Math.max(0, TL.totalDuration(opts.getActions() || []))) + 's');
    dbg.scrubCalls++;
    /* 只更新舞台画面。不调用 audioSideEffectsAt，不碰 BGM，不创建播放实例。 */
    if (opts.scrub) opts.scrub(curT);
  }

  /* ---------- 选中同步（按动作 ID） ---------- */
  function renderSelection(events) {
    const id = opts.getSelectedId();
    const ev = events ? events.find(x => x.id === id) : null;
    const btn = document.getElementById('tlRestoreRelative');
    if (btn) btn.disabled = !(ev && ev.action && ev.action.start !== undefined);
    if (!ev) { setText('tlSelection', '未选中片段 · 点击片段或右侧动作列表可互相同步'); return; }
    const a = ev.action;
    setText('tlSelection', (PF.TYPES[ev.type] || {}).name + ' · 轨道 ' + ev.track +
      ' · ' + (a.start !== undefined ? '绝对开始 ' + a.start + 's' : '相对 ' + a.mode + (a.delay ? ' + ' + a.delay + 's' : '')) +
      ' · 排程 ' + ev.start + '→' + ev.end + 's' + (ev.duration > 0 ? '' : ' · 零时长') +
      (ev.oneShot ? ' · 一次性音频' : ''));
  }
  function bindUi() {
    const reset = document.getElementById('tlPlayheadReset');
    if (reset) reset.onclick = () => { if (opts.resetScrub) opts.resetScrub(); setPlayhead(0); };
    const restore = document.getElementById('tlRestoreRelative');
    if (restore) restore.onclick = () => {
      const id = opts.getSelectedId();
      if (!id) return;
      if (opts.restoreRelative) opts.restoreRelative(id);
    };
    /* Esc 用捕获阶段：优先于编辑器既有的图层拖动 Esc 分支 */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !drag.state()) return;
      settleDrag(drag.finish('escape'));
      e.preventDefault(); e.stopPropagation();
    }, true);
  }

  /* 切换节点：取消任何未完成的拖动、播放头归零、不留上一节点的预览状态 */
  function reset() {
    if (drag.state()) settleDrag(drag.finish('nodechange'));
    scrubActive = false; scrubPointer = null;
    curT = 0; dbg.playheadT = 0;
    if (opts.clearScrub) opts.clearScrub();
    render();
  }

  function debug() {
    return Object.assign({}, dbg, {
      pxPerSec, total, curT, dragActive: !!drag.state(), dragState: drag.state(),
      baseline: opts.getBaselineDebug ? opts.getBaselineDebug() : null
    });
  }

  bindUi();
  if (typeof window !== 'undefined') window.paperTimelineDebug = debug;
  return { render, reset, debug, setPlayhead };
}
if (typeof module !== 'undefined') module.exports = createTimelinePanel;
