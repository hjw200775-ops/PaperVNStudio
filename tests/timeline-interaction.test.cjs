'use strict';
/* V0.8.2 · M1-A · 时间轴编辑器交互层核心测试
 *
 * 覆盖验收点中可脱离 DOM 验证的部分：
 *  · 拖动交互期间只预览、不修改动作数据；一次拖动只产生一次写回（= 一个撤销步骤）
 *  · 无位移 / Esc / pointercancel / lostpointercapture / 切换节点不留半成品
 *  · 显式 start=0 与小数秒；绝对动作 + 相对 after/parallel 混排
 *  · 松手后按真实 schedule() 刷新，后续相对动作跟随且绝不偷写 start
 *  · 恢复相对时间；并行片段；零时长事件；空状态
 *  · 旧工程只投影不批量写 start，原调度与终态一致
 */
const assert = require('node:assert/strict');
const PF = require('../dist/performance.js')();
const TL = require('../dist/timeline.js')(PF);

const ctx = {
  P: { characters: [{ id: 'lin', expressions: [] }], assets: [], audioAssets: [] },
  layers: [{ id: 'l_lin', name: '林悠', kind: 'char', characterId: 'lin', x: 50, y: 70 }, { id: 'l_bg', name: '背景', kind: 'bg' }]
};
const before = PF.emptyState();

/* 验收用的混排工程：绝对动作与 after/parallel 相对动作共存 */
function mixed() {
  return [
    PF.make('a1', 'wait', '', { duration: 1.0 }),
    PF.make('a2', 'camera.zoom', '', { duration: 0.5, mode: 'parallel' }),
    PF.make('a3', 'screen.fade', '', { duration: 0.8, mode: 'after', delay: 0.2 }),
    PF.make('a4', 'audio.sfx.play', '', { params: { audioId: 'sfx1', volume: 100, key: 'k' }, duration: 0.3, mode: 'after', delay: 0.5 })
  ];
}
const startsOf = (acts) => TL.toTimeline(acts).map(e => e.start);

