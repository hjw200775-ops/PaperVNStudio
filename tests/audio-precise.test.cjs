'use strict';
/* V0.8.1-RC 精确循环与缓存：用假 AudioContext 在 Node 里验证调度、预算、淘汰与竞态。
   断言的是「实际调用了什么、缓存里剩下什么、最终谁在播」，不是「方法存在」。 */
const assert = require('node:assert/strict');
const A = require('../dist/audio.js')();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 最小的 AudioContext 替身：够引擎用即可 */
function fakeCtx(opts = {}) {
  const state = { time: 0, sources: [], gains: 0, decoded: 0, closed: false, curves: [] };
  const param = (v) => ({
    value: v,
    setValueAtTime(x) { this.value = x; return this; },
    linearRampToValueAtTime(x) { this.value = x; return this; },
    setValueCurveAtTime(curve, at, dur) { this.value = curve[curve.length - 1]; state.curves.push({ curve: Array.from(curve).slice(0, 3), dur }); return this; },
    cancelScheduledValues() { return this; }
  });
  const node = () => ({ connect() { return this; }, disconnect() { return this; } });
  const ctx = {
    sampleRate: 48000, currentTime: 0, state: 'running',
    destination: node(),
    createGain() { state.gains++; return Object.assign(node(), { gain: param(1) }); },
    createBufferSource() {
      const src = Object.assign(node(), {
        buffer: null, loop: false, loopStart: 0, loopEnd: 0, started: 0, stopped: false,
        start(when, offset) { this.started = when || 0; this.offset = offset || 0; },
        stop() { this.stopped = true; }
      });
      state.sources.push(src);
      return src;
    },
    async decodeAudioData() {
      state.decoded++;
      if (opts.decodeDelay) await wait(opts.decodeDelay);
      if (opts.decodeFail) throw new Error('decode error');
      const seconds = opts.seconds || 10;
      return { length: Math.round(48000 * seconds), numberOfChannels: 2, duration: seconds, sampleRate: 48000 };
    },
    async resume() { this.state = 'running'; }
  };
  return { ctx, state };
}
function fakeElement() {
  const el = { volume: 1, loop: false, paused: true, currentTime: 0, duration: 10, src: '',
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    addEventListener() {}, removeEventListener() {}, load() {}, canPlayType: () => 'probably' };
  return el;
}
const DATA = (n) => 'data:audio/wav;base64,' + Buffer.from('x'.repeat(n)).toString('base64');

