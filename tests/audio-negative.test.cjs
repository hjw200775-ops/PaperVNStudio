'use strict';
/* V0.8.1-RC3.1 / M2.1 负向验证：严格验收必须能发现真实播放失败。
 *
 * 人为构造受控失败，确认「失败会被记录、严格断言会 FAIL」；再用正常数据确认「同一断言真实通过」。
 * 失败类型：缺失素材、损坏素材（解码失败）、媒体播放拒绝（NotSupportedError）；
 * 合法取消（AbortError 打断）不算失败，不得误报。 */
const assert = require('node:assert/strict');
const A = require('../dist/audio.js')();

function harness() {
  const state = { els: [] };
  const factory = () => {
    const el = {
      _src: '', volume: 1, loop: false, paused: true, ended: false, currentTime: 0, duration: 10,
      error: null, onended: null, onerror: null, _playResolve: null, _playReject: null,
      addEventListener() {}, canPlayType: () => 'probably', load() {},
      get src() { return this._src; }, set src(v) { this._src = v; },
      play() { this.paused = false; return new Promise((res, rej) => { this._playResolve = res; this._playReject = rej; }); },
      pause() { this.paused = true; if (this._playReject) { const r = this._playReject; this._playReject = null; r(Object.assign(new Error('interrupted'), { name: 'AbortError' })); } }
    };
    state.els.push(el); return el;
  };
  const data = { GOOD: 'data:audio/wav;base64,GOOD' };
  const runtime = A.runtime({ elementFactory: factory, assetData: (id) => data[id] || '', prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 } });
  return { runtime, state, data };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* 严格断言：验收脚本据此判定 FAIL（真正失败必须被发现） */
function strictAccepts(runtime) {
  const s = runtime.playbackStats();
  return { failed: s.failed, decodeFailed: s.decodeFailed, errors: runtime.status().errors.length, ok: s.failed === 0 && s.decodeFailed === 0 && runtime.status().errors.length === 0 };
}

(async () => {
  /* 1. 缺失素材 → 必须 FAIL */
  {
    const { runtime } = harness();
    runtime.voicePlay({ audioId: 'MISSING', volume: 1, duck: false });
    await wait(10);
    const r = strictAccepts(runtime);
    assert.equal(r.ok, false, '缺失素材必须被发现（errors 或 failed）');
    assert(runtime.status().errors.some(e => e.code === 'missing'), '缺失素材记录 missing 错误');
  }
  /* 2. 媒体播放拒绝 NotSupportedError → 必须 FAIL（解码失败类） */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'GOOD', volume: 1, duck: false });
    state.els[0]._playReject(Object.assign(new Error('Format not supported'), { name: 'NotSupportedError' }));
    await wait(10);
    const r = strictAccepts(runtime);
    assert.equal(r.ok, false, '播放拒绝必须被发现');
    assert(runtime.status().errors.some(e => e.code === 'decode'), '播放拒绝记 decode 错误');
  }
  /* 3. 播放中途解码失败（onerror）→ 必须 FAIL */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'GOOD', volume: 1, duck: false });
    state.els[0]._playResolve();
    await wait(10);
    state.els[0].error = { message: 'MEDIA_ELEMENT_ERROR: decode' };
    state.els[0].onerror();
    await wait(10);
    const s = runtime.playbackStats();
    assert.equal(s.decodeFailed, 1, '播放中途解码失败记 decodeFailed');
  }
  /* 4. 合法取消（AbortError 打断）→ 不得误报 FAIL */
  {
    const { runtime } = harness();
    runtime.voicePlay({ audioId: 'GOOD', volume: 1, duck: false });
    runtime.voiceStop();
    await wait(10);
    const r = strictAccepts(runtime);
    assert.equal(r.ok, true, '合法取消不得误报为失败');
    assert.equal(r.failed, 0, '合法取消 failed=0');
  }
  /* 5. 正常起播 → 必须通过 */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'GOOD', volume: 1, duck: false });
    state.els[0]._playResolve();
    await wait(10);
    const r = strictAccepts(runtime);
    assert.equal(r.ok, true, '正常起播必须通过');
  }
  console.log('PASS: 负向验证——真正失败必然被发现（FAIL），合法取消/正常起播不误报（PASS）');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
