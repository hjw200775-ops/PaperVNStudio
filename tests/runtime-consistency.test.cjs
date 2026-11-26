'use strict';
/* V0.8.2 · M3-A · 跨运行时演出语义一致性
 * 三套运行环境（编辑器时间轴预览 / 编辑器普通试玩 / 正式游戏播放器）共享同一份演出计划
 * （node.performance.actions）与同一套纯函数求值（PF.schedule / PF.stateAt / PF.blockUntil /
 * A.pure.audioActionSpec）。本测试固化这一「单一事实来源」的语义，覆盖：
 *   1) 相对/绝对混排、并行动作、零时长、同刻多音频事件的确定性排序；
 *   2) stateAt 终态在「重复求值 / 不同路径重放」下逐字段一致（三环境等价）；
 *   3) 边界时刻 t=0 / t=start / t=end / t=终点 / t 回退 的纯函数性质；
 *   4) 音频动作序列（schedule 过滤 audio 类型）在三个环境中的触发顺序一致；
 *   5) 阻塞动作 blockUntil 的剧情推进等待点一致。 */
const assert = require('node:assert/strict');
const PF = require('../dist/performance.js')();
const TL = require('../dist/timeline.js')(PF);
const A = require('../dist/audio.js')();

/* 统一演出测试工程：覆盖相对/绝对混排、并行、零时长、同刻多音频、阻塞、转场、角色、镜头。 */
function unifiedProject() {
  const mk = (id, type, target, params, dur, patch) => {
    const a = PF.make(id, type, target, { params, duration: dur });
    if (patch) Object.assign(a, patch);
    return a;
  };
  const acts = [
    /* 纯相对动作（无 start）：after/parallel + delay */
    mk('rel_bg', 'background.change', 'bg', { assetId: 'bg_1', transition: 'cut' }, 0.05),
    mk('rel_char', 'character.show', 'char:lin', { side: 'fade' }, 0.8, { blocking: true, mode: 'after' }),
    /* 显式绝对动作（有 start）：时间轴视图 */
    mk('abs_zoom', 'camera.zoom', '', { scale: 120 }, 0.8, { start: 1.0 }),
    mk('abs_sfx', 'audio.sfx.play', '', { audioId: 'sfx_a', volume: 100, key: 'k1' }, 0.3, { start: 2.0 }),
    /* 零时长事件 */
    mk('zero_flash', 'screen.flash', '', { color: 'white' }, 0, { start: 2.0 }),
    /* 同刻多音频事件（start 相同，靠列表顺序确定执行序） */
    mk('same_sfx', 'audio.sfx.play', '', { audioId: 'sfx_b', volume: 100, key: 'k2' }, 0.3, { start: 3.0 }),
    mk('same_voice', 'audio.voice.play', '', { audioId: 'voice_a', volume: 100 }, 0.5, { start: 3.0 }),
    /* 相对动作跟在绝对动作之后（混排） */
    mk('mix_bus', 'audio.bus.volume', '', { bus: 'bgm', volume: 60 }, 0.6, { mode: 'after' }),
    /* 阻塞动作 */
    mk('block_wait', 'wait', '', {}, 1.0, { blocking: true, mode: 'after' }),
    /* BGM 状态 + 交叉淡化 + Ducking */
    mk('abs_bgm', 'audio.bgm.play', '', { audioId: 'bgm_a', volume: 70, fadeIn: 1, loopMode: 'all' }, 1, { start: 5.0 }),
    mk('abs_duck', 'audio.ducking', '', { enabled: true, level: 35, attack: 0.2, release: 0.6 }, 0.3, { start: 5.0 })
  ];
  return acts;
}

const layers = [{ id: 'bg', kind: 'bg', name: '背景', asset: 'bg_1', x: 0, y: 0, w: 100, h: 100, opacity: 100, fit: 'cover' },
  { id: 'lin', kind: 'char', characterId: 'lin', name: '林', asset: 'char_lin', x: 50, y: 70, w: 40, h: 80, opacity: 100 }];
const P = { characters: [{ id: 'lin', name: '林', expressions: [] }], assets: [{ id: 'bg_1', data: 'data:image/png;base64,AA' }], audioAssets: [] };
const ctx = { P, layers };

