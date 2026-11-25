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

  console.log('PASS: 时间轴交互（预览不改数据/一次一撤销/取消无半成品/绝对与相对混排/恢复相对/并行/零时长/空状态/旧工程不写 start/播放头不累积）');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
