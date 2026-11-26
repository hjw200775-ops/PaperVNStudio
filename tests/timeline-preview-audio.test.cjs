'use strict';
/* V0.8.2 · M2-B · 预览音频驱动与一次性音频区间扫描测试
 * 覆盖：audioSideEffectsBetween 的半开/闭区间语义、去重与确定性排序；以及预览音频驱动
 * 的任意时间开始状态恢复、正常播放区间触发、一次性音频历史防重放、暂停/继续 offset 恢复、
 * 区间循环复位、seek 不重放历史副作用。驱动逻辑用 mock runtime 做确定性断言。 */
const assert = require('node:assert/strict');
const createPreviewAudioDriver = require('../dist/timeline-preview-audio.js');
const PF = require('../dist/performance.js')();
const TL = require('../dist/timeline.js')(PF);

const before = PF.emptyState();
const P = { characters: [], assets: [], audioAssets: [] };

/* 构造带显式 start 的音频动作（0s bgm、2/4s sfx、6s voice、8s crossfade） */
function acts() {
  const list = [
    PF.make('bgm1', 'audio.bgm.play', '', { params: { audioId: 'bgm_a', volume: 80, fadeIn: 2, loopMode: 'all' }, duration: 2 }),
    PF.make('sfx2', 'audio.sfx.play', '', { params: { audioId: 'sfx_a', volume: 100, key: 'k2' } }),
    PF.make('sfx4', 'audio.sfx.play', '', { params: { audioId: 'sfx_b', volume: 100, key: 'k4' } }),
    PF.make('voi6', 'audio.voice.play', '', { params: { audioId: 'v1', volume: 100 } }),
    PF.make('bgm8', 'audio.bgm.crossfade', '', { params: { audioId: 'bgm_b', volume: 85, duration: 2, curve: 'equalPower', loopMode: 'all' }, duration: 2 })
  ];
  list[0].start = 0;
  list[1].start = 2;
  list[2].start = 4;
  list[3].start = 6;
  list[4].start = 8;
  return list;
}

function mockRuntime(bgmTime) {
  const calls = [];
  let time = bgmTime == null ? null : bgmTime;
  let voice = null;
  const rt = {
    applyAudioState(state, options) { calls.push({ type: 'applyAudioState', state, options: options || null }); },
    stopAll() { calls.push({ type: 'stopAll' }); },
    voicePlay(spec) { calls.push({ type: 'voicePlay', spec }); },
    snapshot() { return { bgm: time == null ? null : { time }, voice }; },
    setBgmTime(t) { time = t; },
    setVoice(v) { voice = v; }
  };
  return { rt, calls };
}

function driver(fired, m, actsList, opts) {
  return createPreviewAudioDriver(Object.assign({
    PF, TL, P,
    getActions: () => actsList,
    getLayers: () => [],
    getBefore: () => PF.emptyState(),
    perfAudioAction: (a) => fired.push(a.type),
    runtime: () => m.rt
  }, opts || {}));
}