(async () => {
  /* 1. 精确模式：用 AudioBufferSourceNode，循环区间落到 source 上 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    const r = await runtime.bgmCrossfade({ audioId: 'a', volume: .8, duration: .5, curve: 'equalPower', loop: { mode: 'region', start: 2, end: 6 } });
    assert.equal(r.ok, true, '交叉淡化成功');
    assert.equal(r.mode, 'precise');
    assert.equal(state.sources.length, 1, '创建了一个 BufferSource');
    const src = state.sources[0];
    assert.equal(src.loop, true, '开启循环');
    assert.equal(src.loopStart, 2); assert.equal(src.loopEnd, 6);
    assert.equal(src.stopped, false);
    const snap = runtime.snapshot();
    assert.equal(snap.mode, 'precise');
    assert.equal(snap.bgm.audioId, 'a');
    assert.equal(snap.bgm.loop.mode, 'region');
    assert.equal(snap.cache.entries, 1, '解码结果被缓存');
  }

  /* 2. 同一首重复请求：不新建 BufferSource、不回到曲首 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    await runtime.bgmCrossfade({ audioId: 'a', volume: .8, duration: .2, loop: { mode: 'region', start: 1, end: 3 } });
    ctx.currentTime = 1.5;
    const before = state.sources.length;
    const r2 = await runtime.bgmCrossfade({ audioId: 'a', volume: .5, duration: .2, loop: { mode: 'region', start: 1, end: 3 } });
    assert.equal(r2.same, true, '识别为同一首');
    assert.equal(state.sources.length, before, '没有创建第二个播放实例');
    assert.equal(runtime.snapshot().bgm.itemVolume, .5, '音量按请求调整');
  }

  /* 3. 内存预算：超过预算的素材不进入精确模式，回退流式并给出原因 */
  {
    const { ctx } = fakeCtx({ seconds: 600 });   // 600s × 2ch × 4B = 192MB > 64MB
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'auto', audioContext: ctx, elementFactory: fakeElement, memoryBudgetBytes: 64 * 1024 * 1024 });
    const r = await runtime.bgmCrossfade({ audioId: 'huge', volume: .8, duration: .1, loop: { mode: 'region', start: 1, end: 3 } });
    assert.equal(r.ok, true, '回退后仍然能播');
    assert.equal(r.fallback, 'budget', '原因记为预算不足：' + r.fallback);
    assert.equal(runtime.snapshot().mode, 'stream', '当前走流式');
    assert.equal(runtime.snapshot().cache.entries, 0, '超预算的素材没有进缓存');
  }

  /* 4. 缓存淘汰：预算内只保留最近使用的若干条，正在播的不被淘汰 */
  {
    const { ctx } = fakeCtx({ seconds: 30 });    // 30s × 2ch × 4B = 11.5MB
    const runtime = A.runtime({ assetData: (id) => DATA(64 + id.length), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement, memoryBudgetBytes: 24 * 1024 * 1024 });
    await runtime.bgmCrossfade({ audioId: 'a', volume: 1, duration: .1, loop: { mode: 'all', start: 0, end: 0 } });
    await runtime.bgmCrossfade({ audioId: 'b', volume: 1, duration: .1, loop: { mode: 'all', start: 0, end: 0 } });
    let snap = runtime.snapshot();
    assert.equal(snap.cache.entries, 2, '两条都在预算内');
    await runtime.bgmCrossfade({ audioId: 'c', volume: 1, duration: .1, loop: { mode: 'all', start: 0, end: 0 } });
    snap = runtime.snapshot();
    assert(snap.cache.entries <= 2, '超出预算后发生淘汰：' + snap.cache.entries);
    assert.equal(snap.cache.ids.includes('c'), true, '新素材在缓存里');
    assert.equal(snap.cache.bytes <= snap.cache.budget, true, '缓存占用不超过预算');
  }

  /* 5. 竞态：慢的旧请求不能覆盖新请求 */
  {
    const { ctx, state } = fakeCtx({ decodeDelay: 120 });
    const runtime = A.runtime({ assetData: (id) => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    const p1 = runtime.bgmCrossfade({ audioId: 'slow', volume: 1, duration: .1, loop: { mode: 'all', start: 0, end: 0 } });
    await wait(10);
    const p2 = runtime.bgmCrossfade({ audioId: 'fast', volume: 1, duration: .1, loop: { mode: 'all', start: 0, end: 0 } });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, false, '旧请求被标记为过期');
    assert.equal(r1.reason, 'stale');
    assert.equal(r2.ok, true, '新请求成功');
    const snap = runtime.snapshot();
    assert.equal(snap.bgm.audioId, 'fast', '最终播的是新请求：' + snap.bgm.audioId);
    assert.equal(state.sources.length, 1, '没有留下两个并发实例');
  }

  /* 6. 解码失败：回退流式，不静音、不抛错 */
  {
    const { ctx } = fakeCtx({ decodeFail: true });
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    const r = await runtime.bgmCrossfade({ audioId: 'bad', volume: .8, duration: .1, loop: { mode: 'all', start: 0, end: 0 } });
    assert.equal(r.ok, true, '解码失败仍然回退成功');
    assert.match(String(r.fallback), /decode/);
    assert.equal(runtime.snapshot().mode, 'stream');
    assert.equal(runtime.snapshot().bgm.audioId, 'bad', '回退后确实在播');
  }

  /* 7. 停止与终态：精确源被停掉，快照清空 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    await runtime.bgmCrossfade({ audioId: 'a', volume: 1, duration: .1, loop: { mode: 'region', start: 1, end: 2 } });
    runtime.applyAudioState({ bgm: null });
    await wait(60);
    assert.equal(runtime.snapshot().bgm, null, '终态为停止时 BGM 清空');
    assert.equal(state.sources[0].stopped || state.sources[0].stopPending, true, '精确源已停止');
  }

  console.log('PASS: 精确循环（BufferSource/区间/同曲短路）、预算回退、缓存淘汰、异步竞态、解码失败回退、终止清理');
})();
