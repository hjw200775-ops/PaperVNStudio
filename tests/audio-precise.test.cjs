'use strict';
/* V0.8.1-RC 精确循环与缓存：用假 AudioContext 在 Node 里验证调度、预算、淘汰与竞态。
   断言的是「实际调用了什么、缓存里剩下什么、最终谁在播」，不是「方法存在」。 */
const assert = require('node:assert/strict');
const A = require('../dist/audio.js')();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 最小的 AudioContext 替身：够引擎用即可 */
function fakeCtx(opts = {}) {
  const state = { time: 0, sources: [], gains: 0, decoded: 0, closed: false, curves: [] };
  /* 参数替身带 Web Audio 的「重叠排程」语义：真实浏览器在曲线还没走完时再排
     setValueAtTime / 另一条曲线会抛 NotSupportedError。15 分钟浸泡就是在这里炸的，
     所以替身必须复现，否则测试会把真 bug 放过去。 */
  const param = (v0) => {
    let v = v0;
    const ev = [];
    const overlaps = (at, dur) => ev.find((e) => at < e.at + (e.dur || 0) - 1e-9 && e.at < at + dur - 1e-9);
    const api = {
      get value() { return v; },
      set value(x) { v = x; },
      setValueAtTime(x, at) {
        if (overlaps(at, 0)) throw new Error('NotSupportedError: setValueAtTime overlaps setValueCurveAtTime');
        v = x; ev.push({ type: 'set', at, dur: 0 }); return api;
      },
      linearRampToValueAtTime(x, at) { v = x; ev.push({ type: 'ramp', at, dur: 0 }); return api; },
      setValueCurveAtTime(curve, at, dur) {
        if (overlaps(at, dur)) throw new Error('NotSupportedError: setValueCurveAtTime overlaps');
        v = curve[curve.length - 1]; ev.push({ type: 'curve', at, dur });
        state.curves.push({ curve: Array.from(curve).slice(0, 3), dur }); return api;
      },
      cancelScheduledValues(at) { for (let i = ev.length - 1; i >= 0; i--) if (ev[i].at >= at) ev.splice(i, 1); return api; }
    };
    return api;
  };
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

  /* 8. 标题音乐：与剧情 BGM 共用音乐槽，精确循环 + 区间 + 起始偏移 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    const r = await runtime.titlePlay({ audioId: 'title', volume: .8, fadeIn: .5,
      loop: { mode: 'region', start: 6, end: 14 } });
    assert.equal(r.ok, true, '标题音乐进入精确模式');
    assert.equal(r.mode, 'precise');
    const src = state.sources[0];
    assert.equal(src.loop, true, '标题曲开启循环');
    assert.equal(src.loopStart, 6); assert.equal(src.loopEnd, 14);
    const snap = runtime.snapshot();
    assert.equal(snap.music.owner, 'title', '音乐槽归标题所有');
    assert.equal(snap.title.playing, true);
    assert.equal(snap.title.mode, 'precise');
    assert.equal(snap.title.loop.mode, 'region');
    assert.equal(snap.instances.title, 1);
    assert.equal(snap.instances.bgm, 1, '标题曲也占同一个音乐槽，不会另开一条');
  }

  /* 9. 暂停 → 偏移 → 恢复：从暂停点继续，不回到曲首 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    await runtime.titlePlay({ audioId: 'title', volume: 1, fadeIn: 0, loop: { mode: 'region', start: 6, end: 14 } });
    ctx.currentTime = 3.5;                       // 播放了 3.5 秒（区间起点 6 之前）
    const paused = runtime.titlePause(.05);
    assert.equal(paused.ok, true);
    assert(Math.abs(paused.offset - 3.5) < .01, '暂停点被记录：' + paused.offset);
    assert.equal(runtime.snapshot().title.playing, false, '暂停后没有在播的标题曲');
    ctx.currentTime = 10;
    const resumed = await runtime.titleResume(.2);
    assert.equal(resumed.ok, true, '可以恢复');
    const src2 = state.sources[state.sources.length - 1];
    assert(Math.abs(src2.offset - 3.5) < .01, '新源从暂停点开始：' + src2.offset);
  }

  /* 10. 剧情 BGM 接管标题曲：同一槽位，不重叠、不残留两个在播实例 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    await runtime.titlePlay({ audioId: 'title', volume: 1, fadeIn: 0, loop: { mode: 'all', start: 0, end: 0 } });
    ctx.currentTime = 2;
    const r = await runtime.bgmCrossfade({ audioId: 'scene', volume: .9, duration: .2, loop: { mode: 'region', start: 1, end: 5 } });
    assert.equal(r.ok, true, '剧情曲成功接管');
    const snap = runtime.snapshot();
    assert.equal(snap.music.owner, 'story', '音乐槽转给剧情');
    assert.equal(snap.bgm.audioId, 'scene');
    assert.equal(snap.title.playing, false, '标题曲不再在播');
    assert.equal(state.sources.length, 2, '一次交叉淡化两条源，没有第三条');
    await wait(320);
    assert.equal(state.sources[0].stopped, true, '旧标题源已停止');
    assert.equal(runtime.snapshot().instances.bgm, 1, '仍然只有一个音乐实例');
  }

  /* 11. 玩家音量不被标题曲改写；标题曲音量是剧情侧参数 */
  {
    const { ctx } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: .5, bgm: .5, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    await runtime.titlePlay({ audioId: 'title', volume: .8, fadeIn: 0, loop: { mode: 'all', start: 0, end: 0 } });
    const snap = runtime.snapshot();
    assert.equal(snap.prefs.bgm, .5, '用户 BGM 音量没有被标题曲覆盖');
    assert.equal(snap.prefs.master, .5);
    assert(Math.abs(snap.title.volume - .2) < .01, '实际输出 = .5 × .5 × .8：' + snap.title.volume);
    runtime.setPrefs({ muted: true });
    assert.equal(runtime.snapshot().title.volume, 0, '静音立即作用于标题曲');
    assert.equal(runtime.snapshot().title.playing, true, '静音不打断播放');
  }

  /* 12. 回退流式：标题曲明确报告 mode=stream 与原因，玩家音量仍生效 */
  {
    const { ctx } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: .5, sfx: 1, voice: 1 },
      loopMode: 'stream', audioContext: ctx, elementFactory: fakeElement });
    const r = await runtime.titlePlay({ audioId: 'title', volume: 1, fadeIn: 0, loop: { mode: 'region', start: 1, end: 3 } });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'stream', '显式 stream 偏好走流式');
    assert.equal(r.reason, 'stream-pref', '原因如实上报：' + r.reason);
    const snap = runtime.snapshot();
    assert.equal(snap.title.mode, 'stream');
    assert(Math.abs(snap.title.itemVolume - 1) < .01);
    assert(Math.abs(snap.title.volume - .5) < .05, '流式通道同样按用户音量输出：' + snap.title.volume);
    const stopped = runtime.titleStop(.05);
    assert.equal(stopped.ok, true);
  }

  /* 13. 交叉淡化还没走完就再次切换：不得抛 NotSupportedError，最终播的是最后一次请求 */
  {
    const { ctx, state } = fakeCtx();
    const runtime = A.runtime({ assetData: () => DATA(64), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
      loopMode: 'precise', audioContext: ctx, elementFactory: fakeElement });
    await runtime.bgmCrossfade({ audioId: 'a', volume: 1, duration: 2.5, curve: 'equalPower', loop: { mode: 'all', start: 0, end: 0 } });
    ctx.currentTime = 0.6;                     // 第一段淡化还在进行
    const r2 = await runtime.bgmCrossfade({ audioId: 'b', volume: .8, duration: 2.5, curve: 'linear', loop: { mode: 'all', start: 0, end: 0 } });
    assert.equal(r2.ok, true, '中途切歌不应失败：' + JSON.stringify(r2));
    ctx.currentTime = 1.2;                     // 第二段也没走完
    let threw = null;
    try {
      await runtime.bgmCrossfade({ audioId: 'c', volume: .9, duration: 2, curve: 'equalPower', loop: { mode: 'all', start: 0, end: 0 } });
    } catch (e) { threw = e; }
    assert.equal(threw, null, '连续切歌不得抛异常：' + (threw && threw.message));
    assert.equal(runtime.snapshot().bgm.audioId, 'c', '最终播的是最后一次请求');
    assert.equal(runtime.snapshot().instances.bgm, 1);
    /* 旧的两条源都要在各自淡化结束后停止 */
    await wait(2600);
    assert.equal(state.sources.slice(0, 2).every((s) => s.stopped), true, '前一/前二条源都已停止');
  }

  console.log('PASS: 精确循环（BufferSource/区间/同曲短路）、预算回退、缓存淘汰、异步竞态、解码失败回退、终止清理、标题音乐槽/暂停恢复/接管/音量隔离、连续切歌不抛错');
})();
