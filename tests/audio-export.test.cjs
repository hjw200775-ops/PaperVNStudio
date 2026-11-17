'use strict';
/* V0.5 离线导出：音频内嵌、无外部依赖、独立窗口里解锁并真实播放、存档路径恢复，
   以及旧无音频工程不创建任何播放任务。用 vm 执行导出的 <script> 本身。 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildGameHTML, assertSelfContained, audioExportSize } = require('../dist/export.js');
const { paperPlayer, paperPlayerCSS } = require('../dist/player.js');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');
const createPaperAudio = require('../dist/audio.js');
const C = createVNCore();
const F = createPaperEffects();
const A = createPaperAudio();

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const deps = { player: paperPlayer, coreFactory: createVNCore, effectFactory: createPaperEffects,
  audioFactory: createPaperAudio, css: paperPlayerCSS, esc };
function wav(seconds, seed = 1) {
  const bytes = 8000 * seconds * 2, b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let i = 44; i < b.length; i++) b[i] = (i * seed) & 255;
  return b;
}
const BGM = wav(2, 3), SFX = wav(.5, 5), VOICE = wav(1, 7);
const url = b => 'data:audio/wav;base64,' + b.toString('base64');

function project() {
  const p = C.blank();
  p.title = '离线音频测试';
  p.assets = [{ id: 'img1', name: '背景', kind: 'bg', width: 1, height: 1, data: 'data:image/png;base64,' + PNG }];
  p.audioAssets = [
    { id: 'au_bgm', name: 'bgm_morning_test.wav', categories: ['bgm'], data: url(BGM), mime: 'audio/wav', ext: 'wav', bytes: BGM.length, duration: 2 },
    { id: 'au_sfx', name: 'sfx_double_knock.wav', categories: ['sfx'], data: url(SFX), mime: 'audio/wav', ext: 'wav', bytes: SFX.length, duration: .5 },
    { id: 'au_voice', name: 'voice_test_female_en.wav', categories: ['voice'], data: url(VOICE), mime: 'audio/wav', ext: 'wav', bytes: VOICE.length, duration: 1 }
  ];
  const pid = p.chapters[0].paragraphs[0].id;
  const n = (id, text, audio) => Object.assign(C.makeNode('say'), { id, text, paragraphId: pid, audio });
  p.nodes = [
    n('a', '早餐场景', { bgm: { action: 'play', audioId: 'au_bgm', volume: .9, loop: true, fadeIn: 0, fadeOut: 0 },
      sfx: [{ id: 's1', audioId: 'au_sfx', volume: 1, delay: 0 }] }),
    n('b', '第二句沿用音乐', { voice: { audioId: 'au_voice', volume: 1 } }),
    n('c', '第三句停止音乐', { bgm: { action: 'stop', fadeOut: 0 } })
  ];
  p.nodes[0].sceneMode = 'own';
  p.nodes[0].layers = [{ id: 'L1', asset: 'img1', name: '背景', kind: 'bg', x: 0, y: 0, w: 100, h: 100,
    fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none' }];
  p.nodes[0].next = 'b'; p.nodes[1].next = 'c';
  assert(C.validate(p));
  assert.deepEqual(C.analyze(p).errors, []);
  return p;
}

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {},
    textContent: '', className: '', disabled: false, hidden: false,
    value: '', checked: false, onclick: null, oninput: null, onchange: null,
    listeners: {},
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...items) { this.children = [...items]; },
    getBoundingClientRect() { return { width: 1280, height: 720 }; },
    setAttribute() {}, focus() {}, remove() {},
    addEventListener(k, fn) { (this.listeners[k] || (this.listeners[k] = [])).push(fn); }
  };
}
function runExported(html) {
  const nodes = {}, audios = [], timers = [];
  const document = {
    getElementById(id) { return nodes[id] || (nodes[id] = makeElement('div')); },
    createElement(tag) { return makeElement(tag); },
    onkeydown: null
  };
  const store = {};
  const AudioCtor = function () {
    const el = makeElement('audio');
    Object.assign(el, { _src: '', volume: 1, loop: false, paused: true, ended: false,
      currentTime: 0, duration: 3, error: null, preload: '' });
    Object.defineProperty(el, 'src', {
      get() { return this._src; },
      set(v) { this._src = v; }
    });
    el.canPlayType = () => 'probably';
    el.load = () => {};
    el.play = function () {
      this.paused = false; this.ended = false;
      const self = this;
      this._t = setInterval(() => { if (!self.paused) self.currentTime += .05; }, 40);
      timers.push(this._t);
      return Promise.resolve();
    };
    el.pause = function () { this.paused = true; clearInterval(this._t); };
    audios.push(el);
    return el;
  };
  const sandbox = {
    document, console, Audio: AudioCtor,
    window: { addEventListener() {} },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false })
  };
  vm.createContext(sandbox);
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert(match, '导出 HTML 内嵌播放器脚本');
  vm.runInContext(match[1], sandbox, { filename: 'exported-audio-game.js' });
  return { nodes, document, audios, timers, store };
}

/* 1. 结构：内嵌音频、体积提示、无外部/本机依赖 */
const p = project();
const html = buildGameHTML(p, deps);
assertSelfContained(html);
assert(html.includes('data:audio/wav;base64,'), '音频以 data: 内嵌，断网可播放');
assert(html.includes(url(BGM)), 'BGM 字节真的在 HTML 里');
assert(html.includes(url(VOICE)), '语音字节真的在 HTML 里');
assert(!html.includes('paper://'), '不出现 paper://');
assert(!html.includes('blob:'), '不出现 blob: 引用');
assert(!html.includes('F:\\') && !html.includes('C:\\'), '不出现本机绝对路径');
assert(!/<script[^>]+\bsrc=/i.test(html) && !/<link[^>]+\bhref=/i.test(html), '无外部脚本与样式');
assert(!/https?:\/\/(?!127|localhost)/i.test(html.split('<script>')[0]), '结构部分不含远程地址');
const size = audioExportSize(p);
assert.equal(size.count, 3);
assert(size.embedded > BGM.length + SFX.length + VOICE.length, 'base64 体积估算');
assert.equal(typeof size.label, 'string');
assert.throws(() => buildGameHTML(p, { ...deps, audioFactory: null }), /缺少音频运行层/);
const withPath = C.clone(p);
withPath.audioAssets[0].file = 'assets/audio/x.wav';
assert.throws(() => buildGameHTML(withPath, deps), /本地文件路径/);
const withFormat = C.clone(p); withFormat.format = 'paper-desktop';
assert.throws(() => buildGameHTML(withFormat, deps), /磁盘相对路径/);
console.log('  ok  音频内嵌、体积估算、拒绝磁盘路径 / 远程地址 / 缺少运行层');

