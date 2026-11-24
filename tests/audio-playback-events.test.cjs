'use strict';
/* V0.8.1-RC3.1 / M1+M2：播放事件分类与「合法取消 ≠ 播放失败」。
 * 复现上一轮浸泡测试的假阳性根因：一句话的 voice 还没起播就被切句打断，
 * 浏览器 play() 以 AbortError 拒绝，旧实现把它误判成「播放失败」并永久挂横幅。
 * 断言：打断记 cancelled、不记错误；真正失败记 failed + 错误；起播/完成分别计数。 */
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
      play() {
        this.paused = false; this.ended = false;
        return new Promise((res, rej) => { this._playResolve = res; this._playReject = rej; });
      },
      /* 模拟浏览器：pause() 会打断未完成的 play()，令其以 AbortError 拒绝。 */
      pause() {
        this.paused = true;
        if (this._playReject) {
          const r = this._playReject; this._playReject = null;
          r(Object.assign(new Error('The play() request was interrupted by a call to pause()'), { name: 'AbortError' }));
        }
      }
    };
    state.els.push(el); return el;
  };
  const runtime = A.runtime({ elementFactory: factory, assetData: (id) => (id === 'V' ? 'data:audio/wav;base64,VVVV' : ''), prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 } });
  return { runtime, state };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* 1. 正常起播 → started，无错误 */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: false });
    state.els[0]._playResolve();
    await wait(10);
    const s = runtime.playbackStats();
    assert.equal(s.started, 1, '正常起播 started=1');
    assert.equal(s.failed, 0, '正常起播 failed=0');
    assert.equal(runtime.status().errors.length, 0, '正常起播无错误');
  }

  /* 2. 合法取消：play() 被 pause 打断（AbortError）→ cancelled，不记错误（关键回归） */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: false });
    assert.equal(state.els[0]._playReject !== null, true, 'play() 已发出且未决');
    runtime.voiceStop();  // → hardStop → pause() → AbortError
    await wait(10);
    const s = runtime.playbackStats();
    assert.equal(s.cancelled, 1, '打断记 cancelled=1');
    assert.equal(s.failed, 0, '打断 failed=0');
    assert.equal(runtime.status().errors.length, 0, '打断不记错误（之前会记「播放失败」并永久悬挂）');
  }

  /* 3. 真正失败：NotSupportedError → failed + 错误 */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: false });
    state.els[0]._playReject(Object.assign(new Error('Format not supported'), { name: 'NotSupportedError' }));
    await wait(10);
    const s = runtime.playbackStats();
    assert.equal(s.failed, 1, '真失败 failed=1');
    assert.equal(runtime.status().errors.length, 1, '真失败记 1 条错误');
    assert.match(runtime.status().errors[0].title, /播放失败|无法解码/, '错误标题可读');
  }

  /* 4. 正常完成：onended → completed */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: false });
    state.els[0]._playResolve();
    await wait(10);
    state.els[0].onended();
    await wait(5);
    const s = runtime.playbackStats();
    assert.equal(s.completed, 1, '自然完成 completed=1');
  }

  /* 5. 错误残留：一句失败后进入下一句，错误应被清掉（Bug A 实机对应的逻辑） */
  {
    const { runtime, state } = harness();
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: false });
    state.els[0]._playReject(Object.assign(new Error('Format not supported'), { name: 'NotSupportedError' }));
    await wait(10);
    assert.equal(runtime.status().errors.length, 1, '失败句记录 1 条错误');
    // 进入下一句（无音频），错误应清除
    await runtime.enter({});
    assert.equal(runtime.status().errors.length, 0, '进入下一句后错误被清除，不残留过期横幅');
    // 再制造一次新错误，仍能显示
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: false });
    state.els[state.els.length - 1]._playReject(Object.assign(new Error('Format not supported'), { name: 'NotSupportedError' }));
    await wait(10);
    assert.equal(runtime.status().errors.length, 1, '新的真实错误仍能显示');
  }

  console.log('PASS: 播放事件分类（requested/started/completed/cancelled/failed），合法取消不再污染状态栏');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
