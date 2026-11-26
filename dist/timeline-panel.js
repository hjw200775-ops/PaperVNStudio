/* V0.8.2 · M1-B · 编辑器内时间轴面板（单节点多轨编辑交互）
 *
 * 不变式（M1A 已验证，M1B 继续保护）：
 *  - 时间轴不是第二份数据：每次 render() 重新 TL.toTimeline(getActions())，片段只是只读投影。
 *  - 交互过程中只改临时 DOM 视觉状态；确认操作后才由调用方用一次 edit() 写回工程。
 *  - 一次有效拖动 = 一次 edit() = 一个撤销步骤；pointermove 绝不改工程、绝不创建快照。
 *  - Esc / 无位移 / pointercancel / lostpointercapture / 切换节点 / 缩放 / 滚动一律取消。
 *  - 播放头 scrub 只委托 opts.scrub(t) 更新舞台，不触发 SFX/Voice、不切换/重启 BGM。
 *  - pointerdown 后绝不重建交互目标（否则浏览器丢失 pointer capture，真实拖动会中断）。
 *
 * M1B 新增：左右边缘拉伸、缩放/横向滚动、时间吸附、多选批量移动、复制粘贴删除、轨道组织。
 * 所有新编辑语义都来自 dist/timeline.js 的纯逻辑，本文件只负责视图与事件。
 */
