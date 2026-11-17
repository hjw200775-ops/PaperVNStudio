'use strict';
/* V0.5 音频：纯状态推导、schema 迁移、导入校验与实际播放生命周期。
   运行层用可注入的假播放对象，断言的是 play() 的 Promise 结果、实际播放状态、
   currentTime 推进、循环/停止/切换/淡变，而不是「有没有调用 play」。 */
const assert = require('node:assert/strict');
const C = require('../dist/core.js')();
const createPaperAudio = require('../dist/audio.js');
const A = createPaperAudio();

/* ---------- 合成 16-bit PCM WAV，测试不依赖外部素材包 ---------- */
function wav(seconds, sampleRate = 8000, channels = 1) {
  const bytes = sampleRate * seconds * channels * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}
const WAV = wav(1), DATA = 'data:audio/wav;base64,' + WAV.toString('base64');
const DATA2 = 'data:audio/wav;base64,' + wav(2, 8000, 2).toString('base64');
const DATA3 = 'data:audio/wav;base64,' + wav(3, 11025, 1).toString('base64');
const audioAsset = (id, data) => ({ id, name: id + '.wav', categories: ['bgm', 'sfx', 'voice'],
  data: data || DATA, mime: 'audio/wav', ext: 'wav', bytes: Buffer.from((data || DATA).split(',')[1], 'base64').length, duration: 1 });
const play = (audioId, extra) => Object.assign({ action: 'play', audioId, volume: 1, loop: true, fadeIn: 0, fadeOut: 0 }, extra || {});
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1. 纯函数：音量、指令、WAV 头与导入校验 ---------- */
{
  const p = A.pure.normalizePrefs({ master: .5, bgm: .8, sfx: 1, voice: .5, muted: false });
  assert.equal(A.pure.finalVolume(p, 'bgm', .5), .2, '总 × 分类 × 本次播放音量');
  assert.equal(A.pure.finalVolume({ ...p, muted: true }, 'bgm', 1), 0, '静音归零');
  assert.equal(A.pure.finalVolume(p, 'voice', 1), .25);
  assert.deepEqual(A.pure.normalizePrefs({ master: 99, bgm: -3, muted: 0 }),
    { master: 1, bgm: 0, sfx: 1, voice: 1, muted: false }, '非法偏好被夹到合法范围');

  const cue = A.pure.normalizeCue({ bgm: { action: 'play', audioId: 'a', volume: 9, loop: 1, fadeIn: 99 },
    sfx: [{ id: 's1', audioId: 'b', volume: 2, delay: -1 }], voice: { audioId: 'c', volume: .3 } });
  assert.equal(cue.bgm.volume, 1); assert.equal(cue.bgm.fadeIn, 10);
  assert.equal(cue.sfx[0].volume, 1); assert.equal(cue.sfx[0].delay, 0);
  assert.equal(cue.voice.volume, .3);
  assert.deepEqual(A.pure.normalizeCue(null), { bgm: null, sfx: [], voice: null }, '空指令 = 沿用');

  const info = A.pure.wavInfo(new Uint8Array(WAV));
  assert.equal(info.duration, 1); assert.equal(info.sampleRate, 8000); assert.equal(info.channels, 1); assert.equal(info.bits, 16);
  assert.equal(A.pure.wavInfo(new Uint8Array(wav(2, 8000, 2))).duration, 2);
  assert.throws(() => A.pure.wavInfo(new Uint8Array(Buffer.from('not a wav at all and definitely too short'))), /RIFF\/WAVE/);
  const broken = Buffer.from(wav(1)); broken.write('RIFF', 0); broken.write('XXXX', 8);
  assert.throws(() => A.pure.wavInfo(new Uint8Array(broken)), /RIFF\/WAVE/);
  const truncated = Buffer.from(wav(1)).subarray(0, 30);
  assert.throws(() => A.pure.wavInfo(new Uint8Array(truncated)), /RIFF\/WAVE/);

  const ok = A.pure.checkImport({ name: 'tone.wav', mime: 'audio/wav', bytes: new Uint8Array(WAV), totalBytes: 0,
    elementFactory: () => ({ canPlayType: () => 'probably' }), canPlayType: () => 'probably' });
  assert.equal(ok.ok, true, 'PCM WAV 通过');
  assert.equal(ok.ext, 'wav');
  assert.equal(A.pure.checkImport({ name: 'bad.wav', mime: 'audio/wav', bytes: new Uint8Array(Buffer.from('nope')), totalBytes: 0 }).ok, false, '损坏 WAV 被拒绝');
  assert.match(A.pure.checkImport({ name: 'huge.wav', bytes: new Uint8Array(17 * 1024 * 1024), totalBytes: 0 }).message, /超过单文件/);
  assert.match(A.pure.checkImport({ name: 'x.wav', bytes: new Uint8Array(WAV), totalBytes: A.LIMITS.maxTotal }).message, /总量/);
  assert.match(A.pure.checkImport({ name: 'x.exe', bytes: new Uint8Array(WAV), totalBytes: 0 }).message, /格式不受支持/);
  assert.match(A.pure.checkImport({ name: 'x.ogg', bytes: new Uint8Array(WAV), totalBytes: 0,
    canPlayType: () => '' }).message, /无法解码/, '当前环境不能解码的格式明确拒绝');
  assert.equal(A.pure.checkImport({ name: 'x.ogg', bytes: new Uint8Array(WAV), totalBytes: 0,
    canPlayType: () => 'probably' }).ok, true, '能解码时接受其他格式');
  assert.equal(A.pure.classifyError(Object.assign(new Error('play() failed'), { name: 'NotAllowedError' })).code, 'permission');
  assert.equal(A.pure.classifyError(Object.assign(new Error('no codec'), { name: 'NotSupportedError' })).code, 'decode');
  console.log('  ok  音量组合、指令归一化、PCM WAV 头、损坏/超限/不支持格式拒绝与错误分类');
}

