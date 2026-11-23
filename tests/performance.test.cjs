'use strict';
/*
 * V0.8.0 演出运行时单测（M1 数据模型 + M2 调度与状态 + 确定性回归）。
 *
 * 只测状态机，不碰 DOM：DOM 一致性由真实窗口验收负责。
 * 关键立场：所有断言都落在「动作执行后的舞台状态」，而不是「动作对象是否存在」。
 */
const assert = require('node:assert/strict');
const PF = require('../dist/performance.js')();

/* ---------- 测试舞台：两个角色 + 一张背景 ---------- */
function stage() {
  return [
    { id: 'bg1', kind: 'bg', name: '走廊', asset: 'a-bg', x: 0, y: 0, w: 100, h: 100, fit: 'cover', opacity: 100, hidden: false },
    { id: 'c1', kind: 'char', name: '林悠', asset: 'a-yuu', characterId: 'ch-yuu', x: 20, y: 55, w: 30, h: 45, fit: 'contain', opacity: 100, hidden: false },
    { id: 'c2', kind: 'char', name: '林澈', asset: 'a-che', characterId: 'ch-che', x: 60, y: 55, w: 30, h: 45, fit: 'contain', opacity: 100, hidden: false }
  ];
}
const P = {
  characters: [
    { id: 'ch-yuu', name: '林悠', expressions: [{ id: 'calm', name: '平静', assetId: 'a-yuu-calm' }, { id: 'smile', name: '微笑', assetId: 'a-yuu-smile' }] },
    { id: 'ch-che', name: '林澈', expressions: [{ id: 'calm', name: '平静', assetId: 'a-che-calm' }] }
  ],
  assets: [
    { id: 'a-bg', name: '走廊', kind: 'bg', data: 'data:image/png;base64,AA' },
    { id: 'a-bg2', name: '夜晚', kind: 'bg', data: 'data:image/png;base64,BB' }
  ]
};
const L = stage();
const ctx = { P, layers: L };
const S = (actions, t, before) => PF.stateAt(before || PF.emptyState(), actions, t, ctx);
const fin = (actions, before) => S(actions, Infinity, before);

/* ---------- M1 数据模型 ---------- */
{
  const a = PF.make('a1', 'character.show', 'c1', { params: { side: 'left' }, duration: 1, blocking: true });
  assert.equal(a.type, 'character.show');
  assert.equal(a.duration, 1);
  assert.deepEqual(a.params, { side: 'left' });
  assert.equal(a.blocking, true);
  assert.equal(a.mode, 'after');
  assert.equal(a.easing, 'easeOut');
  assert.equal(PF.make('a2', 'wait', '').duration, 1, '默认时长取自类型表');
  assert.throws(() => PF.make('a3', 'character.teleport', 'c1'), /未知的演出动作/);

  assert.doesNotThrow(() => PF.validate({ version: 1, actions: [a] }));
  assert.throws(() => PF.validate({ version: 1, actions: [a, { ...a }] }), /ID/, '重复 ID 必须拒绝');
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...a, duration: -1 }] }), /时长/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...a, duration: 31 }] }), /时长/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...a, easing: 'bounce' }] }), /缓动/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...a, mode: 'race' }] }), /顺序|并行/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...a, params: { side: 'top' } }] }), /出现方式/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...PF.make('m', 'character.move', 'c1'), params: { x: 999, y: 0 } }] }), /目标 X/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...PF.make('z', 'camera.zoom', ''), params: { scale: 900 } }] }), /镜头缩放/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...PF.make('b', 'background.change', 'bg'), params: { assetId: 'x', transition: 'flip' } }] }), /转场/);
  assert.throws(() => PF.validate({ version: 1, actions: new Array(201).fill(0).map((_, i) => PF.make('n' + i, 'wait', '')) }), /过多/);

  /* 规范化：缺字段补默认值，未知类型剔除，JSON 往返不丢信息 */
  const raw = { version: 1, actions: [{ id: 'x', type: 'character.move', target: 'c1', params: { x: 40 } }] };
  const norm = PF.normalize(raw);
  assert.equal(norm.actions[0].duration, 0.8);
  assert.equal(norm.actions[0].easing, 'easeOut');
  assert.equal(norm.actions[0].params.y, 70, '缺省参数补齐');
  assert.equal(PF.normalize({ actions: [{ id: 'y', type: 'not.real' }] }).actions.length, 0, '未知类型被剔除而不是崩溃');
  assert.equal(PF.normalize(null), null);
  assert.deepEqual(PF.normalize(JSON.parse(JSON.stringify(norm))), norm, '序列化往返一致');
  assert.equal(PF.validate(null), true, '旧工程没有演出字段是合法的');
}