function createTimelinePanel(opts) {
  const TL = opts.TL, PF = opts.PF;
  const LABEL_W = 92;                        // 左侧轨道名列宽（与 CSS 保持一致）
  const MIN_PPS = 1, MAX_PPS = 4000;         // 1px/s 可总览 300s+，4000px/s 可精修 0.5s
  const lanes = opts.lanes, panel = opts.panel;
  const drag = TL.createDragSession();
  const resize = TL.createResizeSession();
  const batch = TL.createBatchDragSession();
  const snapper = TL.createSnapper();
  const selection = TL.createSelectionModel();

  const dbg = {
    renderCount: 0, relayoutCount: 0, scrubCalls: 0, oneShotTriggers: 0,
    clipDragCommits: 0, clipDragCancels: 0, resizeCommits: 0, batchCommits: 0,
    editCalls: 0, lastCommit: null, lastCancel: null,
    playheadT: 0, clipCount: 0, trackCount: 0, nodeKey: '', previewOnly: true,
    documentListeners: 0, snapLineShown: 0
  };

  let pps = 60, defaultPps = 60, contentW = 600, curT = 0, total = 1;
  let events = [], tracks = [], clipEls = new Map(), pad = null, ph = null, snapLine = null, content = null;
  let clipOrder = [], clipboard = [];
  let collapsed = new Set(), showEmpty = false, snapGrid = 0, userZoomed = false;
  let scrubActive = false, scrubPointer = null;
  let activeClip = null, activePointer = null, interaction = null, lastAlt = false;
  let snapTarget = null, panelFocused = false;

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
  function viewportW() { return Math.max(240, (lanes.getBoundingClientRect().width || 360)); }
  function fitPps() { return clamp((viewportW() - LABEL_W - 26) / Math.max(total, 0.5), MIN_PPS, MAX_PPS); }
  function niceStep() {
    const raw = 62 / pps;
    const choices = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return choices.find((c) => c >= raw) || 1200;
  }
  function xOf(t) { return LABEL_W + t * pps; }      /* content 坐标：刻度 / 播放头 / 参考线 */
  function clipX(t) { return t * pps; }               /* 轨道 body 坐标：片段（body 已偏移 LABEL_W） */

  /* ---------- 布局：缩放只更新样式，不重建 DOM（避免无意义全量重绘） ---------- */
  function layoutSize() {
    const maxEnd = events.length ? Math.max(...events.map((e) => e.end)) : 1;
    contentW = Math.max(viewportW(), xOf(Math.max(total, maxEnd + 0.5)) + 24);
    if (content) content.style.width = contentW + 'px';
  }
  function drawRuler() {
    const ruler = content && content.querySelector('.tl-ruler');
    if (!ruler || !content) return;
    ruler.replaceChildren();
    content.querySelectorAll('.tl-gridline').forEach((n) => n.remove());
    const step = niceStep();
    for (let t = 0; t <= total + step * 0.5; t += step) {
      const tick = el('span', 'tl-tick' + (Math.abs(t) < 1e-9 ? ' tl-tick-first' : ''), ruler);
      tick.style.left = xOf(t) + 'px';
      tick.textContent = (step < 1 ? +t.toFixed(2) : t) + 's';
      const line = el('i', 'tl-gridline', content);   /* 贯穿全部轨道的网格线 */
      line.style.left = xOf(t) + 'px';
    }
  }
  function relayout() {
    if (!content) return;
    dbg.relayoutCount++;
    layoutSize();
    drawRuler();
    for (const ev of events) {
      const clip = clipEls.get(ev.id);
      if (!clip) continue;
      clip.style.left = clipX(ev.start) + 'px';
      clip.style.width = Math.max(ev.duration > 0 ? 2 : 3, ev.duration * pps) + 'px';
    }
    if (ph) ph.style.left = xOf(curT) + 'px';
    if (snapLine) snapLine.style.left = xOf(snapTarget == null ? 0 : snapTarget) + 'px';
    setText('tlZoomLabel', Math.round(pps) + ' px/s');
    if (opts.refreshHead) opts.refreshHead({ total, tracks: tracks.length, clips: events.length, pps });
  }

  /* ---------- 渲染：唯一事实来源 = 动作列表 ---------- */
  function render() {
    if (!lanes) return;
    dbg.renderCount++;
    const actions = opts.getActions() || [];
    events = TL.toTimeline(actions);
    clipOrder = events.map((e) => e.id);
    const realTotal = TL.totalDuration(actions);
    total = Math.max(realTotal, 0.5);
    /* 撤销/重做或删除后按 ID 恢复选择，不残留已不存在的片段 */
    const keep = selection.list().filter((id) => clipOrder.includes(id));
    selection.set(keep);
    /* 用户未手动缩放时保持「适应当前演出范围」；窗口布局完成后再次 render 会自动修正 */
    if (!userZoomed) { defaultPps = fitPps(); pps = defaultPps; }
    curT = clamp(curT, 0, total);
    dbg.clipCount = events.length;
    dbg.nodeKey = opts.getNodeKey ? opts.getNodeKey() : '';
    tracks = TL.groupTracks(events, { showEmpty });
    dbg.trackCount = tracks.length;

    lanes.replaceChildren();
    clipEls = new Map();
    content = el('div', 'tl-content', lanes);
    const ruler = el('div', 'tl-ruler', content);
    pad = el('div', 'tl-pad', content);
    pad.style.left = LABEL_W + 'px';
    bindScrub(pad);

    if (!events.length && !tracks.length) {
      const row = el('div', 'tl-lane tl-lane-empty', content);
      const name = el('div', 'tl-lane-name', row); name.textContent = '演出';
      const empty = el('div', 'tl-empty', row);
      empty.textContent = '这句还没有演出动作 · 在右侧「舞台演出」添加动作后这里会自动出现片段';
    }
    for (const g of tracks) buildLane(g, content);

    ph = el('div', 'tl-playhead', content);
    el('div', 'tl-playhead-knob', ph);
    snapLine = el('div', 'tl-snapline', content);

    layoutSize();
    drawRuler();
    for (const ev of events) {
      const clip = clipEls.get(ev.id);
      if (clip) { clip.style.left = clipX(ev.start) + 'px'; clip.style.width = Math.max(ev.duration > 0 ? 2 : 3, ev.duration * pps) + 'px'; }
    }
    ph.style.left = xOf(curT) + 'px';
    hideSnapLine();
    setText('tlTime', fmt(curT) + ' / ' + fmt(realTotal) + 's');
    setText('tlZoomLabel', Math.round(pps) + ' px/s');
    renderSelection();
    if (opts.refreshHead) opts.refreshHead({ total: realTotal, tracks: tracks.length, clips: events.length, pps });
  }

  function buildLane(g, parent) {
    const row = el('div', 'tl-lane' + (collapsed.has(g.name) ? ' collapsed' : '') + (g.empty ? ' tl-lane-blank' : ''), parent);
    const name = el('div', 'tl-lane-name', row);
    const fold = el('button', 'tl-fold', name);
    fold.type = 'button';
    fold.textContent = collapsed.has(g.name) ? '▸' : '▾';
    fold.title = '折叠 / 展开这条轨道（只影响显示）';
    fold.dataset.tlFold = g.name;
    fold.onclick = (e) => {
      e.stopPropagation();
      if (collapsed.has(g.name)) collapsed.delete(g.name); else collapsed.add(g.name);
      row.classList.toggle('collapsed', collapsed.has(g.name));
      fold.textContent = collapsed.has(g.name) ? '▸' : '▾';
    };
    const label = el('span', 'tl-lane-label', name);
    label.textContent = g.isChar && g.charId
      ? '角色 · ' + (opts.characterName ? (opts.characterName(g.charId) || g.charId) : g.charId)
      : g.name;
    name.title = g.name + (g.empty ? '（空轨道）' : ' · ' + g.events.length + ' 个片段');
    const body = el('div', 'tl-lane-body', row);
    body.style.left = LABEL_W + 'px';
    for (const ev of g.events) buildClip(ev, body);
  }

  function buildClip(ev, body) {
    const a = ev.action;
    const absolute = a && a.start !== undefined;
    const zero = !(ev.duration > 0);
    const clip = el('div', 'tl-clip' + (zero ? ' tl-clip-zero' : '') +
      (absolute ? ' tl-clip-absolute' : '') + (ev.id === opts.getSelectedId() ? ' active' : ''), body);
    clip.dataset.tlClip = ev.id;
    clip.dataset.tlTrack = ev.track;
    clip.style.background = opts.colorOf ? opts.colorOf(ev.track) : '#b7c9b8';
    const meta = (PF.TYPES[ev.type] || {});
    const text = el('span', 'tl-clip-text', clip);
    text.textContent = (zero ? '◆ ' : '') + (meta.name || ev.type) +
      (ev.oneShot ? ' ♪' : '') + (ev.blocking ? ' ▣' : '') + (absolute ? ' ●' : '');
    clip.title = (meta.name || ev.type) + ' · 轨道 ' + ev.track +
      ' · ' + ev.start + 's → ' + ev.end + 's · 时长 ' + ev.duration + 's' +
      (absolute ? ' · 绝对开始时间' : ' · 相对时间（after/parallel + delay）') +
      (zero ? ' · 零时长瞬时事件（不可拉伸）' : ' · 拖左右边缘可调时长');
    /* 零时长事件没有可拖动的时长，不放拉伸手柄，避免误导 */
    if (!zero) {
      const lh = el('div', 'tl-handle tl-handle-left', clip);
      lh.dataset.tlEdge = 'left'; lh.title = '拖动左边缘：保持结束时间，调整开始与时长';
      const rh = el('div', 'tl-handle tl-handle-right', clip);
      rh.dataset.tlEdge = 'right'; rh.title = '拖动右边缘：保持开始时间，调整时长';
    }
    clipEls.set(ev.id, clip);
    clip.addEventListener('pointerdown', (e) => beginPointer(e, ev, clip));
    clip.addEventListener('pointermove', onPointerMove);
    clip.addEventListener('pointerup', onPointerUp);
    clip.addEventListener('pointercancel', onPointerCancel);
    clip.addEventListener('lostpointercapture', onPointerLost);
  }

  /* ---------- 吸附：移动与拉伸使用同一套规则 ---------- */
  /* 纯吸附（不显示参考线）：提交时用，避免 settle 过程留下临时视觉状态 */
  function snapOnly(t, alt) {
    return snapper.snap(t, { grid: snapGrid, pxPerSec: pps, events, playhead: curT, alt: !!alt }).time;
  }
  function snapTime(t, alt) {
    const r = snapper.snap(t, {
      grid: snapGrid, pxPerSec: pps, events, playhead: curT, alt: !!alt
    });
    if (r.snapped) {
      snapTarget = r.target;
      if (snapLine) {
        snapLine.style.left = xOf(r.target) + 'px';
        snapLine.classList.add('shown');
        snapLine.dataset.kind = r.kind;
      }
      dbg.snapLineShown++;
    } else hideSnapLine();
    return r.time;
  }
  function hideSnapLine() {
    snapTarget = null;
    if (snapLine) { snapLine.classList.remove('shown'); snapLine.dataset.kind = ''; }
  }

  /* ---------- 交互：pointerdown 后绝不重建目标 ---------- */
  function beginPointer(e, ev, clip) {
    if (e.button !== 0 || opts.isPlaying()) return;
    e.preventDefault(); e.stopPropagation();
    focusPanel();
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    lastAlt = !!e.altKey;
    const edgeEl = e.target && e.target.closest ? e.target.closest('.tl-handle') : null;

    /* Ctrl/Shift 只做选择，不起拖 */
    if (mods.ctrl || mods.shift) {
      selection.click(ev.id, mods, clipOrder);
      applySelectionClasses();
      if (opts.setSelectedId) opts.setSelectedId(ev.id, true);
      renderSelection();
      return;
    }

    const multi = selection.size() > 1 && selection.has(ev.id);
    if (multi) selection.set(selection.list());
    else { selection.set([ev.id]); }
    applySelectionClasses();
    if (opts.setSelectedId) opts.setSelectedId(ev.id, true);   /* 第二参数 = 不重绘 lanes */
    renderSelection();

    activeClip = clip; activePointer = e.pointerId;
    try { clip.setPointerCapture(e.pointerId); } catch (_) {}
    clip.classList.add('dragging');

    if (edgeEl && ev.duration > 0) {
      const edge = edgeEl.dataset.tlEdge;
      if (resize.begin(ev.id, edge, ev.start, ev.duration, e.clientX, pps, e.pointerId)) {
        interaction = { kind: 'resize', edge, ids: [ev.id] };
      } else { interaction = null; }
    } else if (multi) {
      const items = selection.list().map((id) => {
        const x = events.find((z) => z.id === id);
        return { id, start: x ? x.start : 0 };
      });
      batch.begin(items, e.clientX, pps, e.pointerId);
      interaction = { kind: 'batch', ids: items.map((x) => x.id) };
    } else {
      drag.begin(ev.id, ev.start, e.clientX, pps, e.pointerId);
      interaction = { kind: 'move', ids: [ev.id] };
    }
    if (!interaction) { clip.classList.remove('dragging'); activeClip = null; }
  }

  function applySelectionClasses() {
    const sel = new Set(selection.list());
    clipEls.forEach((c, id) => {
      c.classList.toggle('active', id === opts.getSelectedId());
      c.classList.toggle('multiselect', sel.size > 1 && sel.has(id));
    });
  }

  function onPointerMove(e) {
    if (!interaction) return;
    lastAlt = !!e.altKey;
    const k = interaction.kind;
    if (k === 'move') {
      const m = drag.move(e.clientX, e.pointerId);
      if (!m) return;
      const t = snapTime(m.previewStart, e.altKey);
      const clip = clipEls.get(m.id);
      if (clip) { clip.style.left = clipX(t) + 'px'; clip.classList.add('preview'); }
      const x = events.find((z) => z.id === m.id);
      setText('tlDragHint', '拖到 ' + t.toFixed(3) + 's（松手才写入）' + (snapTarget != null ? ' · 吸附 ' + snapTarget + 's' : ''));
      if (x) setText('tlResizeHint', '起点 ' + t.toFixed(3) + 's · 终点 ' + (t + x.duration).toFixed(3) + 's · 时长 ' + x.duration.toFixed(3) + 's');
    } else if (k === 'batch') {
      const m = batch.move(e.clientX, e.pointerId);
      if (!m) return;
      const snappedT = snapTime(m.items[0].start, e.altKey);
      const delta = snappedT - m.items[0].start;
      for (const it of m.items) {
        const clip = clipEls.get(it.id);
        if (clip) { clip.style.left = clipX(r3(it.start + delta)) + 'px'; clip.classList.add('preview'); }
      }
      setText('tlDragHint', '批量移动 ' + m.items.length + ' 个片段 · Δ ' + (m.deltaSec + delta).toFixed(3) + 's（松手才写入）' +
        (snapTarget != null ? ' · 吸附 ' + snapTarget + 's' : ''));
    } else if (k === 'resize') {
      const m = resize.move(e.clientX, e.pointerId);
      if (!m) return;
      const snapped = snapTime(interaction.edge === 'left' ? m.start : m.end, e.altKey);
      let st = m.start, du = m.duration, en = m.end;
      if (interaction.edge === 'left') { st = clamp(snapped, 0, m.end); du = r3(m.end - st); en = m.end; }
      else { en = clamp(snapped, m.start, m.start + TL.MAX_DURATION); du = r3(en - m.start); }
      const clip = clipEls.get(m.id);
      if (clip) {
        clip.style.left = clipX(st) + 'px';
        clip.style.width = Math.max(2, du * pps) + 'px';
        clip.classList.add('preview');
      }
      setText('tlResizeHint', '起点 ' + st.toFixed(3) + 's · 终点 ' + en.toFixed(3) + 's · 时长 ' + du.toFixed(3) + 's' +
        (snapTarget != null ? ' · 吸附 ' + snapTarget + 's' : ''));
      setText('tlDragHint', '调整' + (interaction.edge === 'left' ? '左' : '右') + '边缘（松手才写入）');
    }
  }
  const r3 = (v) => +Number(v).toFixed(3);

  function onPointerUp(e) {
    if (!interaction) return;
    lastAlt = !!e.altKey;
    const k = interaction.kind;
    let result;
    if (k === 'move') result = drag.finish('up', e.clientX, e.pointerId);
    else if (k === 'batch') result = batch.finish('up', e.clientX, e.pointerId);
    else result = resize.finish('up', e.clientX, e.pointerId);
    settle(k, result, e.altKey);
  }
  function onPointerCancel() { cancelActiveInteraction('cancel'); }
  function onPointerLost() {
    /* pointerup 之后浏览器补发 lostpointercapture；此时会话已结束，必须忽略 */
    if (interaction) cancelActiveInteraction('lostcapture');
  }

  function settle(kind, r, alt) {
    const clip = activeClip;
    clipEls.forEach((c) => c.classList.remove('dragging', 'preview'));
    if (clip && activePointer != null) { try { clip.releasePointerCapture(activePointer); } catch (_) {} }
    activeClip = null; activePointer = null; interaction = null;
    hideSnapLine();
    setText('tlDragHint', ''); setText('tlResizeHint', '');
    if (!r || !r.commit) {
      if (r && !r.stale) { dbg.clipDragCancels++; dbg.lastCancel = { kind, reason: r.reason, moved: !!r.moved }; }
      render();
      return;
    }
    if (kind === 'move') {
      dbg.clipDragCommits++;
      const t = snapOnly(r.start, alt);
      dbg.lastCommit = { kind, id: r.id, from: r.from, to: t };
      if (opts.commitStart) opts.commitStart(r.id, t); else render();
    } else if (kind === 'batch') {
      dbg.batchCommits++;
      const snappedFirst = snapOnly(r.items[0].start, alt);
      const delta = snappedFirst - r.items[0].start;
      const items = r.items.map((it) => ({ id: it.id, start: r3(Math.max(0, it.start + delta)) }));
      dbg.lastCommit = { kind, items, deltaSec: r.deltaSec };
      if (opts.commitBatchMove) opts.commitBatchMove(items); else render();
    } else {
      dbg.resizeCommits++;
      /* 与 onPointerMove 的预览使用同一吸附规则；左边缘保持原 end、右边缘保持 start */
      const origEnd = r3(r.start + r.duration);
      let st = r.start, du = r.duration;
      if (r.edge === 'left') {
        st = clamp(snapOnly(r.start, alt), 0, origEnd);
        du = r3(origEnd - st);
      } else {
        const en = clamp(snapOnly(origEnd, alt), r.start, r.start + TL.MAX_DURATION);
        du = r3(en - r.start);
      }
      dbg.lastCommit = { kind, id: r.id, edge: r.edge, start: st, duration: du };
      if (opts.commitResize) opts.commitResize(r.id, r.edge, st, du); else render();
    }
    hideSnapLine();
  }

  function cancelActiveInteraction(reason) {
    if (!interaction) return;
    const k = interaction.kind;
    const r = k === 'move' ? drag.finish(reason) : k === 'batch' ? batch.finish(reason) : resize.finish(reason);
    settle(k, r, false);
  }

  /* ---------- 播放头 scrub：只预览画面 ---------- */
  function bindScrub(node) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || opts.isPlaying()) return;
      e.preventDefault();
      focusPanel();
      selection.clear(); applySelectionClasses(); renderSelection();
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
    const contentX = clientX - rect.left + lanes.scrollLeft;
    setPlayhead(clamp((contentX - LABEL_W) / pps, 0, total));
  }
  function setPlayhead(t) {
    curT = clamp(Number(t) || 0, 0, total);
    dbg.playheadT = curT;
    if (ph) ph.style.left = xOf(curT) + 'px';
    setText('tlTime', fmt(curT) + ' / ' + fmt(Math.max(0, TL.totalDuration(opts.getActions() || []))) + 's');
    dbg.scrubCalls++;
    if (opts.scrub) opts.scrub(curT);
  }

  /* ---------- 缩放与滚动 ---------- */
  function zoomBy(factor, clientX) {
    cancelActiveInteraction('cancel');         /* 缩放期间取消未完成的拖动 */
    const rect = lanes.getBoundingClientRect();
    const anchorPx = clientX == null
      ? clamp(xOf(curT) - lanes.scrollLeft, 0, viewportW())
      : clamp(clientX - rect.left, 0, viewportW());
    const tAnchor = clamp((anchorPx + lanes.scrollLeft - LABEL_W) / pps, 0, total);
    pps = clamp(pps * factor, MIN_PPS, MAX_PPS);
    userZoomed = true;
    relayout();
    lanes.scrollLeft = Math.max(0, xOf(tAnchor) - anchorPx);
  }
  function zoomFit() {
    cancelActiveInteraction('cancel');
    userZoomed = false;
    defaultPps = fitPps(); pps = defaultPps;
    relayout(); lanes.scrollLeft = 0;
  }
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;      /* 只有 Ctrl+滚轮缩放，普通滚轮留给滚动 */
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX);
  }

  /* ---------- 选中同步（按动作 ID） ---------- */
  function renderSelection() {
    const ids = selection.list();
    setText('tlSelCount', ids.length > 1 ? '已选 ' + ids.length + ' 个片段' : (ids.length ? '已选 1 个片段' : '未选择'));
    const id = opts.getSelectedId();
    const ev = events.find((x) => x.id === id) || null;
    const btn = document.getElementById('tlRestoreRelative');
    if (btn) btn.disabled = !(ev && ev.action && ev.action.start !== undefined);
    if (!ev) { setText('tlSelection', '未选中片段 · 点击片段或右侧动作列表可互相同步'); return; }
    const a = ev.action;
    setText('tlSelection', (PF.TYPES[ev.type] || {}).name + ' · 轨道 ' + ev.track +
      ' · ' + (a.start !== undefined ? '绝对开始 ' + a.start + 's' : '相对 ' + a.mode + (a.delay ? ' + ' + a.delay + 's' : '')) +
      ' · 排程 ' + ev.start + '→' + ev.end + 's' + (ev.duration > 0 ? '' : ' · 零时长') +
      (ev.oneShot ? ' · 一次性音频' : ''));
  }
  function focusPanel() {
    panelFocused = true;
    if (panel && panel.focus && document.activeElement !== panel) { try { panel.focus({ preventScroll: true }); } catch (_) {} }
  }
  function timelineFocused() {
    const a = document.activeElement;
    if (isTypingTarget(a)) return false;              /* 正在输入文字或属性：绝不拦截 */
    if (panel && a && (a === panel || (panel.contains && panel.contains(a)))) return true;
    return panelFocused;                              /* 点击过时间轴但焦点尚未落到可聚焦元素 */
  }
  function isTypingTarget(t) {
    return !!t && !!t.matches && t.matches('input,textarea,select,[contenteditable=true]');
  }

  /* ---------- 复制 / 粘贴 / 删除（一次 edit 由 app.js 负责） ---------- */
  function selectedIds() {
    const s = selection.list().filter((id) => clipOrder.includes(id));
    return s.length ? s : (opts.getSelectedId() ? [opts.getSelectedId()] : []);
  }
  function doCopy() {
    const ids = selectedIds();
    clipboard = TL.cloneForClipboard(events, ids);
    setText('tlClipInfo', '已复制 ' + clipboard.length + ' 个片段');
    return clipboard.length;
  }
  function doPaste(atTime) {
    if (!clipboard.length) return 0;
    const at = Number.isFinite(Number(atTime)) ? Number(atTime) : curT;
    if (opts.paste) opts.paste(clipboard, at);
    setText('tlClipInfo', '已在 ' + r3(at).toFixed(2) + 's 粘贴 ' + clipboard.length + ' 个片段');
    return clipboard.length;
  }
  function doDuplicate() {
    const ids = selectedIds();
    if (!ids.length) return 0;
    clipboard = TL.cloneForClipboard(events, ids);
    const maxEnd = events.length ? Math.max(...events.map((e) => e.end)) : 0;
    return doPaste(r3(maxEnd + 0.2));
  }
  function doDelete() {
    const ids = selectedIds();
    if (!ids.length) return 0;
    if (opts.deleteIds) opts.deleteIds(ids);
    selection.clear();
    setText('tlClipInfo', '已删除 ' + ids.length + ' 个片段');
    return ids.length;
  }

  /* ---------- 工具栏与快捷键（只注册一次） ---------- */
  function bindUi() {
    const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = fn; };
    bind('tlPlayheadReset', () => { if (opts.resetScrub) opts.resetScrub(); setPlayhead(0); });
    bind('tlRestoreRelative', () => {
      const id = opts.getSelectedId();
      if (id && opts.restoreRelative) opts.restoreRelative(id);
    });
    bind('tlZoomIn', () => zoomBy(1.5, null));
    bind('tlZoomOut', () => zoomBy(1 / 1.5, null));
    bind('tlZoomFit', zoomFit);
    bind('tlZoomReset', zoomFit);
    const snapSel = document.getElementById('tlSnap');
    if (snapSel) { snapGrid = Number(snapSel.value) || 0; snapSel.onchange = () => { snapGrid = Number(snapSel.value) || 0; hideSnapLine(); }; }
    const emptySel = document.getElementById('tlShowEmpty');
    if (emptySel) { showEmpty = !!emptySel.checked; emptySel.onchange = () => { showEmpty = !!emptySel.checked; render(); }; }
    lanes.addEventListener('wheel', onWheel, { passive: false });
    /* 滚动期间取消未完成的拖动；滚动本身不重建 DOM，刻度与片段同处 content 天然对齐 */
    lanes.addEventListener('scroll', () => { if (interaction) cancelActiveInteraction('cancel'); });
    const host = panel || lanes;
    host.addEventListener('pointerdown', (e) => { if (!e.target.closest('.tl-clip')) focusPanel(); }, true);
    document.addEventListener('focusin', (e) => { if (isTypingTarget(e.target)) panelFocused = false; });
    window.addEventListener('resize', () => {
      if (interaction) return;
      if (!userZoomed) { defaultPps = fitPps(); pps = defaultPps; }
      relayout();
    });

    /* Esc 与编辑快捷键：捕获阶段优先于编辑器既有的图层拖动 Esc 分支 */
    document.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;              /* 正在输入文字/属性时一律不拦截 */
      if (e.key === 'Escape') {
        if (interaction) { cancelActiveInteraction('escape'); e.preventDefault(); e.stopPropagation(); return; }
        if (selection.size() && timelineFocused()) { selection.clear(); applySelectionClasses(); renderSelection(); e.preventDefault(); }
        return;
      }
      if (!timelineFocused()) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'c') { doCopy(); e.preventDefault(); }
      else if (ctrl && e.key.toLowerCase() === 'v') { doPaste(curT); e.preventDefault(); }
      else if (ctrl && e.key.toLowerCase() === 'd') { doDuplicate(); e.preventDefault(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { doDelete(); e.preventDefault(); }
      /* Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 交给编辑器全局撤销重做，避免重复拦截 */
    }, true);
    dbg.documentListeners = 1;
  }

  /* 切换节点：取消未完成拖动、播放头归零、清空旧节点选择、不留预览 */
  function reset() {
    if (interaction) cancelActiveInteraction('nodechange');
    scrubActive = false; scrubPointer = null;
    selection.clear();
    clipboard = [];
    curT = 0; dbg.playheadT = 0;
    hideSnapLine();
    if (opts.clearScrub) opts.clearScrub();
    userZoomed = false;
    lanes.scrollLeft = 0;
    render();
  }

  function debug() {
    return Object.assign({}, dbg, {
      pps, defaultPps, pxPerSec: pps, labelWidth: LABEL_W, total, curT,
      scrollLeft: lanes.scrollLeft, contentWidth: contentW,
      snapGrid, showEmpty, collapsed: [...collapsed],
      selectedIds: selection.list(), clipboardSize: clipboard.length,
      dragActive: !!(drag.state() || resize.state() || batch.state()),
      dragState: drag.state(), resizeState: resize.state(), batchState: batch.state(),
      clipDomCount: clipEls.size, documentListeners: dbg.documentListeners,
      baseline: opts.getBaselineDebug ? opts.getBaselineDebug() : null
    });
  }

  bindUi();
  if (typeof window !== 'undefined') window.paperTimelineDebug = debug;
  return { render, reset, debug, setPlayhead, zoomBy, zoomFit };
}
if (typeof module !== 'undefined') module.exports = createTimelinePanel;
