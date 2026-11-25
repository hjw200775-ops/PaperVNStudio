'use strict';
/* V0.8.2-M0 / M0-6：时间轴数据层核心测试。
 * 覆盖：旧动作列表映射、顺序/并行、时间偏移、确定性排序、指定时间状态、
 * 非法时间参数、播放头回退、历史一次性音频防重放、旧工程终态一致、start 字段映射。 */
const assert = require('node:assert/strict');
const PF = require('../dist/performance.js')();
const TL = require('../dist/timeline.js')(PF);

/* 构造 M0-5 要求的演出组合：角色左侧进入 + 背景交叉淡化并行 + 镜头推进 + BGM 淡入 + 延迟 SFX */
function combo() {
  const acts = [
    PF.make('a1', 'character.show', 'char:lin', { params: { side: 'left' }, duration: 1.0, blocking: true }),
    PF.make('a2', 'background.change', 'bg', { params: { assetId: 'bg2', transition: 'crossfade' }, duration: 0.8, mode: 'parallel' }),
    PF.make('a3', 'camera.zoom', '', { params: { scale: 110 }, duration: 1.4, mode: 'after' }),
    PF.make('a4', 'audio.bgm.play', '', { params: { audioId: 'bgm1', volume: 80, fadeIn: 2, loopMode: 'all' }, duration: 2, mode: 'after' }),
    PF.make('a5', 'audio.sfx.play', '', { params: { audioId: 'sfx1', volume: 100, key: 'chime' }, duration: 0.3, mode: 'after', delay: 0.5 })
  ];
  return acts;
}
const ctx = { P: { characters: [{ id: 'lin', expressions: [] }], assets: [], audioAssets: [] }, layers: [{ id: 'l_lin', name: '林悠', kind: 'char', characterId: 'lin', x: 50, y: 70 }, { id: 'l_bg', name: '背景', kind: 'bg' }] };
const before = PF.emptyState();