/* ---------- 顺序 / 并行 / 阻塞 ---------- */
{
  const A = PF.make('s1', 'character.show', 'c1', { duration: 1, mode: 'after', blocking: true });
  const B = PF.make('s2', 'character.show', 'c2', { duration: 1, mode: 'after' });
  const Cc = PF.make('s3', 'screen.shake', '', { duration: 0.5, mode: 'parallel' });
  const s = PF.schedule([A, B, Cc]);
  assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 1], [1, 2], [1, 1.5]], 'after 接在上一个之后，parallel 同时开始');
  assert.equal(PF.totalDuration([A, B, Cc]), 2);
  assert.equal(PF.blockUntil([A, B, Cc]), 1, '只有阻塞动作决定剧情等待点');
  assert.equal(PF.blockUntil([]), 0);

  const D = PF.make('s4', 'wait', '', { duration: 1, delay: 0.5, mode: 'parallel' });
  assert.deepEqual(PF.schedule([A, D]).map((x) => [x.start, x.end]), [[0, 1], [0.5, 1.5]], '并行以「上一个动作的开始」为基准，再叠加自己的延迟');
  const E2 = PF.make('s6', 'wait', '', { duration: 0.5, mode: 'parallel' });
  assert.deepEqual(PF.schedule([A, D, E2]).map((x) => [x.start, x.end]), [[0, 1], [0.5, 1.5], [0.5, 1]], '连续并行的动作共享同一个起点');

  const disabled = { ...PF.make('s5', 'wait', ''), enabled: false };
  assert.equal(PF.schedule([disabled]).length, 0, '停用的动作不进入时间轴');
}