/* ---------- 2. core：迁移、校验、引用统计与「own 不重置音乐」 ---------- */
function graph(withAudio) {
  const p = C.blank(), pid = p.chapters[0].paragraphs[0].id;
  const n = (id, extra) => Object.assign(C.makeNode('say'), { id, text: id, paragraphId: pid, next: '' }, extra || {});
  const s1 = n('s1', { sceneMode: 'own', next: 'c', audio: withAudio ? { bgm: play('A') } : null });
  const c = Object.assign(C.makeNode('choice'), { id: 'c', text: '选', paragraphId: pid,
    options: [{ text: '左', target: 'a1' }, { text: '右', target: 'b1' }] });
  const a1 = n('a1', { next: 'm', audio: withAudio ? { bgm: play('B') } : null });
  const b1 = n('b1', { next: 'm', audio: withAudio ? { bgm: play('C') } : null });
  const m = n('m', { sceneMode: 'own', next: 'end' });
  const end = Object.assign(C.makeNode('end'), { id: 'end', text: '完', paragraphId: pid });
  p.nodes = [s1, c, a1, b1, m, end];
  if (withAudio) p.audioAssets = [audioAsset('A'), audioAsset('B', DATA2), audioAsset('C')];
  assert(C.validate(p));
  return p;
}
{
  const legacy = { schema: 4, id: 'x', title: '旧', assets: [], presets: [], nodes: [
    { id: 'n1', type: 'say', name: '', text: 'hi', next: '', sceneMode: 'own', layers: [], effects: [], speakerId: '', expressionId: '', cast: [] }],
    characters: [] };
  const migrated = C.migrate(legacy);
  assert.deepEqual(migrated.audioAssets, [], '旧工程迁移后无音频素材');
  assert.equal(migrated.nodes[0].audio, null, '旧节点无音频指令');
  assert.equal(legacy.audioAssets, undefined, '迁移不改入参');
  assert.deepEqual(C.analyze(migrated).errors, [], '旧无音频工程检查通过');

  const p = graph(true);
  assert.equal(C.hasAnyAudio(p), true);
  const noAudio = graph(false);
  assert.equal(C.hasAnyAudio(noAudio), false);
  assert(C.validate(p));
  const bad = C.clone(p); bad.audioAssets[0].data = 'data:image/png;base64,AAAA';
  assert.throws(() => C.validate(bad), /音频素材格式错误/, '音频不走图片专用校验');
  const bad2 = C.clone(p); bad2.nodes[1].audio = { sfx: [{ id: 'x', audioId: 'A', volume: 2, delay: 0 }] };
  assert.throws(() => C.validate(bad2), /音效参数格式错误/);

  assert.equal(C.audioStateAlong(p, ['s1', 'c', 'a1', 'm']).audioId, 'B', '沿真实路线结算');
  assert.equal(C.audioStateAlong(p, ['s1', 'c', 'b1', 'm']).audioId, 'C');
  assert.equal(C.audioStateAlong(p, ['s1', 'c', 'a1', 'm', 'end']).audioId, 'B', 'own 场景不自动停止音乐');
  assert.equal(C.bgmAt(p, 'm', ['s1', 'c', 'b1']).audioId, 'C');
  assert.equal(C.bgmAt(p, 's1', []).audioId, 'A');
  const uses = C.audioUsage(p, 'B');
  assert.equal(uses.length, 1); assert.equal(uses[0].where, '背景音乐');
  const missing = C.clone(p); missing.audioAssets = [];
  assert(C.analyze(missing).errors.some(e => e.includes('音频素材')), '失效引用明确报错');

  const reused = C.assetForAudioImport(p, { id: 'new', name: 'again.wav', categories: ['voice'], data: DATA, mime: 'audio/wav', ext: 'wav', bytes: WAV.length, duration: 1 });
  assert.equal(reused.reused, true, '同内容文件复用资源');
  assert.equal(reused.asset.id, 'A');
  assert.deepEqual(reused.categories, ['bgm', 'sfx', 'voice'], '不同用途合并在同一素材上');
  const fresh = C.assetForAudioImport(p, { id: 'new2', name: 'new.wav', categories: ['bgm'], data: DATA3, mime: 'audio/wav', ext: 'wav', bytes: 1, duration: 3 });
  assert.equal(fresh.reused, false);
  console.log('  ok  旧工程零音频迁移、音频专用校验、真实路线结算、引用统计与内容复用');
}

