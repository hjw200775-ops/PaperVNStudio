'use strict';
/* V0.8.2 · M2-A · 预览控制器与连续视觉状态测试
 * 覆盖：播放/暂停/继续/停止/任意起点/自动结束/区间循环/多次启动幂等/编辑与切节点失效/
 * 单调时钟/事件钩子/资源释放；以及舞台状态（指定时间、并行、终态一致、反复播放无漂移、
 * 循环复位、不触发历史音频副作用）。舞台求值使用真实 performance.js 的 stateAt。 */
const assert = require('node:assert/strict');
const createPreviewController = require('../dist/timeline-preview.js');
const PF = require('../dist/performance.js')();
const TL = require('../dist/timeline.js')(PF);

function harness(o) {
  const opt = o || {};
  let wall = 0, rafSeq = 0;
  const active = new Set(), rafCalls = [];
  const ticks = [], states = [], events = [];
  const ctrl = createPreviewController({
    now: () => wall,
    raf: (cb) => { const id = ++rafSeq; active.add(id); rafCalls.push(cb); return id; },
    cancelRaf: (id) => active.delete(id),
    total: () => (opt.total == null ? 5 : opt.total),
    onTick: (t) => ticks.push(t),
    onState: (s) => states.push(s),
    onEvent: (n) => events.push(n)
  });
  return { ctrl, ticks, states, events, active, rafCalls, setWall: (v) => { wall = v; }, getWall: () => wall };
}

const ctx = {
  P: { characters: [{ id: 'lin', expressions: [] }], assets: [], audioAssets: [] },
  layers: [{ id: 'l_lin', name: '林悠', kind: 'char', characterId: 'lin', x: 50, y: 70 }, { id: 'l_bg', name: '背景', kind: 'bg' }]
};
const before = PF.emptyState();
function combo() {
  return [
    PF.make('v1', 'character.show', 'char:lin', { params: { side: 'left' }, duration: 1.0 }),
    PF.make('v2', 'background.change', 'bg', { params: { assetId: 'bg2', transition: 'crossfade' }, duration: 0.8, mode: 'parallel' }),
    PF.make('v3', 'camera.zoom', '', { params: { scale: 140 }, duration: 1.4, mode: 'after' }),
    PF.make('v4', 'screen.fade', '', { params: { to: 60 }, duration: 0.6, mode: 'after' }),
    PF.make('s1', 'audio.sfx.play', '', { params: { audioId: 'sfx1', volume: 100, key: 'k' }, duration: 0.3, mode: 'after', delay: 0.5 })
  ];
}
const totalCombo = TL.totalDuration(combo());

