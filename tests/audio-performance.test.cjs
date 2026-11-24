'use strict';
/* V0.8.1 音频演出：混音、交叉淡化、循环区间、Ducking、音效与终态落地。
   全部用可注入的假播放对象，断言的是「实际音量曲线 / 实际播放实例 / 实际播放位置」，
   不是「有没有调用某个方法」。 */
const assert = require('node:assert/strict');
const A = require('../dist/audio.js')();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 假音频元素：time 由 50ms 定时器推进，duration 由注入表决定 */
function harness(opts = {}) {
  const state = { els: [], plays: [], durations: {}, ...opts };
  const factory = () => {
    const el = {
      _src: '', volume: 1, loop: false, paused: true, ended: false, currentTime: 0, duration: 0,
      error: null, onended: null, onerror: null, listeners: {}, _t: null,
      addEventListener(k, fn) { (this.listeners[k] || (this.listeners[k] = [])).push(fn); },
      canPlayType: () => 'probably',
      load() {},
      get src() { return this._src; },
      set src(v) { this._src = v; this.duration = state.durations[v] || 10; },
      play() {
        this.paused = false; this.ended = false;
        const self = this;
        clearInterval(this._t);
        this._t = setInterval(() => { if (!self.paused && !self.ended) self.currentTime += .1; }, 50);
        state.plays.push(this);
        return Promise.resolve();
      },
      pause() { this.paused = true; clearInterval(this._t); this._t = null; },
      stopTicking() { clearInterval(this._t); this._t = null; }
    };
    state.els.push(el);
    return el;
  };
  const data = { A: 'data:audio/wav;base64,AAAA', B: 'data:audio/wav;base64,BBBB', C: 'data:audio/wav;base64,CCCC', S: 'data:audio/wav;base64,SSSS', V: 'data:audio/wav;base64,VVVV' };
  const runtime = A.runtime({ elementFactory: factory, assetData: (id) => data[id] || '', prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 } });
  return { runtime, state, data };
}
const live = (runtime) => runtime.snapshot();