/* ---------- 3. 定点试玩：分支 BGM 不混用、own 不清历史、预算截断不误报 ---------- */
{
  const p = graph(true);
  const plan = C.entryPlan(p, 'm');
  assert.equal(plan.ambiguous, true, '两条路线播放了不同 BGM，汇合句必须让作者选');
  assert.equal(plan.options.length, 2);
  const states = plan.options.map(o => C.audioStateAlong(p, [...o.trail, 'm']).audioId).sort();
  assert.deepEqual(states, ['B', 'C'], '每条候选路线各自带正确的音乐状态');
  for (const o of plan.options) assert(!(o.trail.includes('a1') && o.trail.includes('b1')), '不把互斥分支拼在一起');

  /* own 之前两条路线音乐相同：画面路线仍有歧义，但音乐状态一致且不被清除 */
  const q = graph(true);
  q.nodes.find(n => n.id === 'b1').audio = { bgm: play('B') };
  assert(q.nodes.find(n => n.id === 'm').sceneMode === 'own');
  const same = C.entryPlan(q, 'm');
  assert.equal(same.ambiguous, true, '画面/表情路线不唯一，仍需作者选择');
  assert.equal(same.audioAgrees, true, '但各路线的音乐相同，不必为音乐再猜一次');
  assert.equal(same.bgm.audioId, 'B', 'own 画面入口之前的 BGM 没有被丢掉');
  for (const o of same.options) assert.equal(C.audioStateAlong(q, [...o.trail, 'm']).audioId, 'B', '每条候选路线都沿用自己的音乐');
  /* 单一路线时完全确定，own 也不丢音频历史 */
  const q2 = graph(true);
  q2.nodes.find(n => n.id === 'c').options = [{ text: '左', target: 'a1' }];
  const one = C.entryPlan(q2, 'm');
  assert.equal(one.ambiguous, false, '单一路线确定');
  assert.equal(one.bgm.audioId, 'B', 'own 入口前的 BGM 正确沿用');
  assert.equal(C.audioStateAlong(q2, [...one.trail, 'm']).audioId, 'B');

  /* 无音频工程仍走原来的「独立场景从自身开始」快速路径 */
  const plain = graph(false);
  const own = C.entryPlan(plain, 'm');
  assert.equal(own.source, 'scene'); assert.deepEqual(own.trail, []);
  assert.equal(own.ambiguous, false);

  /* 含音频的 own 句不再提前返回空 trail */
  const ownAudio = C.entryPlan(p, 'm');
  assert.notEqual(ownAudio.source, 'scene', '含音频工程的 own 句必须枚举音频历史');

  /* 实际试玩路径优先，且带出音乐状态 */
  const actual = C.entryPlan(p, 'm', ['s1', 'c', 'a1']);
  assert.equal(actual.source, 'actual');
  assert.equal(actual.bgm.audioId, 'B');
  assert.equal(actual.ambiguous, false);

  /* 循环 + 预算：达到上限不得假报唯一。加大量独立画面入口让枚举撞上路线预算，
     同时保留一条可达循环（a1 回到 c），验证不会把「没枚举完」当成唯一。 */
  const loop = graph(true);
  loop.nodes.find(n => n.id === 'a1').next = 'c';
  loop.nodes.find(n => n.id === 'b1').next = 'm';
  const pid = loop.chapters[0].paragraphs[0].id;
  for (let i = 0; i < 30; i++) {
    const x = C.makeNode('say');
    Object.assign(x, { id: 'extra' + i, text: '循环入口', paragraphId: pid, sceneMode: 'own', next: 'm' });
    loop.nodes.push(x);
  }
  const trunc = C.entryPlan(loop, 'm');
  assert.equal(trunc.ambiguous, true, '预算耗尽或循环结构下不能断言路线唯一');
  assert(trunc.truncated || trunc.options.length > 1, '标记截断或多候选');
  assert.equal(C.entryPath(p, 'm').uncertain, true, '兼容入口仍报告不确定');
  console.log('  ok  分支 BGM 不混用、own 前音乐沿用、实际路径优先、循环预算不误报唯一');
}