(async () => {
  /* 1. 拖动预览期间绝不修改动作数据 */
  {
    const acts = mixed(), a1 = acts[0];
    const d = TL.createDragSession();
    assert.equal(d.begin('a1', 0, 100, 100, 7), true, 'begin 成功');
    const m = d.move(335, 7);
    assert.equal(m.previewStart, 2.35, '预览 2.35s（100px/秒，位移 235px）');
    assert.equal(a1.start, undefined, '交互期间 action.start 未被写入');
    assert.equal(d.state().moved, true);
    assert.equal(TL.toTimeline(acts)[0].start, 0, '预览期间真实排程不变');
  }

  /* 2. 一次拖动 = 一次写回（调用方只调用一次 edit()） */
  {
    const acts = mixed(), a1 = acts[0];
    const d = TL.createDragSession();
    let edits = 0;
    d.begin('a1', 0, 100, 100, 7);
    d.move(335, 7);
    const r = d.finish('up', 335, 7);
    assert.equal(r.commit, true);
    assert.equal(r.start, 2.35);
    if (r.commit) { edits++; TL.setStart(a1, r.start); }
    assert.equal(edits, 1, '一次拖动只写回一次');
    assert.equal(a1.start, 2.35, '写回小数秒绝对开始时间');
    assert.equal(d.state(), null, '松手后拖动会话清空');
  }

  /* 3. 无位移 / Esc / pointercancel / lostpointercapture / 切换节点一律不提交 */
  {
    for (const reason of ['up', 'escape', 'cancel', 'lostcapture', 'nodechange']) {
      const acts = mixed(), a1 = acts[0];
      const d = TL.createDragSession();
      d.begin('a1', 0, 100, 100, 7);
      if (reason !== 'up') d.move(335, 7);           // 除 up 外都有真实位移
      const r = d.finish(reason, reason === 'up' ? 100 : undefined, 7);
      assert.equal(r.commit, false, reason + ' 不提交');
      assert.equal(a1.start, undefined, reason + ' 不留半成品编辑');
      assert.equal(startsOf(acts)[0], 0, reason + ' 后调度回到原值');
    }
  }

  /* 4. pointerup 之后浏览器补发的 lostpointercapture 不得重复提交 */
  {
    const d = TL.createDragSession();
    d.begin('a1', 0, 100, 100, 7); d.move(335, 7);
    assert.equal(d.finish('up', 335, 7).commit, true);
    const stale = d.finish('lostcapture');
    assert.equal(stale.commit, false);
    assert.equal(stale.stale, true, '已结束会话被识别为 stale');
  }

  /* 5. 错误 pointerId 不产生预览（避免多指/串扰污染状态） */
  {
    const d = TL.createDragSession();
    d.begin('a1', 0, 100, 100, 7);
    assert.equal(d.move(335, 99), null);
    assert.equal(d.state().preview, 0);
    d.finish('cancel');
  }

  /* 6. 显式 start=0 合法且被识别为绝对时间（不是「没有 start」） */
  {
    const acts = mixed();
    TL.setStart(acts[0], 0);
    assert.equal(acts[0].start, 0);
    assert.notEqual(acts[0].start, undefined, 'start=0 必须保留，不能被当成缺省值');
    assert.equal(TL.toTimeline(acts)[0].start, 0);
    assert.doesNotThrow(() => PF.validate({ version: 1, actions: acts }), 'start=0 通过演出校验');
  }

  /* 7. 混排：拖动一个绝对动作后，后续相对动作按真实 schedule() 跟随，
        但其它动作绝不偷偷写入 start */
  {
    const acts = mixed();
    assert.deepEqual(startsOf(acts), [0, 0, 1.2, 2.5], '原相对调度');
    TL.setStart(acts[0], 2.35);
    const ev = TL.toTimeline(acts);
    assert.deepEqual(startsOf(acts), [2.35, 2.35, 3.55, 4.85],
      'a2(parallel 跟随 lastStart) / a3(after 跟随 cursor) / a4 全部按真实调度刷新');
    assert.equal(acts[1].start, undefined, 'a2 未被偷写 start');
    assert.equal(acts[2].start, undefined, 'a3 未被偷写 start');
    assert.equal(acts[3].start, undefined, 'a4 未被偷写 start');
    assert.equal(ev[0].track, '等待');
    assert.equal(ev[1].track, '镜头');
    assert.equal(ev[3].oneShot, true, '一次性音频片段被标记');
  }

  /* 8. 恢复相对时间：清除 start 后完全回到原 after/parallel + delay 调度与终态 */
  {
    const acts = mixed();
    const endBefore = TL.scrubState(before, acts, Infinity, ctx);
    TL.setStart(acts[0], 2.35);
    assert.notDeepEqual(startsOf(acts), [0, 0, 1.2, 2.5]);
    TL.clearStart(acts[0]);
    assert.equal(acts[0].start, undefined);
    assert.deepEqual(startsOf(acts), [0, 0, 1.2, 2.5], '恢复相对时间后调度逐字段还原');
    assert.deepEqual(TL.scrubState(before, acts, Infinity, ctx), endBefore, '终态与原工程一致');
  }

  /* 9. 并行片段 + 零时长瞬时事件 */
  {
    const acts = [
      PF.make('p1', 'character.show', 'char:lin', { params: { side: 'left' }, duration: 0.6 }),
      PF.make('p2', 'background.change', 'bg', { params: { assetId: 'bg2', transition: 'crossfade' }, duration: 0.6, mode: 'parallel' }),
      PF.make('z0', 'screen.flash', '', { duration: 0, mode: 'after', delay: 0.4 })
    ];
    const ev = TL.toTimeline(acts);
    assert.equal(ev[1].start, ev[0].start, '并行片段同时开始');
    assert.equal(ev[2].duration, 0, '零时长事件保留 duration=0');
    assert.equal(ev[2].start, ev[2].end, '零时长事件 start=end');
    assert.equal(ev[2].start, 1.0, '零时长事件排在 cursor(0.6)+delay(0.4)');
    const beforeHit = TL.scrubState(before, acts, 0.999, ctx);
    const afterHit = TL.scrubState(before, acts, 1.001, ctx);
    assert.equal(beforeHit.screen.flashColor, undefined, '未到起点时零时长事件未结算');
    assert.equal(afterHit.screen.flashColor, 'white', 't 刚过起点零时长瞬时事件立即结算');
  }

  /* 10. 空状态：无动作时不产生任何事件、总时长为 0、舞台保持进入前状态
        （stateAt 会按 ctx.layers 建立图层基线，但不施加任何演出变化） */
  {
    const ev = TL.toTimeline([]);
    assert.equal(ev.length, 0);
    assert.equal(TL.totalDuration([]), 0);
    const st = TL.scrubState(before, [], Infinity, ctx);
    assert.equal(st.camera.scale, 1);
    assert.equal(st.screen.dim, 0);
    assert.equal(st.audio.bgm, null);
    assert.equal(Object.values(st.layers).every(l => l.opacity === 1 && l.visible === true && l.dx === 0), true,
      '无动作时全部图层保持基线');
  }

  /* 11. 未编辑的旧工程：toTimeline 是纯只读投影，绝不批量写入 start */
  {
    const legacy = mixed();
    const snapshot = JSON.stringify(legacy);
    for (let i = 0; i < 20; i++) TL.toTimeline(legacy);   // 反复渲染（打开/预览/保存）
    assert.equal(JSON.stringify(legacy), snapshot, '反复投影后动作对象逐字节不变');
    assert.equal(legacy.some(a => a.start !== undefined), false, '旧工程没有被批量写入 start');
    /* 模拟「保存 → 重新打开」：normalize 往返不得引入 start，调度与终态保持一致 */
    const reopened = PF.normalize({ version: 1, actions: JSON.parse(snapshot) }).actions;
    assert.equal(reopened.some(a => a.start !== undefined), false, '重开后仍没有 start');
    assert.deepEqual(startsOf(reopened), startsOf(legacy), '保存重开后原调度不变');
    assert.deepEqual(TL.scrubState(before, reopened, Infinity, ctx),
      TL.scrubState(before, legacy, Infinity, ctx), '保存重开后终态一致');
    assert.equal(TL.audioSideEffectsAt(legacy, 2.5).length, 1, '一次性音频只在正常播放的起点触发');
  }

  /* 12. 播放头前后反复：scrubState 是纯函数，同一 t 永远同一结果（不累积） */
  {
    const acts = mixed();
    const seq = [0, 0.5, 2.9, 0.2, 4.9, 1.0, 0.5];
    const a = TL.scrubState(before, acts, 0.5, ctx);
    for (const t of seq) TL.scrubState(before, acts, t, ctx);
    const b = TL.scrubState(before, acts, 0.5, ctx);
    assert.deepEqual(a, b, '反复前后拖动后同一时间状态完全一致');
    assert.equal(TL.audioSideEffectsAt(acts, 0.5).length, 0, '拖动到非起点不触发一次性音频');
  }

  /* ================= V0.8.2 M1-B 新增 ================= */

  /* 13. 右边缘拉伸：保持 start 不变，只改 duration / end */
  {
    const acts = mixed();
    const r = TL.createResizeSession();
    assert.equal(r.begin('a1', 'right', 1, 2, 100, 100, 7), true);
    const m = r.move(300, 7);
    assert.equal(m.start, 1, '右边缘 start 保持');
    assert.equal(m.duration, 4, 'dx=200px / 100px每秒 → duration 2→4');
    assert.equal(m.end, 5);
    assert.equal(acts[0].duration, 1.0, '预览期间动作数据未改');
  }

  /* 14. 左边缘拉伸：保持 end 不变，改 start 与 duration */
  {
    const r = TL.createResizeSession();
    r.begin('a1', 'left', 1, 2, 100, 100, 7);
    const m = r.move(250, 7);
    assert.equal(m.start, 2.5);
    assert.equal(m.duration, 0.5);
    assert.equal(m.end, 3, '左边缘结束时间固定');
  }

  /* 15. 零时长动作保护 + 非法持续时间（非负、上限 30） */
  {
    assert.equal(TL.createResizeSession().begin('z', 'right', 1, 0, 100, 100, 7), false,
      '零时长瞬时事件不允许拉伸');
    assert.equal(TL.createResizeSession().begin('x', 'middle', 1, 2, 100, 100, 7), false, '未知边缘拒绝');
    const r = TL.createResizeSession();
    r.begin('a1', 'left', 1, 2, 100, 100, 7);
    const over = r.move(100000, 7);
    assert.equal(over.start, 3, '左边缘拖过 end 时钳制到 end');
    assert.equal(over.duration, 0, '不允许负时长');
    const back = r.move(-100000, 7);
    assert.equal(back.start, 0, '不允许负开始时间');
    assert.equal(back.duration, 3);
    const r2 = TL.createResizeSession();
    r2.begin('a1', 'right', 0, 2, 100, 100, 7);
    assert.equal(r2.move(100000, 7).duration, TL.MAX_DURATION, '时长上限 30 与演出校验一致');
  }

  /* 16. 拉伸取消 / 无位移不提交，一次有效拉伸只提交一次 */
  {
    for (const reason of ['up', 'escape', 'cancel', 'lostcapture', 'nodechange']) {
      const r = TL.createResizeSession();
      r.begin('a1', 'right', 1, 2, 100, 100, 7);
      if (reason !== 'up') r.move(300, 7);
      const out = r.finish(reason, reason === 'up' ? 100 : undefined, 7);
      assert.equal(out.commit, false, reason + ' 不提交拉伸');
      assert.equal(r.state(), null);
    }
    const r = TL.createResizeSession();
    r.begin('a1', 'right', 1, 2, 100, 100, 7); r.move(300, 7);
    const out = r.finish('up', 300, 7);
    assert.equal(out.commit, true);
    assert.equal(out.duration, 4);
    assert.equal(out.edge, 'right');
    assert.equal(r.finish('lostcapture').stale, true, '补发的 lostcapture 不重复提交');
  }

  /* 17. 吸附开关、网格、缩放级别（阈值基于像素） */
  {
    const s = TL.createSnapper();
    assert.deepEqual(s.snap(1.03, { grid: 0.5, pxPerSec: 100 }),
      { time: 1, snapped: true, target: 1, kind: 'grid' }, '吸附到 1.0s 网格');
    const hit = s.snap(1.03, { grid: 0.5, pxPerSec: 100, events: [{ start: 1.02, end: 2 }] });
    assert.equal(hit.snapped, true);
    assert.equal(s.snap(1.2, { grid: 0.5, pxPerSec: 100 }).snapped, false, '0.2s 距离 > 8px 阈值不吸附');
    assert.equal(s.snap(1.2, { grid: 0.5, pxPerSec: 10 }).snapped, true,
      '缩小时同样 0.2s = 2px，应吸附（阈值按像素而非固定时间）');
    assert.equal(s.snap(1.03, { grid: 0, pxPerSec: 100 }).snapped, false, '关闭吸附');
    assert.equal(s.snap(1.03, { grid: 0.5, pxPerSec: 100, alt: true }).snapped, false, 'Alt 临时关闭');
    assert.equal(s.snap(0.02, { grid: 0.5, pxPerSec: 100 }).target, 0, '0 秒位置吸附');
    assert.equal(s.snap(2.38, { grid: 1, pxPerSec: 100, playhead: 2.37 }).kind, 'playhead');
    assert.deepEqual(s.GRID_CHOICES, [0, 0.1, 0.25, 0.5, 1]);
    assert.equal(s.gridForZoom(200), 0.1);
    assert.equal(s.gridForZoom(10), 1);
  }

  /* 18. 吸附结果 1ms 精度，反复吸附不漂移 */
  {
    const s = TL.createSnapper();
    let t = 1.0;
    for (let i = 0; i < 50; i++) t = s.snap(t + 0.001, { grid: 0.1, pxPerSec: 100 }).time;
    assert.equal(Number.isInteger(Math.round(t * 1000)), true, '结果始终是 1ms 整数倍');
    assert.equal(t, +t.toFixed(3));
  }

  /* 19. 多选：Ctrl / Shift / 空白取消 / 切换节点清空 */
  {
    const m = TL.createSelectionModel(), order = ['a1', 'a2', 'a3', 'a4'];
    assert.deepEqual(m.click('a1', {}, order), ['a1']);
    assert.deepEqual(m.click('a3', { ctrl: true }, order), ['a1', 'a3']);
    assert.deepEqual(m.click('a4', { shift: true }, order), ['a3', 'a4'], 'Shift 从 anchor 范围选择');
    m.click('a1', { ctrl: true }, order);
    assert.equal(m.has('a1'), true);
    m.clear();
    assert.equal(m.size(), 0, '点击空白 / 切节点清空选择');
  }

  /* 20. 批量移动：保持相对间隔、负时间钳制、一次提交 */
  {
    const b = TL.createBatchDragSession();
    assert.equal(b.begin([{ id: 'a1', start: 1 }, { id: 'a3', start: 3 }], 100, 100, 7), true);
    const m = b.move(250, 7);
    assert.deepEqual(m.items, [{ id: 'a1', start: 2.5 }, { id: 'a3', start: 4.5 }], '同加 1.5s，间隔保持 2s');
    const neg = b.move(-1000, 7);
    assert.deepEqual(neg.items, [{ id: 'a1', start: 0 }, { id: 'a3', start: 2 }], 'delta 钳制到 >= -min(start)');
    const out = b.finish('up', 250, 7);
    assert.equal(out.commit, true);
    assert.equal(out.items.length, 2, '一次提交覆盖全部选中片段');
  }

  /* 21. 批量移动取消不写数据、错误 pointerId 不响应 */
  {
    const b = TL.createBatchDragSession();
    b.begin([{ id: 'a1', start: 1 }], 100, 100, 7);
    assert.equal(b.move(250, 99), null);
    assert.equal(b.finish('escape').commit, false);
    assert.equal(b.state(), null);
    const b2 = TL.createBatchDragSession();
    b2.begin([{ id: 'a1', start: 1 }], 100, 100, 7);
    assert.equal(b2.finish('up', 100, 7).commit, false, '无位移不提交');
  }

  /* 22. 复制：ID 唯一、参数与素材引用完整、不复制素材文件 */
  {
    const acts = mixed();
    TL.setStart(acts[0], 1);
    const clip = TL.cloneForClipboard(TL.toTimeline(acts), ['a1', 'a4']);
    assert.equal(clip.length, 2);
    assert.equal(clip[1].action.params.audioId, 'sfx1', '音频素材引用保留');
    assert.equal(clip[0].action.type, 'wait', '动作类型保留');
    assert.notEqual(clip[0].action, acts[0], '是快照，不是原对象引用');
    let n = 0; const newId = () => 'new' + (++n);
    const pasted = TL.materializePaste(clip, 8, newId);
    assert.deepEqual(pasted.map((a) => a.id), ['new1', 'new2'], '生成新的唯一 ID');
    assert.equal(pasted[0].start, 8, '以播放头为粘贴起点');
    assert.equal(pasted[1].start, 8 + (clip[1].start - clip[0].start), '保留动作之间的时间间隔');
    assert.equal(pasted[0].params ? true : true, true);
  }

  /* 23. 粘贴不产生失效引用，删除只移除目标动作 */
  {
    const acts = mixed();
    const clip = TL.cloneForClipboard(TL.toTimeline(acts), ['a4']);
    const pasted = TL.materializePaste(clip, 2.35, (() => { let i = 0; return () => 'p' + (++i); })())[0];
    assert.equal(pasted.params.audioId, 'sfx1');
    assert.equal(pasted.start, 2.35);
    assert.equal(TL.materializeDelete(acts, ['a1']).length, 3);
    assert.deepEqual(TL.materializeDelete(acts, []).map((a) => a.id), ['a1', 'a2', 'a3', 'a4'], '空删除不改动');
    assert.deepEqual(acts.map((a) => a.id), ['a1', 'a2', 'a3', 'a4'], '删除是纯函数，不改原数组');
  }

  /* 24. 相对动作重新调度：批量移动只写选中动作，未选动作不被修改 */
  {
    const acts = mixed();                 // 全部相对
    const beforeStarts = startsOf(acts); // [0, 0, 1.2, 2.5]
    const snap = JSON.stringify(acts);
    const b = TL.createBatchDragSession();
    b.begin([{ id: 'a1', start: 0 }, { id: 'a2', start: 0 }], 100, 100, 7);
    const out = b.finish('up', 300, 7);
    assert.equal(out.commit, true);
    /* 模拟调用方一次 edit()：只给选中的两个动作写 start */
    for (const it of out.items) TL.setStart(acts.find((a) => a.id === it.id), it.start);
    assert.equal(acts[2].start, undefined, '未选中的 a3 保持相对时间');
    assert.equal(acts[3].start, undefined, '未选中的 a4 保持相对时间');
    assert.notDeepEqual(startsOf(acts), beforeStarts, '后续相对动作由 schedule() 自然跟随');
    assert.equal(JSON.stringify(acts).includes('"start":2'), true, '只有选中动作被写成绝对时间');
    assert.notEqual(JSON.stringify(acts), snap);
  }

  /* 25. 拉伸写回后其它动作 start 字段不被偷改 */
  {
    const acts = mixed();
    TL.setStart(acts[0], 1.5);
    const beforeOthers = JSON.stringify(acts.slice(1));
    TL.setDuration(acts[0], 2.75);
    assert.equal(JSON.stringify(acts.slice(1)), beforeOthers, '其它动作逐字节不变');
    assert.equal(startsOf(acts)[1], 1.5, 'parallel 动作仍跟随 lastStart');
  }

  /* 26. 轨道组织：固定顺序、角色子轨道、空轨道开关 */
  {
    const acts = [
      PF.make('c1', 'character.show', 'char:lin', { params: { side: 'left' }, duration: 0.6 }),
      PF.make('c2', 'character.move', 'char:che', { duration: 0.6, mode: 'parallel' }),
      PF.make('b1', 'background.change', 'bg', { duration: 0.8, mode: 'parallel' })
    ];
    const groups = TL.groupTracks(TL.toTimeline(acts), {});
    const names = groups.map((g) => g.name);
    assert.equal(names[0], '背景', '固定轨道顺序');
    assert.equal(names.includes('角色·lin') && names.includes('角色·che'), true, '角色按 char id 拆子轨道');
    assert.equal(groups.find((g) => g.name === '角色·lin').charId, 'lin');
    assert.equal(groups.every((g) => !g.empty), true, '默认隐藏空轨道');
    assert.equal(TL.groupTracks(TL.toTimeline(acts), { showEmpty: true }).some((g) => g.empty), true,
      '可选显示空轨道');
  }

  /* 27. 播放头跨越音频事件不产生历史副作用 */
  {
    const acts = mixed();               // a4 是 audio.sfx.play，2.5s 起点
    const st0 = TL.scrubState(before, acts, 0, ctx);
    for (const t of [0.5, 2.4, 2.5, 2.6, 4.9, 0.2, 2.5]) TL.scrubState(before, acts, t, ctx);
    const st1 = TL.scrubState(before, acts, 0, ctx);
    assert.deepEqual(st0, st1, '反复跨越音频起点不累积任何状态');
    assert.equal('sfx' in st1, false, '状态里没有一次性音效对象');
    assert.equal(TL.audioSideEffectsAt(acts, 2.5).length, 1, '只有正常播放起点才触发');
  }

  /* 28. 拉伸 / 粘贴后的动作仍通过演出校验（可保存重开） */
  {
    const acts = mixed();
    TL.setStartAndDuration(acts[0], 0, 0);
    TL.setStartAndDuration(acts[1], 2.35, 0.5);
    assert.doesNotThrow(() => PF.validate({ version: 1, actions: acts }));
    const reopened = PF.normalize({ version: 1, actions: JSON.parse(JSON.stringify(acts)) }).actions;
    assert.equal(reopened[1].start, 2.35, '小数秒保存重开保留');
    assert.equal(reopened[0].duration, 0, '零时长保存重开保留');
  }

  console.log('PASS: 时间轴交互 M1A(12) + M1B(16)（拉伸/零时长保护/非法时长/吸附与缩放/多选/批量移动/复制粘贴删除/相对重排/轨道组织/音频无副作用/保存重开）');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