(async () => {
  /* ---------- 1. 纯函数：混音 / 曲线 / 归一化 ---------- */
  {
    const p = A.pure.normalizePrefs({ master: .5, bgm: .8, sfx: 1, voice: .5, muted: false });
    assert(Math.abs(A.pure.mixVolume(p, 'bgm', .5, 1, 1) - .2) < 1e-9, 'Master × 用户分类 × 播放音量');
    assert(Math.abs(A.pure.mixVolume(p, 'bgm', 1, .5, 1) - .2) < 1e-9, '剧情音量独立相乘');
    assert(Math.abs(A.pure.mixVolume(p, 'bgm', 1, 1, .35) - .14) < 1e-9, 'Ducking 作用在 BGM 上');
    assert.equal(A.pure.mixVolume(p, 'sfx', 1, 1, .1), .5, 'Ducking 不影响音效');
    assert.equal(A.pure.mixVolume({ ...p, muted: true }, 'bgm', 1, 1, 1), 0, '静音仍然归零');

    const lin = A.pure.crossfadeGains(.5, 'linear');
    assert.deepEqual([+lin.out.toFixed(3), +lin.in.toFixed(3)], [.5, .5], '线性交叉在中点各一半');
    const eq = A.pure.crossfadeGains(.5, 'equalPower');
    assert(Math.abs(eq.out ** 2 + eq.in ** 2 - 1) < 1e-9, '等功率曲线：功率守恒');
    assert(eq.in > .7 && eq.out > .7, '等功率在中点两侧都不塌：' + eq.in.toFixed(3) + '/' + eq.out.toFixed(3));
    for (const p2 of [0, .25, .5, .75, 1]) {
      const g = A.pure.crossfadeGains(p2, 'equalPower');
      assert(g.out <= 1.0000001 && g.in <= 1.0000001 && g.out >= 0 && g.in >= 0, '增益不越界');
    }

    assert.deepEqual(A.pure.loopSpec({ mode: 'off' }), { mode: 'off', start: 0, end: 0 });
    assert.deepEqual(A.pure.loopSpec({ mode: 'all' }), { mode: 'all', start: 0, end: 0 });
    assert.deepEqual(A.pure.loopSpec({ mode: 'region', start: 4, end: 30 }), { mode: 'region', start: 4, end: 30 });
    assert.deepEqual(A.pure.loopSpec({ mode: 'region', start: 20, end: 4 }), { mode: 'all', start: 0, end: 0 }, '越界区间退化为整曲');
    assert.deepEqual(A.pure.loopSpec({ loop: true }), { mode: 'all', start: 0, end: 0 }, '旧字段 loop 仍可用');

    const d = A.pure.duckSpec({ level: 2, attack: -1, release: 99 });
    assert.equal(d.level, 1); assert.equal(d.attack, 0); assert.equal(d.release, 10, 'Ducking 参数夹到合法范围');
    assert.equal(A.pure.duckSpec({}).level, .35, '默认压低到 35%');

    const spec = A.pure.audioActionSpec('audio.bgm.crossfade', { audioId: 'A', volume: 9, duration: 99, curve: 'bogus', loopMode: 'region', loopStart: 3, loopEnd: 12 });
    assert.equal(spec.volume, 1); assert.equal(spec.duration, 10); assert.equal(spec.curve, 'linear');
    assert.deepEqual(spec.loop, { mode: 'region', start: 3, end: 12 }, '未知曲线回退线性，区间被保留');
    assert.equal(A.pure.audioActionSpec('audio.nope', {}), null, '未知音频动作返回 null');
  }

  /* ---------- 2. 交叉淡化：两个实例、无断层、无尖峰 ---------- */
  {
    const { runtime, state } = harness();
    await runtime.enter({ bgm: { action: 'play', audioId: 'A', volume: 1, loop: true, fadeIn: 0, fadeOut: 0 } });
    await wait(120);
    const aEl = state.els[0];
    const beforeTime = aEl.currentTime;
    const p = runtime.bgmCrossfade({ audioId: 'B', volume: 1, duration: .2, curve: 'linear' });
    await wait(100);
    const mid = live(runtime);
    assert.equal(mid.instances.bgm, 1, '新曲已经是当前 BGM');
    assert.equal(mid.instances.retiring, 1, '旧曲仍在淡出（没有立刻消失）');
    const bEl = state.els[state.els.length - 1];
    assert.equal(bEl.paused, false, '新曲在交叉淡化开始时就已经在播，不是旧曲停下后才加载');
    assert(mid.bgm.volume > 0 && mid.bgm.volume < 1, '新曲音量在爬升：' + mid.bgm.volume.toFixed(3));
    assert(aEl.volume > 0 && aEl.volume < 1, '旧曲音量在下降：' + aEl.volume.toFixed(3));
    assert(aEl.currentTime > beforeTime, '旧曲是继续播放后淡出的，不是从头再来');
    await p;
    await wait(300);
    const done = live(runtime);
    assert.equal(done.instances.retiring, 0, '淡化结束后旧实例被销毁');
    assert.equal(aEl.paused, true, '旧实例已暂停');
    assert(Math.abs(done.bgm.volume - 1) < .02, '新曲到达满音量：' + done.bgm.volume);
    assert(done.events.some((e) => e.kind === 'crossfade'), '记下了一次交叉淡化事件');
    runtime.stopAll();
    console.log('  ok  交叉淡化：新旧并存、旧曲不回曲首、无断层、结束后只留一个实例');
  }

  /* ---------- 3. 等功率曲线：中点两侧都不塌 ---------- */
  {
    const { runtime } = harness();
    await runtime.enter({ bgm: { action: 'play', audioId: 'A', volume: 1, loop: true, fadeIn: 0, fadeOut: 0 } });
    await wait(80);
    runtime.bgmCrossfade({ audioId: 'C', volume: 1, duration: .6, curve: 'equalPower' });
    await wait(330);
    const s = live(runtime);
    assert(s.bgm.volume > .55, '等功率中点新曲已过半（>' + .55 + '）：' + s.bgm.volume.toFixed(3));
    runtime.stopAll();
    console.log('  ok  等功率交叉淡化：中点两侧同时可闻，功率不塌陷');
  }

  /* ---------- 4. 同一首重复请求：不新建实例、不回曲首 ---------- */
  {
    const { runtime, state } = harness();
    await runtime.enter({ bgm: { action: 'play', audioId: 'A', volume: 1, loop: true, fadeIn: 0, fadeOut: 0 } });
    await wait(200);
    const el = state.els[0];
    const t0 = el.currentTime;
    const r = await runtime.bgmCrossfade({ audioId: 'A', volume: .6, duration: .15, curve: 'linear' });
    assert.equal(r.same, true, '识别为同一首');
    await wait(120);
    const s = live(runtime);
    assert.equal(s.instances.bgm, 1, '没有第二个 BGM 实例');
    assert.equal(s.instances.retiring, 0, '没有把同一首淡出');
    assert(el.currentTime >= t0, '播放位置连续，没有回到曲首');
    assert(s.bgm.itemVolume < .95, '音量开始向 60% 过渡：' + s.bgm.itemVolume.toFixed(3));
    await wait(220);
    assert(Math.abs(live(runtime).bgm.itemVolume - .6) < .02, '过渡结束后是 60%：' + live(runtime).bgm.itemVolume.toFixed(3));
    runtime.stopAll();
    console.log('  ok  同一 BGM 重复请求：不叠实例、不回到曲首，只调音量');
  }

  /* ---------- 5. 连续交叉淡化 100 次：实例不泄漏、音量不漂移 ---------- */
  {
    const { runtime } = harness();
    await runtime.enter({ bgm: { action: 'play', audioId: 'A', volume: 1, loop: true, fadeIn: 0, fadeOut: 0 } });
    const ids = ['B', 'C', 'A'];
    for (let i = 0; i < 100; i++) {
      runtime.bgmCrossfade({ audioId: ids[i % 3], volume: 1, duration: 0, curve: 'linear' });
      await wait(4);
    }
    await wait(250);
    const s = live(runtime);
    assert.equal(s.instances.retiring, 0, '100 次切换后没有滞留实例：' + s.instances.retiring);
    assert.equal(s.instances.bgm, 1, '始终只有一个当前 BGM');
    assert(Math.abs(s.bgm.volume - 1) < .02, '音量没有漂移：' + s.bgm.volume);
    assert(Math.abs(s.bgm.itemVolume - 1) < .001, '播放音量没有累积衰减：' + s.bgm.itemVolume);
    assert.equal(s.buses.bgm, 1, '剧情音量没有被切换过程改写');
    assert.equal(s.prefs.bgm, 1, '用户偏好没有被剧情改动');
    runtime.stopAll();
    console.log('  ok  连续 100 次交叉淡化：实例不泄漏、音量不漂移、用户偏好不被改写');
  }

  /* ---------- 6. Ducking：压低与恢复，连续语音不反复跳动 ---------- */
  {
    const { runtime } = harness();
    runtime.setDucking({ level: .3, attack: .05, release: .1 });
    await runtime.enter({ bgm: { action: 'play', audioId: 'A', volume: 1, loop: true, fadeIn: 0, fadeOut: 0 } });
    await wait(80);
    const base = live(runtime).bgm.volume;
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: true });
    await wait(150);
    const ducked = live(runtime).bgm.volume;
    assert(ducked < base * .45, '配音期间 BGM 被压低：' + base.toFixed(3) + ' → ' + ducked.toFixed(3));
    assert(ducked > 0, '压低不是静音');
    /* 连续语音：第二句接上时不应把音量抬回去再压下来 */
    runtime.voicePlay({ audioId: 'V', volume: 1, duck: true });
    const samples = [];
    for (let i = 0; i < 6; i++) { await wait(30); samples.push(live(runtime).bgm.volume); }
    const spread = Math.max(...samples) - Math.min(...samples);
    assert(spread < .02, '连续语音期间音量稳定，不反复跳动：' + spread.toFixed(3));
    runtime.voiceStop();
    await wait(220);
    const restored = live(runtime).bgm.volume;
    assert(Math.abs(restored - base) < .02, '配音结束后恢复到原音量：' + restored.toFixed(3));
    assert.equal(live(runtime).ducking.active, false, 'Ducking 已释放');
    runtime.stopAll();
    console.log('  ok  Ducking：压低 → 连续语音稳定 → 结束恢复，无永久降低');
  }

  /* ---------- 7. 循环区间：到点回跳并记录接缝 ---------- */
  {
    const { runtime, state } = harness();
    await runtime.enter({ bgm: { action: 'play', audioId: 'A', volume: 1, loop: false, fadeIn: 0, fadeOut: 0 } });
    await wait(80);
    const el = state.els[0];
    el.currentTime = 2.0;
    runtime.bgmLoop({ mode: 'region', start: 1.0, end: 2.2 });
    await wait(1600);
    const s = live(runtime);
    assert.equal(s.bgm.loop.mode, 'region');
    assert(s.loop.jumps >= 2, '发生了循环回跳：' + s.loop.jumps);
    await wait(200);
    assert(el.currentTime >= .95 && el.currentTime <= 2.25, '回跳后仍在区间内：' + el.currentTime.toFixed(2));
    assert(s.loop.maxGapMs != null, '记录了接缝间隔（毫秒）');
    assert(s.loop.maxGapMs < 1200, '接缝间隔不会长到像卡住：' + s.loop.maxGapMs + 'ms');
    runtime.stopAll();
    console.log('  ok  循环区间：到 loopEnd 回跳到 loopStart，区间与接缝被记录');
  }

  /* ---------- 8. 音效并发 / 指定停止 / 防堆叠 ---------- */
  {
    const { runtime } = harness();
    const h1 = runtime.sfxPlay({ audioId: 'S', volume: 1, key: 'step' });
    const h2 = runtime.sfxPlay({ audioId: 'S', volume: 1, key: 'door' });
    assert(h1.ok && h2.ok);
    await wait(60);
    assert.equal(live(runtime).instances.sfx, 2, '两个音效可以同时播放');
    runtime.sfxPlay({ audioId: 'S', volume: 1, key: 'step' });
    await wait(60);
    assert.equal(live(runtime).instances.sfx, 2, '同 key 连续触发只有一条在响（不堆叠）');
    runtime.sfxStop('step');
    assert.equal(live(runtime).instances.sfx, 1, '指定音效被停止');
    for (let i = 0; i < 14; i++) runtime.sfxPlay({ audioId: 'S', volume: 1, key: 'k' + i });
    await wait(80);
    assert(live(runtime).instances.sfx <= 8, '并发音效不超过上限：' + live(runtime).instances.sfx);
    runtime.stopAll();
    assert.equal(live(runtime).instances.sfx, 0, 'stopAll 清空全部音效');
    console.log('  ok  音效：并发、同 key 防堆叠、指定停止、上限与清理');
  }

  /* ---------- 9. 终态落地：同一首不重启，换曲立即切，停止清空 ---------- */
  {
    const { runtime, state } = harness();
    await runtime.enter({ bgm: { action: 'play', audioId: 'A', volume: 1, loop: true, fadeIn: 0, fadeOut: 0 } });
    await wait(220);
    const aEl = state.els[0];
    const t0 = aEl.currentTime;
    runtime.applyAudioState({ bgm: { audioId: 'A', volume: .5, loop: { mode: 'region', start: 2, end: 6 } }, buses: { bgm: .8 } });
    assert.equal(live(runtime).instances.bgm, 1, '同一首仍然只有一个实例');
    assert(aEl.currentTime >= t0, '同一首没有被重启：' + aEl.currentTime.toFixed(2) + ' ≥ ' + t0.toFixed(2));
    assert(Math.abs(live(runtime).bgm.itemVolume - .5) < .001, '终态音量已应用');
    assert.equal(live(runtime).bgm.loop.mode, 'region', '终态循环设置已应用');
    assert.equal(live(runtime).buses.bgm, .8, '终态剧情音量已应用');
    runtime.applyAudioState({ bgm: { audioId: 'B', volume: 1, loop: { mode: 'all', start: 0, end: 0 } } });
    assert.equal(live(runtime).bgm.audioId, 'B', '换曲立即生效');
    assert.equal(live(runtime).instances.retiring, 0, '不是交叉淡化，不残留旧实例');
    runtime.applyAudioState({ bgm: null });
    assert.equal(live(runtime).bgm, null, '终态为停止时清空 BGM');
    assert.equal(live(runtime).instances.bgm, 0);
    runtime.stopAll();
    console.log('  ok  终态落地：同一首保位置、换曲立即切、停止清空');
  }

  console.log('PASS: 音频演出（混音组合/曲线/交叉淡化/循环区间/Ducking/音效/终态落地/100 次切换不泄漏）');
})();