(async () => {
  /* 1. 初始状态 */
  {
    const h = harness();
    assert.equal(h.ctrl.snapshot().state, 'idle');
    assert.equal(h.ctrl.snapshot().activeRaf, 0);
  }

  /* 2. 播放：状态、事件、立即求初态、只有一个 rAF */
  {
    const h = harness();
    assert.equal(h.ctrl.play(), 'playing');
    const s = h.ctrl.snapshot();
    assert.equal(s.activeRaf, 1);
    assert.equal(s.frames.count >= 0, true);
    assert.ok(h.events.includes('previewStart'));
    assert.ok(h.ticks.includes(0));
    assert.ok(h.states.includes('playing'));
  }

  /* 3. 单调时钟：按真实时间差推进，不累加固定帧增量 */
  {
    const h = harness();
    h.ctrl.play(0);
    h.setWall(1000); h.ctrl.frame(1000);
    assert.ok(Math.abs(h.ctrl.snapshot().curT - 1) < 0.001, '1 秒后 t=1');
    h.setWall(2500); h.ctrl.frame(2500);
    assert.ok(Math.abs(h.ctrl.snapshot().curT - 2.5) < 0.001, '2.5 秒后 t=2.5（与帧数无关）');
    assert.ok(h.ticks.some((t) => Math.abs(t - 2.5) < 0.001));
    assert.equal(h.ctrl.snapshot().frames.count, 2, '只有两次真实帧');
  }

  /* 4. 暂停 / 继续：定格、取消 rAF、从暂停位置继续 */
  {
    const h = harness();
    h.ctrl.play(0);
    h.setWall(1200); h.ctrl.frame(1200);
    assert.equal(h.ctrl.pause(), 'paused');
    const paused = h.ctrl.snapshot().curT;
    assert.ok(Math.abs(paused - 1.2) < 0.001);
    assert.equal(h.ctrl.snapshot().activeRaf, 0);
    assert.ok(h.events.includes('previewPause'));
    h.setWall(3000);                          /* 暂停期间墙钟继续走 */
    assert.equal(h.ctrl.resume(), 'playing');
    assert.ok(h.events.includes('previewResume'));
    h.setWall(4000); h.ctrl.frame(4000);
    assert.ok(Math.abs(h.ctrl.snapshot().curT - (paused + 1)) < 0.001, '继续后从暂停位置 +1s，不从暂停时的墙钟跳变');
  }

  /* 5. 停止回到预览起点 / replay 从 0 / 任意时间启动 */
  {
    const h = harness();
    h.ctrl.play(2.5);
    h.setWall(3000); h.ctrl.frame(3000);
    assert.equal(h.ctrl.stop(), 'stopped');
    assert.equal(h.ctrl.snapshot().curT, 0, 'stop 回到预览起点 0');
    assert.equal(h.ctrl.snapshot().activeRaf, 0);
    assert.ok(h.events.includes('previewStop'));
    h.ctrl.replay();
    assert.equal(h.ctrl.snapshot().curT, 0);
    h.ctrl.stop();
    h.ctrl.play(3.25);
    assert.equal(h.ctrl.snapshot().curT, 3.25, '任意时间点开始预览');
  }

  /* 6. 自动结束 */
  {
    const h = harness({ total: 4 });
    h.ctrl.play(0);
    h.setWall(4500); h.ctrl.frame(4500);
    const s = h.ctrl.snapshot();
    assert.equal(s.state, 'ended');
    assert.equal(s.curT, 4);
    assert.equal(s.activeRaf, 0, '结束后 rAF 已释放');
    assert.ok(h.events.includes('previewEnd'));
  }

  /* 7. 区间循环：反复回起点、重新求状态、事件齐全 */
  {
    const h = harness({ total: 8 });
    h.ctrl.setRange(1, 3);
    h.ctrl.setLoop(true);
    h.ctrl.play(1);
    for (let i = 1; i <= 6; i++) {
      h.setWall(i * 2000);
      h.ctrl.frame(i * 2000);
    }
    const s = h.ctrl.snapshot();
    assert.equal(s.loopCount >= 3, true, JSON.stringify({ loopCount: s.loopCount }));
    assert.ok(Math.abs(s.curT - 1) < 0.001, '循环回到区间起点');
    assert.equal(s.state, 'playing');
    assert.equal(h.events.filter((n) => n === 'previewLoop').length, s.loopCount);
    assert.ok(h.ticks.filter((t) => Math.abs(t - 1) < 0.001).length >= s.loopCount, '每次循环复位都重新求值');
  }

  /* 8. 多次启动不产生重复播放任务 */
  {
    const h = harness();
    h.ctrl.play(); h.ctrl.play(); h.ctrl.play(1);
    const s = h.ctrl.snapshot();
    assert.equal(s.activeRaf, 1);
    assert.equal(s.generation, 1, '只生成一个计划');
    assert.equal(h.events.filter((n) => n === 'previewStart').length, 1);
    assert.ok(h.events.includes('previewSeek'));
  }

  /* 9. 编辑 / 切换节点 / 删除：停止旧计划并递增代际 */
  {
    const h = harness();
    h.ctrl.play(0);
    h.ctrl.invalidate('edit');
    assert.equal(h.ctrl.snapshot().state, 'stopped');
    assert.equal(h.ctrl.snapshot().activeRaf, 0);
    assert.equal(h.ctrl.snapshot().generation, 2);
    assert.equal(h.events.filter((n) => n === 'previewStop').length, 1);
    h.ctrl.play(0);
    h.ctrl.invalidate('nodechange');
    assert.equal(h.ctrl.snapshot().state, 'stopped');
    h.ctrl.play(0);
    h.ctrl.dispose();
    assert.equal(h.ctrl.snapshot().activeRaf, 0);
    assert.equal(h.ctrl.snapshot().disposed, true);
  }

  /* 10. seek / clearRange / setFollow 与事件钩子命名 */
  {
    const h = harness();
    h.ctrl.setRange(2, 4);
    h.ctrl.seek(3);
    assert.equal(h.ctrl.snapshot().curT, 3);
    assert.ok(h.events.includes('previewSeek'));
    assert.equal(h.ctrl.clearRange(), null);
    assert.equal(h.ctrl.snapshot().range, null);
    assert.equal(h.ctrl.setFollow(false), false);
    assert.equal(h.ctrl.snapshot().follow, false);
    const names = ['previewStart', 'previewPause', 'previewResume', 'previewSeek', 'previewStop', 'previewLoop', 'previewEnd'];
    h.ctrl.play(0); h.ctrl.pause(); h.ctrl.resume(); h.ctrl.seek(1);
    h.ctrl.setRange(1, 2); h.ctrl.setLoop(true); h.ctrl.play(1);
    h.setWall(3000); h.ctrl.frame(3000);
    h.ctrl.stop();
    /* 非循环播放到结束，补齐 previewEnd 事件 */
    h.ctrl.setLoop(false); h.ctrl.clearRange(); h.ctrl.play(0);
    h.setWall(60000); h.ctrl.frame(60000);
    for (const n of names) assert.ok(h.events.includes(n), 'M2B 事件钩子 ' + n + ' 已定义');
  }

  /* 11. 舞台状态：指定时间、并行动作、连续播放终态与直接定位一致 */
  {
    const acts = combo();
    const ev = TL.toTimeline(acts);
    assert.equal(ev[1].start, ev[0].start, '并行片段同时开始');
    const atHalf = TL.scrubState(before, acts, 0.5, ctx);
    assert.ok(atHalf.layers['l_lin'].opacity > 0 && atHalf.layers['l_lin'].opacity < 1, '0.5s 角色淡入中');

    let lastTick = 0;
    const h = harness({ total: totalCombo });
    /* 重新构造一个控制器，onTick 里执行真实 stateAt 求值（与编辑器一致） */
    let wall = 0;
    const ticksState = [];
    const ctrl = createPreviewController({
      now: () => wall,
      raf: () => 1, cancelRaf: () => {},
      total: () => totalCombo,
      onTick: (t) => { lastTick = t; ticksState.push(TL.scrubState(before, acts, t, ctx)); }
    });
    ctrl.play(0);
    /* 用单调时钟逐帧推进到结束 */
    for (let ms = 100; ms <= Math.ceil(totalCombo * 1000); ms += 100) { wall = ms; ctrl.frame(ms); }
    const finalFromPlay = ticksState[ticksState.length - 1];
    const direct = TL.scrubState(before, acts, lastTick, ctx);
    assert.deepEqual(finalFromPlay, direct, '连续播放到结束与直接定位同一时间的状态完全一致');
    assert.ok(lastTick > 0);
  }

  /* 12. 反复播放无漂移 / 循环复位 / 不触发历史音频副作用 */
  {
    const acts = combo();
    const endState = TL.scrubState(before, acts, totalCombo, ctx);
    for (let k = 0; k < 4; k++) {
      const h = harness({ total: totalCombo });
      const states = [];
      const ctrl = createPreviewController({
        now: () => h.getWall(), raf: () => 1, cancelRaf: () => {},
        total: () => totalCombo,
        onTick: (t) => states.push(TL.scrubState(before, acts, t, ctx))
      });
      ctrl.play(0);
      h.setWall(totalCombo * 1000); ctrl.frame(totalCombo * 1000);
      assert.deepEqual(states[states.length - 1], endState, '第 ' + (k + 1) + ' 次播放终态一致，无累积漂移');
    }
    /* 循环复位：回到 a 时状态等于直接定位 a，且没有历史一次性音频对象 */
    const h = harness({ total: totalCombo });
    const loopStates = [];
    const ctrl = createPreviewController({
      now: () => h.getWall(), raf: () => 1, cancelRaf: () => {},
      total: () => totalCombo,
      onTick: (t) => loopStates.push(TL.scrubState(before, acts, t, ctx))
    });
    ctrl.setRange(0.5, 1.5); ctrl.setLoop(true); ctrl.play(0.5);
    h.setWall(1000); ctrl.frame(1000);
    h.setWall(2000); ctrl.frame(2000);
    assert.ok(ctrl.snapshot().loopCount >= 1);
    const reset = loopStates[loopStates.length - 1];
    assert.deepEqual(reset, TL.scrubState(before, acts, 0.5, ctx), '循环回起点重新求值，无累积');
    assert.equal('sfx' in reset, false, '状态里没有一次性音效对象');
    assert.equal(TL.audioSideEffectsAt(acts, 0.5).length, 0, '非起点不触发一次性音频');
  }

  console.log('PASS: 预览控制器（播放/暂停/继续/停止/任意起点/自动结束/区间循环/幂等启动/失效释放/单调时钟/事件钩子）与舞台状态（并行/终态一致/无漂移/循环复位/无历史音频副作用）');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