(async () => {
  /* 1. audioSideEffectsBetween：半开区间、闭区间、排序、历史不重放 */
  {
    const list = acts();
    const half = TL.audioSideEffectsBetween(list, 3, 5, false);   /* (3,5] */
    assert.deepEqual(half.map((s) => s.action.id), ['sfx4'], '半开 (3,5] 只命中 4s 的 sfx，不含 6s voice 与 2s sfx');

    const closed = TL.audioSideEffectsBetween(list, 2, 4, true);   /* [2,4] */
    assert.deepEqual(closed.map((s) => s.action.id), ['sfx2', 'sfx4'], '闭区间 [2,4] 含 2s 与 4s');

    const beforeStart = TL.audioSideEffectsBetween(list, 0, 1.5, false);
    assert.equal(beforeStart.length, 0, '一次性音频区间内无事件返回空');

    const emptyRange = TL.audioSideEffectsBetween(list, 10, 12, false);
    assert.equal(emptyRange.length, 0, '越界区间返回空');

    assert.equal(TL.audioSideEffectsBetween(list, NaN, 5, false).length, 0, '非法 from 返回空');

    /* 确定性排序：乱序 start 仍按 start 升序稳定输出 */
    const reordered = [acts()[4], acts()[2], acts()[1], acts()[3], acts()[0]];
    const sorted = TL.audioSideEffectsBetween(reordered, 0, 9, true);
    const starts = sorted.map((s) => s.start);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] >= starts[i - 1], '按 start 升序');
  }

  /* 2. 从任意时间开始：落地历史状态、不重放历史一次性音频 */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 5 });
    const apply = m.calls.filter((c) => c.type === 'applyAudioState');
    assert.equal(apply.length, 1, 'start 时一次性落地状态音频');
    assert.equal(apply[0].state.bgm.audioId, 'bgm_a', '从 5s 开始恢复 0s 启动的 BGM');
    d.onTick(5);                              /* 立即 tick：不前进 */
    assert.equal(fired.length, 0, '定位点不触发一次性事件');
    d.onTick(6);                              /* [5,6]：命中 6s voice */
    assert.deepEqual(fired, ['audio.voice.play'], '6s voice 触发，4s 历史 sfx 不重放');
    d.onTick(9);                              /* (6,9]：命中 8s crossfade */
    assert.deepEqual(fired, ['audio.voice.play', 'audio.bgm.crossfade'], '8s 交叉淡化触发');
  }

  /* 3. 从头开始：闭区间命中 0s 事件，正常推进半开不重复 */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 0 });
    d.onTick(0);
    d.onTick(1);                              /* [0,1]：命中 0s bgm */
    assert.deepEqual(fired, ['audio.bgm.play'], '0s bgm 在首个推进区间触发');
    d.onTick(2);                              /* (1,2]：命中 2s sfx */
    assert.deepEqual(fired, ['audio.bgm.play', 'audio.sfx.play'], '2s sfx 触发一次');
    d.onTick(2.5);                            /* (2,2.5]：无 */
    d.onTick(2.6);                            /* (2.5,2.6]：无，不重复触发 2s */
    assert.equal(fired.filter((t) => t === 'audio.sfx.play').length, 1, '2s sfx 只触发一次');
  }

  /* 4. 暂停：停全部并记录 BGM 位置；继续：按 offset 恢复 */
  {
    const fired = [], m = mockRuntime(3.25);
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 0 });
    d.onEvent('previewPause', { t: 3 });
    assert.ok(m.calls.some((c) => c.type === 'stopAll'), '暂停调用 stopAll');
    d.onEvent('previewResume', { t: 3 });
    const apply = m.calls.filter((c) => c.type === 'applyAudioState');
    const last = apply[apply.length - 1];
    assert.ok(last.options && Math.abs(last.options.offset - 3.25) < 0.001, '继续时按暂停位置 offset 恢复 BGM');
  }

  /* 5. 区间循环回绕：重建起点状态，区间内事件下一轮重新触发 */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 2 });
    d.onTick(2);
    d.onTick(2.2);                            /* [2,2.2]：命中 2s sfx（短步进不触发过期跳过） */
    assert.deepEqual(fired, ['audio.sfx.play'], '第一轮触发 2s sfx');
    d.onEvent('previewLoop', { t: 2 });       /* 回绕到区间起点 */
    assert.ok(m.calls.some((c) => c.type === 'applyAudioState'), '回绕时重建起点状态');
    d.onTick(2);
    d.onTick(2.2);                            /* [2,2.2]：再次命中 2s sfx */
    assert.equal(fired.filter((t) => t === 'audio.sfx.play').length, 2, '回绕后区间内 sfx 重新触发');
  }

  /* 6. seek：只落状态音频，不触发任何一次性事件 */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 0 });
    d.onEvent('previewSeek', { t: 7 });
    assert.equal(fired.length, 0, 'seek 不重放历史一次性音频');
    d.onTick(8);                              /* (7,8]：无 */
    d.onTick(9);                              /* (8,9]：命中 8s crossfade */
    assert.deepEqual(fired, ['audio.bgm.crossfade'], 'seek 后正常推进触发后续状态事件');
  }

  /* 7. 停止：清理并复位；dispose 幂等 */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 0 });
    d.onTick(3);
    d.onEvent('previewStop', { t: 0 });
    assert.ok(m.calls.some((c) => c.type === 'stopAll'), '停止调用 stopAll');
    const dbg = d.debug();
    assert.equal(dbg.active, false);
    assert.equal(dbg.lastT, 0);
    d.dispose();
    assert.equal(d.debug().active, false, 'dispose 后仍非 active');
  }

  /* 8. 自动结束：补扫最后一段后停止 */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 0 });
    d.onTick(2);                              /* [0,2]：0s bgm + 2s sfx */
    d.onTick(4);                              /* (2,4]：4s sfx */
    d.onTick(6);                              /* (4,6]：6s voice */
    d.onEvent('previewEnd', { t: 8.5 });      /* 结束时补扫 (6, 8.5] */
    assert.ok(fired.includes('audio.voice.play'), '结束补扫命中 6s voice');
    assert.ok(fired.includes('audio.bgm.crossfade'), '结束补扫命中 8s crossfade');
    assert.equal(d.debug().active, false);
  }

  /* 9. Voice 暂停恢复：暂停保存位置，继续续播剩余部分（不再从头重播） */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    m.rt.setVoice({ audioId: 'v1', time: 2.5, duration: 8, paused: false });
    d.onEvent('previewStart', { t: 0 });
    d.onEvent('previewPause', { t: 6 });
    d.onEvent('previewResume', { t: 6 });
    const vp = m.calls.filter((c) => c.type === 'voicePlay');
    assert.equal(vp.length, 1, '暂停后继续恢复正在播的 Voice');
    assert.equal(vp[0].spec.audioId, 'v1', '恢复同一条 Voice');
    assert.ok(Math.abs(vp[0].spec.offset - 2.5) < 0.001, 'Voice 从暂停位置续播剩余部分');
  }

  /* 10. 严重过期的一次性音频跳过补发，持久状态命令仍恢复 */
  {
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts());
    d.onEvent('previewStart', { t: 0 });
    d.onTick(3.0);                            /* 掉帧跨到 3s：2s sfx 已过期 >500ms */
    assert.ok(!fired.includes('audio.sfx.play'), '严重过期的一次性 SFX 不补发');
    assert.ok(fired.includes('audio.bgm.play'), '持久状态 BGM 仍触发');
    assert.ok(d.debug().skippedStale >= 1, '跳过被记录（不静默）');
  }

  /* 11. 音画同步采样：计划时间 vs 实际派发时间偏差统计 */
  {
    let wall = 0;
    const fired = [], m = mockRuntime();
    const d = driver(fired, m, acts(), { now: () => wall });
    d.onEvent('previewStart', { t: 0 });      /* startWall=0, startT=0 */
    wall = 16; d.onTick(0.016);               /* 0s bgm：drift=16ms */
    wall = 2016; d.onTick(2.016);             /* 2s sfx：expected=2000，drift=16ms */
    wall = 4016; d.onTick(4.016);             /* 4s sfx：drift=16ms */
    const st = d.syncStats();
    assert.equal(st.count, 3, '采集 3 个同步样本');
    assert.ok(Math.abs(st.meanMs - 16) < 1, '平均偏差约 16ms（受控时钟）');
    assert.ok(st.p95Ms <= 20, 'P95 偏差在预期内');
  }

  console.log('PASS: 预览音频驱动（任意时间开始/区间触发/历史不重放/暂停offset恢复/Voice暂停续播/严重过期跳过/同步采样统计/循环复位/seek/停止/结束补扫）与 audioSideEffectsBetween 区间语义');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