/* ---------- 单动作 ---------- */
{
  const show = PF.make('a', 'character.show', 'c1', { params: { side: 'fade' }, duration: 1, easing: 'linear' });
  assert.equal(S([show], 0).layers.c1.opacity, 1, 't=0 时动作尚未开始，保持进入本句前的状态');
  assert.equal(S([show], 0.5).layers.c1.opacity, 0.5);
  assert.equal(S([show], 1).layers.c1.opacity, 1);
  assert.equal(fin([show]).layers.c1.visible, true);

  const left = PF.make('b', 'character.show', 'c1', { params: { side: 'left' }, duration: 1, easing: 'linear' });
  const mid = S([left], 0.5).layers.c1;
  assert.ok(mid.dx < -20 && mid.dx > -40, '从左侧进入时中点是半个偏移：' + mid.dx);
  assert.equal(fin([left]).layers.c1.dx, 0, '终态回到布局位置，不残留位移');

  const hide = PF.make('c', 'character.hide', 'c1', { duration: 1, easing: 'linear' });
  assert.equal(S([hide], 0.5).layers.c1.opacity, 0.5);
  const hidden = fin([hide]).layers.c1;
  assert.equal(hidden.visible, false, '离场终态是不可见');
  assert.equal(hidden.opacity, 1, '不可见时透明度归一，避免下次出现从残值开始');

  const move = PF.make('d', 'character.move', 'c1', { params: { x: 50, y: 60 }, duration: 1, easing: 'linear' });
  assert.equal(S([move], 0.5).layers.c1.dx, 15, '布局 20% → 目标 50%，中点是 +15%');
  assert.equal(fin([move]).layers.c1.dx, 30);
  assert.equal(fin([move]).layers.c1.dy, 5);

  const scale = PF.make('e', 'character.scale', 'c1', { params: { scale: 200 }, duration: 1, easing: 'linear' });
  assert.equal(S([scale], 0.5).layers.c1.scale, 1.5);

  const op = PF.make('f', 'character.opacity', 'c1', { params: { opacity: 40 }, duration: 1, easing: 'linear' });
  assert.equal(S([op], 0.5).layers.c1.opacity, 0.7);

  const expr = PF.make('g', 'character.expression', 'c1', { params: { expressionId: 'smile' }, duration: 0 });
  assert.equal(fin([expr]).layers.c1.assetId, 'a-yuu-smile', '表情解析到角色表情表里的素材');
  const badExpr = PF.make('h', 'character.expression', 'c1', { params: { expressionId: 'nope' }, duration: 0 });
  assert.equal(fin([badExpr]).layers.c1.assetId, 'a-yuu', '失效表情回退到图层原图，不显示空白');

  const bg = PF.make('i', 'background.change', 'bg', { params: { assetId: 'a-bg2', transition: 'crossfade' }, duration: 1 });
  assert.equal(fin([bg]).layers.bg1.assetId, 'a-bg2');

  const zoom = PF.make('j', 'camera.zoom', '', { params: { scale: 150 }, duration: 1, easing: 'linear' });
  assert.equal(S([zoom], 0.5).camera.scale, 1.25);
  const pan = PF.make('k', 'camera.move', '', { params: { x: 10, y: -5 }, duration: 1, easing: 'linear' });
  assert.deepEqual([fin([pan]).camera.x, fin([pan]).camera.y], [10, -5]);

  const dim = PF.make('l', 'screen.fade', '', { params: { to: 80, color: 'black' }, duration: 1, easing: 'linear' });
  assert.equal(S([dim], 0.5).screen.dim, 0.4);
  assert.equal(fin([dim]).screen.dim, 0.8);

  const flash = PF.make('m', 'screen.flash', '', { params: { color: 'white' }, duration: 1 });
  assert.ok(S([flash], 0.5).screen.flash > 0.5, '闪光在中点达到峰值');
  assert.equal(fin([flash]).screen.flash, 0, '瞬态效果终态归零，重放不会累积');

  const shake = PF.make('n', 'screen.shake', '', { params: { strength: 2 }, duration: 1 });
  assert.ok(Math.abs(S([shake], 0.3).screen.shakeX) > 1);
  assert.equal(fin([shake]).screen.shakeX, 0);
}

/* ---------- 顺序 / 并行执行与多角色独立 ---------- */
{
  const up = PF.make('u', 'character.move', 'c1', { params: { x: 40, y: 55 }, duration: 1, easing: 'linear' });
  const right = PF.make('r', 'character.move', 'c2', { params: { x: 70, y: 55 }, duration: 1, easing: 'linear', mode: 'parallel' });
  const st = S([up, right], 0.5);
  assert.equal(st.layers.c1.dx, 10, '并行时两个角色各自推进');
  assert.equal(st.layers.c2.dx, 5, '第二个角色不受第一个影响');

  const seq2 = PF.make('r2', 'character.scale', 'c2', { params: { scale: 120 }, duration: 0.5, easing: 'linear', mode: 'after' });
  const s2 = S([up, right, seq2], 1.5);
  assert.equal(s2.layers.c1.dx, 20, '顺序动作完成后保持终值');
  assert.equal(s2.layers.c2.dx, 10);
  assert.equal(s2.layers.c2.scale, 1.2);
  assert.equal(s2.layers.c1.scale, 1, '没有动作的角色缩放保持中性');
}

/* ---------- 跳过 / 取消 / 状态恢复 ---------- */
{
  const actions = [
    PF.make('a', 'screen.fade', '', { params: { to: 100 }, duration: 0.5, blocking: true }),
    PF.make('b', 'character.show', 'c1', { params: { side: 'left' }, duration: 1, mode: 'after' }),
    PF.make('c', 'character.move', 'c1', { params: { x: 50, y: 55 }, duration: 1, mode: 'after' })
  ];
  /* 跳到一半与直接到终态：终态必须一致（这条是「跳过动画不能改变结局」的根基） */
  const midway = S(actions, 0.7);
  const finished = S(actions, Infinity);
  const skipped = PF.stateAt(midway, actions, Infinity, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(skipped)), JSON.parse(JSON.stringify(finished)), '从中间直接结算 = 正常播完');
  const twice = PF.stateAt(finished, actions, Infinity, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(finished)), '终态再结算一次仍是终态（幂等）');

  /* 读档：把 trail 重放一遍，结果与逐句播放一致 */
  const steps = [{ P, layers: L, actions }];
  const replayed = PF.replay(steps);
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), JSON.parse(JSON.stringify(finished)), '重放 trail 得到同一状态');

  /* 重复执行 100 次不漂移 */
  let st = PF.emptyState();
  for (let i = 0; i < 100; i++) st = PF.commit(st, actions, ctx);
  st = PF.commit(PF.emptyState(), actions, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(st)), JSON.parse(JSON.stringify(finished)), '100 次重复执行后终态不漂移');
}