/* ---------- 4. 运行层：真实播放状态与时间推进 ---------- */
const ALL_STATES = [];
function harness(opts = {}) {
  const state = { els: [], plays: [], durations: {}, blockPermission: !!opts.blockPermission, unlocked: false };
  ALL_STATES.push(state);
  const factory = () => {
    const el = {
      _src: '', volume: 1, loop: false, paused: true, ended: false, currentTime: 0, duration: 0,
      error: null, onended: null, onerror: null, preload: '', listeners: {}, _t: null,
      addEventListener(k, fn) { (this.listeners[k] || (this.listeners[k] = [])).push(fn); },
      canPlayType: () => 'probably', load() {},
      get src() { return this._src; },
      set src(v) {
        this._src = v; this.duration = state.durations[v] || 10;
        setTimeout(() => (this.listeners.loadedmetadata || []).forEach(f => f()), 0);
      },
      play() {
        if (state.blockPermission && !state.unlocked) {
          return Promise.reject(Object.assign(new Error("play() failed because the user didn't interact with the document first"), { name: 'NotAllowedError' }));
        }
        this.paused = false; this.ended = false;
        const self = this;
        clearInterval(this._t);
        this._t = setInterval(() => { if (!self.paused && !self.ended) self.currentTime += .05; }, 50);
        state.plays.push({ src: this._src, el: this });
        return Promise.resolve();
      },
      pause() { this.paused = true; clearInterval(this._t); this._t = null; }
    };
    state.els.push(el);
    return el;
  };
  const data = { A: DATA, B: DATA2, C: DATA, V: DATA, S: DATA, S2: DATA2 };
  state.durations = Object.fromEntries(Object.entries(data).map(([k, v]) => [v, k === 'B' ? 2 : 1]));
  const runtime = A.runtime({ elementFactory: factory, assetData: id => data[id] || '', prefs: opts.prefs });
  return { runtime, state, data };
}
const cue = {
  bgm: play('A'),
  sfx: [{ id: 's1', audioId: 'S', volume: 1, delay: 0 }, { id: 's2', audioId: 'S2', volume: 1, delay: .2 }],
  voice: { audioId: 'V', volume: 1 }
};