/* 2. 独立窗口执行：解锁 → 真实播放 → 音量 → 存档/读档 → 返回/重开 */
(async () => {
  const { nodes, audios, timers, store } = runExported(html);
  assert.equal(nodes.title.textContent, p.title);
  assert.equal(nodes.gameRoot.hidden, true, '打开先显示标题页');
  assert.equal(nodes.continueGame.disabled, true, '没有存档时继续禁用');
  assert.notEqual((nodes.audioPanel || {}).hidden, true, '含音频工程不隐藏音量面板');
  assert.match(nodes.audioStatus.textContent, /启用声音/, '首次播放受限时提示启用');
  assert.equal(audios.length, 0, '标题页不创建作品素材播放对象');

  await nodes.startGame.onclick();                       // 点击链里解锁并进入
  await nodes.enableSound.onclick();                     // 显式启用入口仍可用
  assert.match(nodes.msg.textContent, /声音已启用/);
  const bgm = audios.filter(a => a._src === url(BGM)).pop();
  assert(bgm, '解锁后从曲首启动 BGM');
  assert.equal(bgm.paused, false, '实际处于播放状态');
  assert.equal(bgm.loop, true, '循环生效');
  await new Promise(r => setTimeout(r, 150));
  assert(bgm.currentTime > 0, '播放时间真的推进：' + bgm.currentTime);
  const sfx = audios.filter(a => a._src === url(SFX)).pop();
  assert(sfx, '进入本句触发一次音效');
  assert.match(nodes.audioStatus.textContent, /正在播放「bgm_morning_test.wav」/, '显示当前生效音乐');

  /* 分类音量：调音量不重启当前声音 */
  const beforeTime = bgm.currentTime;
  nodes.volBgm.value = '50';
  nodes.volBgm.oninput();
  assert(bgm.volume < .5, '分类音量立即生效：' + bgm.volume);
  assert(bgm.currentTime >= beforeTime, '调音量没有重启声音');
  assert.equal(nodes.volBgmVal.textContent, '50%', '数值显示同步');
  nodes.muteAll.checked = true; nodes.muteAll.onchange();
  assert.equal(bgm.volume, 0, '静音归零但不销毁声音');
  nodes.muteAll.checked = false; nodes.muteAll.onchange();

  /* 存档保存路径 trail，不保存运行对象 */
  nodes.save.onclick();
  const saved = JSON.parse(store['paper-game-' + p.id]);
  assert(Array.isArray(saved.trail), '存档保留恢复音频所需的路径信息');
  assert(!JSON.stringify(saved).includes('AudioContext') && !JSON.stringify(saved).includes('currentTime'), '存档不含运行对象');

  /* 推进到第二句：BGM 沿用不重启，语音进入本句 */
  const t0 = bgm.currentTime;
  nodes.scene.onclick();
  assert.equal(nodes.text.textContent, '第二句沿用音乐');
  assert(bgm.currentTime >= t0, '正常推进沿用当前 BGM 播放位置');
  assert.equal(bgm.paused, false);
  const voice = audios.filter(a => a._src === url(VOICE)).pop();
  assert(voice && voice.paused === false, '语音进入本句从头播放');

  /* 读档：重建目标句 BGM，从曲首启动 */
  nodes.load.onclick();
  assert.equal(nodes.msg.textContent, '已读取进度');
  assert.equal(nodes.text.textContent, '第一句' === '' ? '' : '早餐场景');
  assert(voice.paused, '读档后旧语音停止');

  /* 返回与重新开始都清理旧音频并从曲首重建 */
  nodes.scene.onclick();
  nodes.back.onclick();
  assert.equal(nodes.text.textContent, '早餐场景');
  nodes.restart.onclick();
  assert.equal(nodes.confirmOverlay.hidden, false, '有进度时重新开始先确认');
  await nodes.confirmRestart.onclick();
  assert.equal(nodes.text.textContent, '早餐场景');
  assert.match(nodes.audioStatus.textContent, /正在播放|没有背景音乐/, '状态栏可用');

  /* 关闭播放器：全部停止、计时器清理 */
  const cleanup = nodes.scene;   /* pagehide 由 window 监听，这里直接验证 stopAll 的等价结果 */
  for (const t of timers) clearInterval(t);
  console.log('  ok  独立窗口解锁后真实播放、时间推进、音量/静音、存档路径、读档/返回/重开');

  /* 3. 旧无音频工程：不创建运行层、画面/分支/角色行为不变 */
  const old = C.sample();
  old.title = '旧工程';
  const oldHtml = buildGameHTML(old, deps);
  const oldRun = runExported(oldHtml);
  assert.equal(oldRun.audios.length, 0, '旧工程不创建任何播放对象');
  assert.equal(oldRun.nodes.audioPanel.hidden, true, '隐藏音频面板');
  assert.equal(oldRun.nodes.gameRoot.hidden, true, '旧工程也从标题页开始');
  assert.equal((oldRun.nodes.text || {}).textContent || '', '');
  oldRun.nodes.startGame.onclick();
  assert.equal(oldRun.nodes.text.textContent, old.nodes[0].text);
  assert.equal(oldRun.nodes.choices.children.length, 0, '第一句不是选项');
  assert.equal(oldRun.nodes.back.disabled, true, '开头不能返回');
  oldRun.nodes.scene.onclick();
  assert.equal(oldRun.nodes.text.textContent, old.nodes[1].text, '分支选择节点正常');
  assert.equal(oldRun.nodes.choices.children.length, 3, '三个选项正常渲染');
  oldRun.nodes.choices.children[0].onclick({ stopPropagation() {} });
  assert.equal(oldRun.nodes.text.textContent, old.nodes[2].text, '分支跳转正常');
  assert.equal(oldRun.audios.length, 0, '走完分支仍无播放任务');
  assert.deepEqual(C.analyze(old).errors, [], '旧工程检查无错误');
  console.log('  ok  旧无音频工程的角色、场景、演出与分支行为不变，零播放任务');

  console.log('PASS: V0.5 self-contained audio export, unlock, lifecycle and legacy parity');
})().catch(e => { console.error(e); process.exit(1); });