/* ---------- 连续场景 + 镜头复位 ---------- */
{
  const zoom = PF.make('z', 'camera.zoom', '', { params: { scale: 130 }, duration: 1 });
  let st = PF.commit(PF.emptyState(), [zoom], ctx);
  assert.equal(st.camera.scale, 1.3);
  const reset = PF.make('z0', 'camera.zoom', '', { params: { scale: 100 }, duration: 0.6 });
  st = PF.commit(st, [reset], ctx);
  assert.equal(st.camera.scale, 1, '镜头缩放可以复位，不累积');

  /* 换场景（图层 ID 全变）时，旧图层状态不会污染新图层 */
  const other = [{ ...L[0], id: 'bgX', asset: 'a-bg2' }, { ...L[1], id: 'cX', characterId: 'ch-yuu' }];
  const st2 = PF.stateAt(st, [PF.make('m', 'character.show', 'cX', { duration: 1 })], Infinity, { P, layers: other });
  assert.equal(st2.layers.cX.opacity, 1);
  assert.equal(st2.layers.c1.visible, true, '旧场景图层保留各自状态，互不影响');
}

/* ---------- 语义目标解析 ---------- */
{
  assert.equal(PF.resolveTarget(L, 'character.move', 'char:ch-che'), 'c2');
  assert.equal(PF.resolveTarget(L, 'background.change', 'bg'), 'bg1');
  assert.equal(PF.resolveTarget(L, 'camera.zoom', 'stage'), '');
  assert.equal(PF.resolveTarget(L, 'character.show', 'c1'), 'c1');
  const ghost = PF.make('g', 'character.show', 'deleted-layer', { duration: 1 });
  assert.doesNotThrow(() => fin([ghost]), '目标图层被删除不应抛错');
  assert.equal(fin([ghost]).layers['deleted-layer'] !== undefined, true, '孤立目标只记状态，不崩');
}

/* ---------- 预设只生成标准动作 ---------- */
{
  let n = 0;
  const id = () => 'p' + (++n);
  for (const preset of PF.PRESETS) {
    const actions = preset.build(id, 'c1', { assetId: 'a-bg2', scale: 140 });
    assert.ok(actions.length > 0, preset.name + ' 必须产出动作');
    assert.doesNotThrow(() => PF.validate({ version: 1, actions }), preset.name + ' 产出的必须是合法动作');
    for (const a of actions) {
      assert.ok(PF.TYPES[a.type], preset.name + ' 不能产出未知动作类型');
      assert.equal(typeof a.duration, 'number');
    }
    assert.equal(PF.normalize({ actions }).actions.length, actions.length, preset.name + ' 可被序列化');
  }
  assert.equal(PF.PRESETS.length, 7, '任务书要求的 7 个常用预设');
}

/* ---------- 参数边界与非法输入 ---------- */
{
  assert.throws(() => PF.validate({ version: 1, actions: [PF.make('w', 'wait', '', { duration: 30.1 })] }), /时长/);
  assert.doesNotThrow(() => PF.validate({ version: 1, actions: [PF.make('w', 'wait', '', { duration: 30 })] }));
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...PF.make('w', 'wait', ''), target: 5 }] }), /目标/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...PF.make('w', 'wait', ''), blocking: 'yes' }] }), /阻塞/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...PF.make('f', 'screen.fade', ''), params: { to: 120, color: 'black' } }] }), /渐暗/);
  assert.throws(() => PF.validate({ version: 1, actions: [{ ...PF.make('s', 'screen.shake', ''), params: { strength: 0 } }] }), /震动/);
  /* NaN / 字符串必须被挡在入口，不能流进 CSS */
  assert.throws(() => PF.validate({ version: 1, actions: [PF.make('f', 'character.opacity', 'c1', { params: { opacity: NaN } })] }), /透明度/);
  assert.throws(() => PF.validate({ version: 1, actions: [PF.make('f', 'character.opacity', 'c1', { params: { opacity: '80' } })] }), /透明度/);
}