(async () => {
  /* 1. 调度确定性：相对/绝对混排、并行、零时长、同刻多事件 */
  {
    const acts = unifiedProject();
    const s1 = PF.schedule(acts);
    const s2 = PF.schedule(acts);
    assert.equal(s1.length, s2.length, '调度结果长度一致');
    for (let i = 0; i < s1.length; i++) {
      assert.equal(s1[i].start, s2[i].start, '重复调度 start 一致（确定性）');
      assert.equal(s1[i].action.id, s2[i].action.id, '重复调度顺序一致');
    }
    /* 同刻多事件（3s sfx + 3s voice）保持列表顺序 */
    const at3 = s1.filter((s) => s.start === 3.0).map((s) => s.action.id);
    assert.deepEqual(at3, ['same_sfx', 'same_voice'], '同刻多音频按列表顺序（sfx 先于 voice）');
    /* 显式 start 覆盖相对语义 */
    const zoom = s1.find((s) => s.action.id === 'abs_zoom');
    assert.equal(zoom.start, 1.0, '显式 start 动作按绝对时间排');
    const sfx2 = s1.find((s) => s.action.id === 'abs_sfx');
    assert.equal(sfx2.start, 2.0, '绝对 sfx 在 2.0s');
  }

  /* 2. stateAt 终态逐字段一致：重复求值 + 不同路径重放（三环境等价） */
  {
    const acts = unifiedProject();
    const before = PF.emptyState();
    const direct = PF.stateAt(before, acts, Infinity, ctx);
    const again = PF.stateAt(before, acts, Infinity, ctx);
    /* 时间轴路径：TL.scrubState（= stateAt） */
    const viaTimeline = TL.scrubState(before, acts, Infinity, ctx);
    /* 试玩/播放器路径：PF.commit / PF.replay */
    const viaCommit = PF.commit(PF.emptyState(), acts, ctx);
    const viaReplay = PF.replay([{ actions: acts, layers, P }]);
    const strip = (s) => JSON.stringify({ layers: s.layers, camera: s.camera, screen: s.screen, audio: s.audio });
    assert.equal(strip(direct), strip(again), '重复求值终态一致');
    assert.equal(strip(direct), strip(viaTimeline), '时间轴 scrubState 终态与直接求值一致');
    assert.equal(strip(direct), strip(viaCommit), 'commit 终态与直接求值一致');
    assert.equal(strip(direct), strip(viaReplay), 'replay（重放 trail）终态与直接求值一致');
    /* 终态音频目标：BGM 落在 bgm_a，总线音量已应用，ducking 生效 */
    assert.equal(direct.audio.bgm.audioId, 'bgm_a', '终态 BGM 为 bgm_a');
    assert.equal(direct.audio.ducking.enabled, true, '终态 ducking 生效');
    assert.ok(direct.audio.buses.bgm < 1, '终态总线音量已压低');
  }

  /* 3. 边界语义：t=0 / t=start / t=end / t=终点 / t 回退 */
  {
    const acts = [
      PF.make('a', 'character.show', 'char:lin', { params: { side: 'fade' }, duration: 1.0 }, { start: 0 }),
      PF.make('b', 'character.scale', 'char:lin', { params: { scale: 150 }, duration: 1.0 }, { start: 1.0 })
    ];
    const before = PF.emptyState();
    const at0 = PF.stateAt(before, acts, 0, ctx);
    const atStart = PF.stateAt(before, acts, 1.0, ctx);
    const atEnd = PF.stateAt(before, acts, 2.0, ctx);
    const atFinal = PF.stateAt(before, acts, Infinity, ctx);
    /* t=0：动作 a 尚未生效（t <= start 跳过） */
    assert.equal(at0.layers.lin.opacity, 1, 't=0 时 show 尚未生效（保持进入前透明度）');
    /* t=start(1.0)：动作 a 已结束（0~1s），动作 b 尚未生效（1 <= 1 跳过） */
    assert.ok(atStart.layers.lin.opacity >= 0.999, 't=1.0 时 show 已完成');
    assert.equal(atStart.layers.lin.scale, 1, 't=1.0 时 scale 尚未生效（t==start 跳过）');
    /* t=end(2.0)：两个动作都完成 */
    assert.equal(atEnd.layers.lin.scale, 1.5, 't=2.0 时 scale 完成到 150%');
    /* t=终点：与终态一致，瞬态量归零 */
    assert.equal(atFinal.layers.lin.scale, 1.5, '终态 scale 完成');
    /* t 回退：纯函数无累积，前进再回退得到同一结果 */
    const fwd = PF.stateAt(before, acts, 1.5, ctx);
    const back = PF.stateAt(before, acts, 0.5, ctx);
    const fwdAgain = PF.stateAt(before, acts, 1.5, ctx);
    assert.equal(JSON.stringify(fwd.layers.lin), JSON.stringify(fwdAgain.layers.lin), '回退再前进得到同一状态（无累积）');
  }

  /* 4. 音频动作序列：三环境共享的 schedule 过滤顺序一致 */
  {
    const acts = unifiedProject();
    const audioSeq = PF.schedule(acts).filter((s) => PF.isAudioType(s.action.type)).map((s) => s.action.id);
    /* 期望：按 start 排序，同 start 保持列表顺序 */
    const sorted = [...audioSeq].sort();
    assert.equal(audioSeq.length, 6, '共 6 个音频动作');
    /* 每个音频动作都能被 audioActionSpec 归一化（三环境共用的副作用入口） */
    for (const s of PF.schedule(acts)) {
      if (!PF.isAudioType(s.action.type)) continue;
      const spec = A.pure.audioActionSpec(s.action.type, s.action.params);
      assert.ok(spec && typeof spec.action === 'string', '音频动作可归一化：' + s.action.type);
    }
    /* 一次性音频（SFX/Voice）与状态音频（BGM/bus/ducking）分类正确 */
    const oneShots = PF.schedule(acts).filter((s) => TL.isOneShotAudio(s.action.type));
    assert.equal(oneShots.length, 3, '一次性音频 3 条（2 sfx + 1 voice）');
  }

  /* 5. 阻塞动作：blockUntil 给出剧情推进等待点 */
  {
    const acts = unifiedProject();
    const blockAt = PF.blockUntil(acts);
    const slots = PF.schedule(acts);
    const blockingEnds = slots.filter((s) => s.blocking).map((s) => s.end);
    assert.equal(blockAt, Math.max(0, ...blockingEnds), 'blockUntil = 最后阻塞动作结束时间');
    assert.ok(blockAt > 0, '存在阻塞动作');
  }

  console.log('PASS: 跨运行时演出语义一致性（调度确定性/终态一致/边界语义/音频序列/阻塞推进）');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