(async () => {
  /* 1. 旧动作列表映射：after/parallel + delay → 绝对时间 */
  {
    const ev = TL.toTimeline(combo());
    assert.equal(ev.length, 5, '5 个动作全部物化');
    assert.equal(ev[0].start, 0, 'a1 从 0 开始');
    assert.equal(ev[1].start, 0, 'a2 parallel 与 a1 同时开始');
    assert.equal(ev[2].start, 1.0, 'a3 after 排在 cursor=max(1.0,0.8)=1.0 之后');
  }
  /* 2. 顺序 / 并行语义精确值 */
  {
    const ev = TL.toTimeline(combo());
    assert.equal(ev[0].start, 0); assert.equal(ev[0].end, 1.0);
    assert.equal(ev[1].start, 0); assert.equal(ev[1].end, 0.8);   // 并行
    assert.equal(ev[2].start, 1.0); assert.equal(ev[2].end, 2.4);  // after，排在 a1 后
    assert.equal(ev[3].start, 2.4); assert.equal(ev[3].end, 4.4);  // after，排在 a3 后
    assert.equal(ev[4].start, 4.9); assert.equal(ev[4].end, 5.2);  // after + delay 0.5
  }
  /* 3. 时间偏移（delay） */
  {
    const acts = [PF.make('x1', 'wait', '', { duration: 1 }), PF.make('x2', 'wait', '', { duration: 1, delay: 0.3, mode: 'after' })];
    const ev = TL.toTimeline(acts);
    assert.equal(ev[1].start, 1.3, 'delay 0.3 使第二个动作从 1.3 开始');
  }
  /* 4. 相同时间动作的确定性排序 */
  {
    const acts = [
      PF.make('p1', 'character.opacity', 'char:lin', { duration: 0.5, mode: 'after' }),
      PF.make('p2', 'camera.zoom', '', { duration: 0.5, mode: 'parallel' }),
      PF.make('p3', 'camera.move', '', { duration: 0.5, mode: 'parallel' })
    ];
    const ev = TL.toTimeline(acts);
    assert.equal(ev[0].start, 0); assert.equal(ev[1].start, 0); assert.equal(ev[2].start, 0, '三个并行同时开始');
    assert.deepEqual(ev.map((e) => e.id), ['p1', 'p2', 'p3'], '列表顺序稳定（确定性排序）');
  }
  /* 5. 指定时间舞台状态（stateAt / scrubState） */
  {
    const acts = combo();
    const mid = TL.scrubState(before, acts, 0.5, ctx);   // 角色进场进行到一半
    const end = TL.scrubState(before, acts, Infinity, ctx); // 终态
    assert.equal(mid.layers['l_lin'].opacity > 0 && mid.layers['l_lin'].opacity < 1, true, '0.5s 时角色半透明（进场中）');
    assert.equal(end.layers['l_lin'].opacity, 1, '终态角色完全可见');
    assert.equal(end.audio.bgm.audioId, 'bgm1', '终态 BGM 已设为 bgm1');
  }
  /* 6. 播放头回退：任意位置重算，与推进顺序无关（纯函数） */
  {
    const acts = combo();
    const fwd = TL.scrubState(before, acts, 0.3, ctx);
    const back = TL.scrubState(before, acts, 0.1, ctx);
    const again = TL.scrubState(before, acts, 0.3, ctx);
    assert.deepEqual(fwd, again, '回退再前进得到同一状态');
    assert.equal(back.layers['l_lin'].opacity < fwd.layers['l_lin'].opacity, true, '回退后角色透明度更低');
  }
  /* 7. 历史一次性音频防重放：scrubState 不含 SFX/Voice；audioSideEffectsAt 精确命中起点 */
  {
    const acts = combo();
    const st = TL.scrubState(before, acts, 6, ctx);
    assert.equal('sfx' in st, false, '状态里没有 sfx（一次性音频不重放）');
    const at = TL.audioSideEffectsAt(acts, 4.9);
    assert.equal(at.length, 1); assert.equal(at[0].action.id, 'a5', '4.9s 处应触发 a5 音效');
    assert.equal(TL.audioSideEffectsAt(acts, 4.0).length, 0, '4.0s 处不触发（未到起点）');
  }
  /* 8. 非法时间参数 */
  {
    const bad = combo(); bad[0].start = -1;
    assert.throws(() => PF.validate({ version: 1, actions: bad }), /开始时间/);
    const bad2 = combo(); bad2[0].start = 999999;
    assert.throws(() => PF.validate({ version: 1, actions: bad2 }), /开始时间/);
  }
  /* 9. 旧工程终态一致：物化 start 后，终态与旧 after/parallel 完全一致 */
  {
    const legacy = combo();
    const ev = TL.toTimeline(legacy);
    const materialized = ev.map((e) => { const a = { ...e.action }; a.start = e.start; return a; });
    const a = TL.scrubState(before, legacy, Infinity, ctx);
    const b = TL.scrubState(before, materialized, Infinity, ctx);
    assert.deepEqual(a, b, '物化 start 后的终态与旧动作列表完全一致');
  }
  /* 10. start 字段映射：显式 start 覆盖 after/parallel 计算 */
  {
    const acts = combo();
    TL.setStart(acts[4], 1.0); // 把 SFX 拖到 1.0s
    const ev = TL.toTimeline(acts);
    assert.equal(ev[4].start, 1.0, '显式 start 生效，覆盖 delay 计算');
    const all = TL.toTimeline(acts);
    assert.equal(all[0].start, 0); assert.equal(all[1].start, 0); assert.equal(all[2].start, 1.0); assert.equal(all[3].start, 2.4);
  }
  /* 11. 轨道分组 */
  {
    const ev = TL.toTimeline(combo());
    assert.equal(ev[0].track, '角色·lin');
    assert.equal(ev[1].track, '背景');
    assert.equal(ev[2].track, '镜头');
    assert.equal(ev[3].track, 'BGM');
    assert.equal(ev[4].track, 'SFX');
  }

  console.log('PASS: 时间轴数据层（映射/顺序并行/偏移/确定性/定位/回退/防重放/终态一致/start 映射/轨道）');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