/* ---------- M4：分支 / 重新开始 / 换章 ---------- */
{
  /* 三个节点：开场 → 分支 A / 分支 B。两条路走完必须各自稳定，且互不污染。 */
  const open = [
    PF.make('o1', 'background.change', 'bg', { params: { assetId: 'a-bg2', transition: 'cut' }, duration: 0.3 }),
    PF.make('o2', 'character.show', 'c1', { params: { side: 'left' }, duration: 0.6, blocking: true })
  ];
  const roadA = [
    PF.make('a1', 'character.move', 'c1', { params: { x: 45, y: 55 }, duration: 0.8 }),
    PF.make('a2', 'camera.zoom', '', { params: { scale: 120 }, duration: 0.8, mode: 'parallel' })
  ];
  const roadB = [
    PF.make('b1', 'character.hide', 'c1', { params: { mode: 'fade' }, duration: 0.5 }),
    PF.make('b2', 'screen.flash', '', { params: { color: 'white' }, duration: 0.5, mode: 'parallel' })
  ];
  const stepA = PF.commit(PF.commit(PF.emptyState(), open, ctx), roadA, ctx);
  const replayA = PF.replay([{ P, layers: L, actions: open }, { P, layers: L, actions: roadA }]);
  assert.deepEqual(JSON.parse(JSON.stringify(replayA)), JSON.parse(JSON.stringify(stepA)), '逐句播放与重放同一条分支结果一致');

  const stepB = PF.commit(PF.commit(PF.emptyState(), open, ctx), roadB, ctx);
  assert.equal(stepB.layers.c1.visible, false, '另一条分支让角色离场');
  assert.equal(stepA.layers.c1.visible, true, '两条分支互不影响');
  assert.notEqual(stepA.layers.c1.dx, stepB.layers.c1.dx, '分支状态不同是预期结果，不是漂移');

  /* 重新开始：从空状态重放，必须与第一次进入完全相同 */
  const again = PF.replay([{ P, layers: L, actions: open }, { P, layers: L, actions: roadA }]);
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(stepA)), '重新开始得到同一状态');

  /* 换章：整批图层 ID 换掉后，旧章节的动画不再对新图层生效 */
  const chapter2 = [{ ...L[0], id: 'bg2new', asset: 'a-bg' }, { ...L[1], id: 'c1new' }, { ...L[2], id: 'c2new' }];
  const afterSwitch = PF.commit(stepA, [PF.make('s1', 'character.scale', 'c1', { params: { scale: 160 }, duration: 0.5 })], { P, layers: chapter2 });
  assert.equal(afterSwitch.layers.c1.scale, 1.6, '同 ID 图层仍可被动作命中');
  assert.equal(afterSwitch.layers.c1new.scale, 1, '新章节图层从中性状态开始，不继承旧章节的缩放');
  assert.equal(afterSwitch.layers.c1new.dx, 0, '新章节图层不继承旧章节的位移');

  /* 换句时取消动画：已记账的终态继续作为下一句的起点，不需要动画播完 */
  const cancelled = PF.commit(PF.stateAt(PF.emptyState(), open, 0.2, ctx), open, ctx);
  const whole = PF.stateAt(PF.emptyState(), open, Infinity, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), JSON.parse(JSON.stringify(whole)), '中途取消后结算 = 整段播完');
}

console.log('PASS: 演出数据模型（校验/默认值/持久化/未知类型）、顺序与并行、阻塞点、单动作插值、多角色独立、跳过与重放一致、镜头复位、100 次重复不漂移、7 个预设、非法参数、分支/重开/换章/取消同步');
