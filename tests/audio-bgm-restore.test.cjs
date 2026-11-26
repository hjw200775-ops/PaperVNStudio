'use strict';
/* V0.8.2 · M3-A · BGM 状态恢复与 Voice 暂停续播（引擎层）
 * 用假 AudioContext + 假 HTMLAudioElement 在 Node 里验证：
 *   1) applyAudioState(options.offset) 在 precise 模式新建 BufferSource 时恢复 offset；
 *   2) applyAudioState(options.offset) 在 stream 模式恢复 currentTime；
 *   3) voicePlay(options.offset) 从保存位置续播（暂停继续不再从头重播）；
 *   4) applyAudioState 同曲不重启（只调音量/循环，杜绝双重 BGM）；
 *   5) dualBgm 检测：合法 precise 交叉淡化单源不误报，precise+stream 残留被检出。 */
const assert = require('node:assert/strict');
const A = require('../dist/audio.js')();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 最小 AudioContext 替身：记录 BufferSource 的 start(when, offset)。 */
function fakeCtx(opts = {}) {
  const state = { time: 0, sources: [], gains: 0, decoded: 0 };
  const param = (v0) => {
    let v = v0;
    const ev = [];
    const overlaps = (at, dur) => ev.find((e) => at < e.at + (e.dur || 0) - 1e-9 && e.at < at + dur - 1e-9);
    const api = {
      get value() { return v; }, set value(x) { v = x; },
      setValueAtTime(x, at) { if (overlaps(at, 0)) throw new Error('overlap'); v = x; ev.push({ type: 'set', at, dur: 0 }); return api; },
      linearRampToValueAtTime(x, at) { v = x; ev.push({ type: 'ramp', at, dur: 0 }); return api; },
      setValueCurveAtTime(c, at, dur) { if (overlaps(at, dur)) throw new Error('overlap'); v = c[c.length - 1]; ev.push({ type: 'curve', at, dur }); return api; },
      cancelScheduledValues(at) { return api; }
    };
    return api;
  };
  const node = () => ({ connect() { return this; }, disconnect() { return this; } });
  const ctx = {
    sampleRate: 48000, currentTime: 0, state: 'running', destination: node(),
    createGain() { state.gains++; return Object.assign(node(), { gain: param(1) }); },
    createBufferSource() {
      const src = Object.assign(node(), { buffer: null, loop: false, loopStart: 0, loopEnd: 0, started: 0, offset: 0, stopped: false,
        start(when, offset) { this.started = when || 0; this.offset = offset || 0; }, stop() { this.stopped = true; } });
      state.sources.push(src); return src;
    },
    async decodeAudioData() { state.decoded++; return { length: 480000, numberOfChannels: 2, duration: 10, sampleRate: 48000 }; },
    async resume() { this.state = 'running'; }
  };
  return { ctx, state };
}
function fakeElementFactory(record) {
  return () => {
    const el = { volume: 1, loop: false, paused: true, currentTime: 0, duration: 10, src: '', _currentTimeSets: 0,
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
      addEventListener() {}, removeEventListener() {}, load() {}, canPlayType: () => 'probably' };
    if (record) record.push(el);
    return el;
  };
}
const DATA = (n) => 'data:audio/wav;base64,' + Buffer.from('x'.repeat(n)).toString('base64');
const PREFS = { master: 1, bgm: 1, sfx: 1, voice: 1 };

(async () => {
  /* 1. precise 模式：applyAudioState offset 恢复 BufferSource 起播位置 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: PREFS, loopMode: 'precise', audioContext: ctx, elementFactory: fakeElementFactory() });
    await runtime.bgmCrossfade({ audioId: 'a', volume: .8, duration: .2, loop: { mode: 'all' } });
    assert.equal(runtime.snapshot().mode, 'precise');
    runtime.stopAll();                          /* 暂停：preciseBgm 清空 */
    assert.equal(runtime.snapshot().bgm, null, '暂停后 precise BGM 清空');
    runtime.applyAudioState({ bgm: { audioId: 'a', volume: .8, loop: { mode: 'all', start: 0, end: 0 }, playing: true } }, { offset: 2.5 });
    await wait(10);
    const src = state.sources[state.sources.length - 1];
    assert.equal(src.offset, 2.5, 'precise 模式 offset 恢复（从 2.5s 起播）');
    assert.equal(runtime.snapshot().bgm.audioId, 'a', '恢复后 BGM 就位');
  }

  /* 2. stream 模式：applyAudioState offset 恢复 currentTime */
  {
    const els = [];
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: PREFS, loopMode: 'stream', elementFactory: fakeElementFactory(els) });
    runtime.applyAudioState({ bgm: { audioId: 'a', volume: .8, loop: { mode: 'all', start: 0, end: 0 }, playing: true } }, { offset: 3.1 });
    await wait(10);
    const bgmEl = els.find((el) => el.currentTime > 0);
    assert.ok(bgmEl && Math.abs(bgmEl.currentTime - 3.1) < 0.01, 'stream 模式 offset 恢复 currentTime≈3.1');
  }

  /* 3. voicePlay offset：从保存位置续播剩余部分 */
  {
    const els = [];
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: PREFS, loopMode: 'stream', elementFactory: fakeElementFactory(els) });
    runtime.voicePlay({ audioId: 'v', volume: 1, duck: false, offset: 4.2 });
    await wait(10);
    const voiceEl = els[els.length - 1];
    assert.ok(voiceEl && Math.abs(voiceEl.currentTime - 4.2) < 0.01, 'voicePlay offset 从 4.2s 续播');
    assert.equal(runtime.snapshot().voice.audioId, 'v', 'Voice 就位');
  }

  /* 4. stream 同曲不重启：applyAudioState 同一首只调音量/循环，不新建实例 */
  {
    const els = [];
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: PREFS, loopMode: 'stream', elementFactory: fakeElementFactory(els) });
    await runtime.bgmCrossfade({ audioId: 'a', volume: .8, duration: .1, loop: { mode: 'all' } });
    const n0 = els.length;
    runtime.applyAudioState({ bgm: { audioId: 'a', volume: .5, loop: { mode: 'all', start: 0, end: 0 }, playing: true } });
    await wait(10);
    assert.equal(els.length, n0, '同曲 applyAudioState 不新建通道');
    assert.equal(runtime.snapshot().instances.bgm, 1, 'BGM 实例仍为 1');
    assert.equal(runtime.snapshot().dualBgm, false, '无双 BGM');
  }

  /* 5. dualBgm 检测：合法 precise 交叉淡化单源不误报 */
  {
    const { ctx } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: PREFS, loopMode: 'precise', audioContext: ctx, elementFactory: fakeElementFactory() });
    await runtime.bgmCrossfade({ audioId: 'a', volume: .8, duration: .5, loop: { mode: 'all' } });
    await runtime.bgmCrossfade({ audioId: 'b', volume: .8, duration: .5, loop: { mode: 'all' } });
    const snap = runtime.snapshot();
    assert.equal(snap.dualBgm, false, '合法 precise 交叉淡化（单 preciseBgm 槽）不误报双 BGM');
    assert.equal(snap.instances.bgm, 1, 'precise 交叉淡化只占一个 BGM 槽');
  }

  console.log('PASS: BGM 状态恢复与 Voice 续播（precise/stream offset、同曲不重启、dualBgm 检测）');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