(async () => {
  /* 4a 沿用不重启；显式 play 从头（同一首也是） */
  {
    const { runtime, state } = harness();
    let r = await runtime.enter({ bgm: play('A') });
    assert.equal(r.ok, true, '播放 Promise 成功');
    assert.equal(runtime.status().bgm.playing, true, '实际处于播放状态');
    assert.equal(runtime.status().bgm.loop, true, '循环生效');
    await wait(180);
    const before = runtime.status().bgm.time;
    assert(before > 0, '播放时间真的在推进：' + before);
    const el = state.els.find(e => e.src === state.data?.A) || runtime.status().bgm;
    r = await runtime.enter({ sfx: [] });           /* 沿用：无 bgm 指令 */
    const st = runtime.status();
    assert.equal(st.bgm.audioId, 'A', '沿用仍是同一首');
    assert(st.bgm.time >= before, '沿用不回到曲首，播放位置连续：' + st.bgm.time);
    assert.equal(st.bgm.playing, true);
    r = await runtime.enter({ bgm: play('A') });   /* 显式播放：同一首也从头 */
    const st2 = runtime.status();
    assert(st2.bgm.time < .2, '显式播放从头开始：' + st2.bgm.time);
    runtime.stopAll();
    console.log('  ok  播放 Promise / 实际状态 / 时间推进；沿用不重启，显式播放同一首也从曲首');
  }

  /* 4b 切换、停止、淡入淡出、快速连续切句 */
  {
    const { runtime } = harness();
    await runtime.enter({ bgm: play('A') });
    await runtime.enter({ bgm: play('B', { fadeIn: .08, fadeOut: .08 }) });
    let st = runtime.status();
    assert.equal(st.pendingSwitch, true, '淡出期间等待切换到新曲');
    await wait(200);
    st = runtime.status();
    assert.equal(st.bgm.audioId, 'B', '旧曲淡出后新曲淡入');
    assert.equal(st.bgm.playing, true);
    assert.equal(st.retiring, 0, '旧曲已清理，没有残留');

    /* 快速连续切句：过期回调不能让旧音乐重新响起 */
    await runtime.enter({ bgm: play('C', { fadeIn: .05, fadeOut: .3 }) });
    await runtime.enter({ bgm: { action: 'stop', fadeOut: .3 } });
    await wait(80);
    st = runtime.status();
    assert.equal(st.bgm, null, '最新指令是停止，旧切换没有复活');
    assert.equal(st.pendingSwitch, false, '过期淡变与回调已取消');
    await wait(400);
    st = runtime.status();
    assert.equal(st.bgm, null, '等待后仍然不会响起旧音乐');
    assert.equal(st.retiring, 0);
    runtime.stopAll();
    console.log('  ok  切换淡出→淡入、停止、快速连续切句取消过期回调且旧曲不复活');
  }

  /* 4c 音量组合与调音量不重启 */
  {
    const { runtime } = harness({ prefs: { master: .5, bgm: .5, sfx: 1, voice: 1, muted: false } });
    await runtime.enter({ bgm: play('A', { volume: .5 }) });
    let st = runtime.status();
    assert(Math.abs(st.bgm.volume - .125) < .001, '0.5 × 0.5 × 0.5 = 0.125，实际 ' + st.bgm.volume);
    const beforeTime = st.bgm.time;
    runtime.setPrefs({ master: 1 });
    st = runtime.status();
    assert(Math.abs(st.bgm.volume - .25) < .001, '调总音量立即生效：' + st.bgm.volume);
    assert(st.bgm.time >= beforeTime, '调音量没有重启声音');
    runtime.setPrefs({ muted: true });
    assert.equal(runtime.status().bgm.volume, 0, '静音归零');
    assert.equal(runtime.status().bgm.playing, true, '静音不重启、不销毁通道');
    runtime.setPrefs({ muted: false, bgm: 1, master: 1 });
    assert(Math.abs(runtime.status().bgm.volume - .5) < .001);
    runtime.stopAll();
    console.log('  ok  总/分类/节点音量组合、静音与调音量不重启当前声音');
  }

  /* 4d 语音互斥与离开节点停止 */
  {
    const { runtime } = harness();
    await runtime.enter({ voice: { audioId: 'V', volume: 1 } });
    assert.equal(runtime.status().voice.playing, true);
    await runtime.enter({ voice: { audioId: 'S', volume: 1 } });
    let st = runtime.status();
    assert.equal(st.voice.audioId, 'S', '单语音通道：新语音替换旧语音');
    assert.equal(st.voice.playing, true);
    await runtime.enter({ sfx: [] });                /* 切到下一句，无语音 */
    st = runtime.status();
    assert.equal(st.voice, null, '离开节点旧语音已停止');
    runtime.stopAll();
    console.log('  ok  台词语音单通道互斥、进入本句从头播放、切句即停止');
  }

  /* 4e 多音效、延迟触发、提前切句取消 */
  {
    const { runtime, state } = harness();
    const before = state.els.length;
    await runtime.enter({ sfx: [
      { id: 's1', audioId: 'S', volume: 1, delay: 0 },
      { id: 's2', audioId: 'S2', volume: 1, delay: .15 },
      { id: 's3', audioId: 'S', volume: 1, delay: .5 }
    ] });
    assert.equal(runtime.status().sfx.length, 1, '零延迟音效立即触发一次');
    assert.equal(runtime.status().pendingSfx, 2, '两个延迟任务排队');
    await wait(220);
    assert.equal(runtime.status().sfx.length, 2, '延迟音效按时间触发');
    await runtime.enter({ sfx: [] });               /* 提前切句 */
    let st = runtime.status();
    assert.equal(st.sfx.length, 0, '上一句未结束的音效全部停止');
    assert.equal(st.pendingSfx, 0, '尚未触发的延迟任务已取消');
    await wait(600);
    st = runtime.status();
    assert.equal(st.sfx.length, 0, '过期延迟任务不会在切句后响起');
    assert.equal(state.els.length, before + 2, '只创建了实际触发的通道');
    runtime.stopAll();
    console.log('  ok  多音效、延迟触发、提前切句停止未结束音效并取消延迟任务');
  }

  /* 4f 编辑不自动播放、试听与试玩不叠音、清理 */
  {
    const { runtime, state } = harness();
    const n = state.els.length;
    assert.deepEqual(runtime.status().bgm, null);
    assert.equal(state.els.length, n, '仅编辑节点不创建任何播放对象');
    await runtime.enter({ bgm: play('A'), sfx: [{ id: 's', audioId: 'S', volume: 1, delay: 0 }] });
    const pr = await runtime.previewAsset('V', 'voice', 1);
    assert.equal(pr.ok, true);
    let st = runtime.status();
    assert.equal(st.preview.playing, true, '素材试听在播放');
    assert.equal(st.bgm, null, '试听开始即清掉试玩 BGM，不叠音');
    assert.equal(st.sfx.length, 0, '试听开始即清掉试玩音效');
    await runtime.enter({ bgm: play('A') });
    st = runtime.status();
    assert.equal(st.preview, null, '进入试玩停止素材试听');
    assert.equal(st.bgm.playing, true);
    runtime.stopPreview();
    runtime.stopAll();
    st = runtime.status();
    assert.equal(st.bgm, null); assert.equal(st.voice, null); assert.equal(st.preview, null);
    assert.equal(st.sfx.length, 0); assert.equal(st.pendingSfx, 0); assert.equal(st.pendingSwitch, false);
    console.log('  ok  编辑不自动播放、素材试听与试玩互斥、停止全部清理干净');
  }

  /* 4g 未获播放许可：不假报成功，可重试 */
  {
    const { runtime, state } = harness({ blockPermission: true });
    const r = await runtime.enter({ bgm: play('A') });
    assert.equal(r.ok, false, '播放 Promise 被拒绝');
    assert.equal(runtime.status().bgm, null, '失败后状态不是「正在播放」');
    const err = runtime.status().errors[0];
    assert.equal(err.code, 'permission', '错误分类为未获播放许可');
    assert(err.hint.includes('启用声音'), '给出中文指引');
    const denied = await runtime.unlock();
    assert.equal(denied.ok, false);
    assert.equal(runtime.isUnlocked(), false);
    state.unlocked = true;                         /* 模拟真实用户手势放行 */
    const ok = await runtime.unlock();
    assert.equal(ok.ok, true);
    assert.equal(runtime.isUnlocked(), true);
    const retry = await runtime.retry();
    assert.equal(retry.ok, true, '重试成功');
    assert.equal(runtime.status().bgm.playing, true);
    runtime.stopAll();
    console.log('  ok  播放受限时明确报「未获播放许可」、状态可重试、解锁后恢复');
  }

  /* 4h 素材缺失与解码失败分类 */
  {
    const { runtime } = harness();
    const r = await runtime.enter({ bgm: play('NOPE') });
    assert.equal(r.ok, false);
    assert.equal(runtime.status().errors[0].code, 'missing');
    assert.match(runtime.status().errors[0].hint, /重新导入/);
    runtime.stopAll();
    console.log('  ok  素材缺失明确报错，不静默当作播放成功');
  }

  /* 4i 重建：定点试玩 / 读档 / 返回 / 重开从曲首启动 */
  {
    const { runtime } = harness();
    await runtime.enter({ bgm: play('A') });
    await wait(180);
    assert(runtime.status().bgm.time > 0);
    await runtime.enter({ sfx: [] }, { rebuild: true, bgmState: { audioId: 'A', volume: 1, loop: true, fadeIn: 0 } });
    const st = runtime.status();
    assert.equal(st.bgm.audioId, 'A');
    assert(st.bgm.time < .2, '重建从曲首启动，不追算此前耗时');
    runtime.stopAll();
    console.log('  ok  返回 / 读档 / 重开按目标句状态从曲首重建');
  }

  /* 生命周期收尾：所有播放对象的计时器都必须已被运行层停掉，不能靠进程退出兜底。 */
  const leaked = [];
  ALL_STATES.forEach((s, i) => s.els.forEach((el, j) => {
    if (el._t) { leaked.push('harness ' + i + ' / element ' + j); clearInterval(el._t); }
  }));
  assert.deepEqual(leaked, [], '运行层清理了全部播放计时器，残留：' + leaked.join(','));
  console.log('  ok  退出试玩 / 切句 / 切工程后没有残留播放计时器');
  console.log('PASS: V0.5 audio state, migration, route ambiguity and playback lifecycle');
})().catch(e => { console.error(e); process.exit(1); });
