'use strict';
/* V0.6.1 播放器状态与存档异常：标题 → 开始/继续 → 菜单 → 设置 → 返回标题。
   用 vm 执行导出的 <script>，断言真实状态（state/i/trail/音频通道），不是只看按钮存在。 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildGameHTML } = require('../dist/export.js');
const { paperPlayer, paperPlayerCSS } = require('../dist/player.js');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');
const createPaperAudio = require('../dist/audio.js');
const C = createVNCore();

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const deps = { player: paperPlayer, coreFactory: createVNCore, effectFactory: createPaperEffects,
  audioFactory: createPaperAudio, css: paperPlayerCSS, esc };
const WAV = (() => {
  const b = Buffer.alloc(44 + 1600);
  b.write('RIFF', 0); b.writeUInt32LE(36 + 1600, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(1600, 40);
  return b;
})();
const AUDIO_URL = 'data:audio/wav;base64,' + WAV.toString('base64');

function project(withAudio) {
  const p = C.blank();
  p.title = '标题页测试';
  p.assets = [{ id: 'img', name: '背景', kind: 'bg', width: 1, height: 1, data: 'data:image/png;base64,' + PNG }];
  if (withAudio) p.audioAssets = [{ id: 'au', name: '测试音乐.wav', categories: ['bgm', 'sfx', 'voice'],
    data: AUDIO_URL, mime: 'audio/wav', ext: 'wav', bytes: WAV.length, duration: .2 }];
  const pid = p.chapters[0].paragraphs[0].id;
  const n = (id, text, extra) => Object.assign(C.makeNode('say'), { id, text, paragraphId: pid, next: '' }, extra || {});
  const a = n('a', '第一句', { sceneMode: 'own', next: 'b',
    layers: [{ id: 'L1', asset: 'img', name: '背景', kind: 'bg', x: 0, y: 0, w: 100, h: 100,
      fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none' }],
    audio: withAudio ? { bgm: { action: 'play', audioId: 'au', volume: 1, loop: true, fadeIn: 0, fadeOut: 0 },
      sfx: [{ id: 's1', audioId: 'au', volume: 1, delay: .05 }],
      voice: { audioId: 'au', volume: 1 } } : null });
  const b = n('b', '第二句', { next: 'c', audio: withAudio ? { voice: { audioId: 'au', volume: 1 } } : null });
  const c = Object.assign(C.makeNode('end'), { id: 'c', text: '结束', paragraphId: pid,
    audio: withAudio ? { bgm: { action: 'stop', fadeOut: 0 } } : null });
  p.nodes = [a, b, c];
  assert(C.validate(p));
  return p;
}

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {},
    textContent: '', className: '', disabled: false, hidden: false, title: '',
    value: '', checked: false, onclick: null, oninput: null, onchange: null, onkeydown: null,
    listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...items) { this.children = [...items]; },
    getBoundingClientRect() { return { width: 1280, height: 720 }; },
    setAttribute() {}, focus() { this.focused = true; }, remove() {},
    addEventListener(k, fn) { (this.listeners[k] || (this.listeners[k] = [])).push(fn); }
  };
}
function harness(p, opts = {}) {
  const html = buildGameHTML(p, deps);
  const nodes = {}, audios = [], timers = [], store = {};
  const state = { block: !!opts.blockPermission, unlocked: false };
  const document = {
    getElementById(id) { return nodes[id] || (nodes[id] = makeElement('div')); },
    createElement(tag) { return makeElement(tag); },
    onkeydown: null, activeElement: null
  };
  const AudioCtor = function () {
    const el = makeElement('audio');
    Object.assign(el, { _src: '', volume: 1, loop: false, paused: true, ended: false,
      currentTime: 0, duration: 1, error: null, preload: '' });
    Object.defineProperty(el, 'src', { get() { return this._src; }, set(v) { this._src = v; } });
    el.canPlayType = () => 'probably'; el.load = () => {};
    el.play = function () {
      if (state.block && !state.unlocked) {
        return Promise.reject(Object.assign(new Error("play() failed because the user didn't interact"), { name: 'NotAllowedError' }));
      }
      this.paused = false; this.ended = false;
      const self = this;
      this._t = setInterval(() => { if (!self.paused) self.currentTime += .05; }, 40);
      timers.push(this._t);
      return Promise.resolve();
    };
    el.pause = function () { this.paused = true; clearInterval(this._t); this._t = null; };
    audios.push(el);
    return el;
  };
  const sandbox = {
    document, console, Audio: AudioCtor,
    window: { addEventListener() {} },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { if (opts.failWrite) throw new Error('QuotaExceededError'); store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false })
  };
  vm.createContext(sandbox);
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  vm.runInContext(m[1], sandbox, { filename: 'player-flow.js' });
  const h = { html, nodes, document, audios, timers, store, sandbox, saveKey: 'paper-game-' + p.id,
    allow: () => { state.block = false; state.unlocked = true; },
    status: () => sandbox.window.paperGameState(), audioStatus: () => sandbox.window.paperAudioStatus() };
  ALL_HARNESSES.push(h);
  return h;
}
const ALL_HARNESSES = [];
const keyDown = (h, key, target) => h.document.onkeydown({
  key, repeat: false, target: target || { tagName: 'BODY' }, preventDefault() {}
});
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* 1. 标题页：无存档继续禁用；开始进入首句；菜单/设置/Esc 切换 */
  {
    const h = harness(project(false));
    let st = h.status();
    assert.equal(st.state, 'title');
    assert.equal(h.nodes.continueGame.disabled, true, '无存档继续禁用');
    assert.match(h.nodes.titleNote.textContent, /还没有保存进度/);
    assert.equal(h.nodes.gameRoot.hidden, true);
    h.nodes.startGame.onclick();
    st = h.status();
    assert.equal(st.state, 'playing');
    assert.equal(h.nodes.text.textContent, '第一句');
    assert.equal(h.nodes.titleScreen.hidden, true);

    h.nodes.menuBtn.onclick();
    assert.equal(h.status().state, 'menu');
    assert.equal(h.nodes.menuOverlay.hidden, false);
    const before = h.nodes.text.textContent;
    h.nodes.scene.onclick();                            /* 菜单打开时点击舞台 */
    assert.equal(h.nodes.text.textContent, before, '菜单打开时不推进台词');
    assert.equal(h.status().i, 0);
    keyDown(h, 'Escape');
    assert.equal(h.status().state, 'playing', 'Esc 关闭菜单');
    keyDown(h, 'Escape');
    assert.equal(h.status().state, 'menu', 'Esc 打开菜单');
    h.nodes.menuSettings.onclick();
    assert.equal(h.status().state, 'settings');
    keyDown(h, 'Escape');
    assert.equal(h.status().state, 'menu', '设置里 Esc 回上一级');
    keyDown(h, 'Escape');
    assert.equal(h.status().state, 'playing', '不连续触发多个动作');

    /* 选项/表单内快捷键不抢占：检查 keydown 在 INPUT 上不推进 */
    h.nodes.menuBtn.onclick();
    h.nodes.menuResume.onclick();
    const i0 = h.status().i;
    keyDown(h, ' ', { tagName: 'INPUT' });
    assert.equal(h.status().i, i0, '输入框内空格不推进');
    keyDown(h, 'Enter', { tagName: 'BUTTON' });
    assert.equal(h.status().i, i0, '按钮上 Enter 不被全局抢走');
    console.log('  ok  标题页、开始、菜单/设置/ Esc 层级与输入防穿透');
  }

  /* 2. 存档：保存 → 返回标题 → 继续恢复节点与 trail；新游戏不覆盖 */
  {
    const h = harness(project(false));
    h.nodes.startGame.onclick();
    h.nodes.scene.onclick();                            /* a → b */
    assert.equal(h.nodes.text.textContent, '第二句');
    h.nodes.menuBtn.onclick();
    h.nodes.save.onclick();
    const raw = h.store[h.saveKey];
    assert(raw, '写入单槽存档');
    const saved = JSON.parse(raw);
    assert.deepEqual(saved, { id: 'b', trail: ['a'] }, '存档保留节点与真实 trail');

    h.nodes.menuTitle.onclick();
    assert.equal(h.status().state, 'title');
    assert.equal(h.nodes.continueGame.disabled, false, '保存后继续可用');
    await h.nodes.continueGame.onclick();
    assert.equal(h.status().state, 'playing');
    assert.equal(h.status().i, 1);
    assert.deepEqual(Array.from(h.status().trail), ['a']);
    assert.equal(h.nodes.text.textContent, '第二句', '继续回到存档句');

    h.nodes.menuBtn.onclick();
    h.nodes.menuTitle.onclick();
    h.nodes.startGame.onclick();                        /* 新游戏 */
    assert.equal(h.nodes.text.textContent, '第一句');
    assert.equal(h.store[h.saveKey], raw, '新游戏不覆盖旧存档');
    console.log('  ok  保存 / 返回标题 / 继续恢复节点与 trail；新游戏不覆盖存档');
  }

  /* 3. 坏存档：损坏、节点删除、路径失效都只禁用并保留原数据 */
  {
    const h = harness(project(false));
    const k = h.saveKey;
    h.store[k] = '{not json';
    h.nodes.menuTitle.onclick();
    assert.equal(h.nodes.continueGame.disabled, true);
    assert.match(h.nodes.titleNote.textContent, /损坏/);
    assert.equal(h.store[k], '{not json', '坏存档不被静默删除');
    assert.equal(await h.nodes.continueGame.onclick(), false);
    assert.equal(h.status().state, 'title', '坏存档不跳到别的句子');

    h.store[k] = JSON.stringify({ id: 'gone', trail: [] });
    h.nodes.menuTitle.onclick();
    assert.equal(h.nodes.continueGame.disabled, true);
    assert.match(h.nodes.titleNote.textContent, /已被删除/);

    h.store[k] = JSON.stringify({ id: 'b', trail: ['b'] });
    h.nodes.menuTitle.onclick();
    assert.equal(h.nodes.continueGame.disabled, true);
    assert.match(h.nodes.titleNote.textContent, /不是从故事开头/);

    h.store[k] = JSON.stringify({ id: 'c', trail: [] });
    h.nodes.menuTitle.onclick();
    assert.equal(h.nodes.continueGame.disabled, true);
    assert.match(h.nodes.titleNote.textContent, /缺少实际路径/, '空 trail 不能跳到后面的句子');
    console.log('  ok  损坏 / 节点删除 / 路径失效存档：中文提示、禁用继续、原数据保留');
  }

  /* 4. 写入失败：明确“未能保存”，游戏继续 */
  {
    const h = harness(project(false), { failWrite: true });
    h.nodes.startGame.onclick();
    h.nodes.scene.onclick();
    h.nodes.menuBtn.onclick();
    assert.equal(h.nodes.save.onclick(), false);
    assert.match(h.nodes.msg.textContent, /未能保存/);
    assert.match(h.nodes.menuNote.textContent, /未能保存/);
    assert.equal(h.status().state, 'menu');
    h.nodes.menuResume.onclick();
    assert.equal(h.nodes.text.textContent, '第二句', '保存失败后仍可继续游玩');
    console.log('  ok  localStorage 写入失败：提示未能保存，游戏继续');
  }

  /* 5. 空工程与结局：明确提示、不崩、结局仍可回标题 */
  {
    const empty = C.blank();
    empty.title = '空工程';
    const h = harness(empty);
    assert.equal(h.status().state, 'title');
    assert.equal(h.nodes.startGame.disabled, true, '空工程不能开始');
    assert.equal(h.nodes.continueGame.disabled, true);
    assert.equal(h.nodes.titleEmpty.hidden, false);
    assert.match(h.nodes.titleNote.textContent, /还没有可播放的剧情/);
    h.nodes.startGame.onclick();
    assert.equal(h.status().state, 'title', '空工程点击也不进入异常状态');

    const e = harness(project(false));
    e.nodes.startGame.onclick();
    e.nodes.scene.onclick();
    e.nodes.scene.onclick();                            /* 到结局 */
    assert.equal(e.nodes.text.textContent, '结束');
    e.nodes.menuBtn.onclick();
    assert.equal(e.status().state, 'menu', '结局仍可打开菜单');
    e.nodes.menuTitle.onclick();
    assert.equal(e.status().state, 'title');
    console.log('  ok  空工程与结局：明确提示、无异常状态、结局可返回标题');
  }

  /* 6. 音频：标题不播；菜单不重触发；音量不重启；返回标题清理干净 */
  {
    const h = harness(project(true));
    assert.equal(h.audios.length, 0, '标题页不创建播放任务');
    assert.match(h.nodes.audioStatus.textContent, /启用声音/);
    await h.nodes.startGame.onclick();
    assert.equal(h.audios.filter(a => a._src === AUDIO_URL && !a.paused).length >= 1, true, '开始后真实播放');
    await wait(160);                                    /* 让本句的延迟音效先触发完 */
    const plays = h.audios.length;
    h.nodes.menuBtn.onclick();
    await wait(120);
    assert.equal(h.audios.length, plays, '打开菜单不重新进入节点、不重复触发声音');
    const bgm = h.audios.filter(a => a._src === AUDIO_URL && !a.paused)[0];
    const t0 = bgm.currentTime;
    h.nodes.menuSettings.onclick();
    h.nodes.volBgm.value = '30';
    h.nodes.volBgm.oninput();
    assert(Math.abs(bgm.volume - .3) < .02, '设置里音量实时生效：' + bgm.volume);
    assert(bgm.currentTime >= t0, '调音量不重启 BGM');
    keyDown(h, 'Escape');
    assert.equal(h.status().state, 'menu');
    h.nodes.menuTitle.onclick();
    assert.equal(h.status().state, 'title');
    const st = h.audioStatus();
    assert(st && !st.bgm, '返回标题立即停止 BGM');
    assert.equal(st.pendingSfx, 0, '延迟音效任务已清理');
    assert.equal(st.retiring, 0, '没有残留淡出通道');
    const audiosAfter = h.audios.length;
    await wait(260);
    assert.equal(h.audios.length, audiosAfter, '等待后旧回调没有重新创建声音');
    assert(!h.audioStatus().bgm, '等待后旧声音不复活');
    console.log('  ok  标题静音、菜单不重触发、音量实时、返回标题清理且旧任务不复活');
  }

  /* 7. 解锁失败：无声进入、明确提示、重试只恢复 BGM 不重置剧情 */
  {
    const h = harness(project(true), { blockPermission: true });
    await h.nodes.startGame.onclick();
    assert.equal(h.status().state, 'playing', '解锁失败也允许无声游玩');
    assert.equal(h.nodes.text.textContent, '第一句');
    assert.match(h.nodes.msg.textContent, /声音未启用/);
    assert.equal(h.status().audio.bgm, null, '没有假报正在播放');
    /* 放行后点启用声音：只恢复 BGM，不重置剧情 */
    const was = h.status().i;
    h.allow();
    await h.nodes.enableSound.onclick();
    await wait(60);
    const st = h.audioStatus();
    assert(st && st.unlocked, '解锁后状态为已启用');
    assert(st.bgm && st.bgm.playing, '重试恢复当前句 BGM');
    assert.equal(h.status().i, was, '重试不重置剧情');
    console.log('  ok  解锁失败可无声游玩、不假报成功、重试不重置剧情');
  }

  /* 8. 无音频工程：设置显示“没有音频”，无误导性错误 */
  {
    const h = harness(project(false));
    h.nodes.startGame.onclick();
    h.nodes.menuBtn.onclick();
    h.nodes.menuSettings.onclick();
    assert.equal(h.nodes.audioPanel.hidden, true);
    assert.equal(h.nodes.noAudioNote.hidden, false);
    assert.match(h.nodes.settingsNote.textContent, /没有音频/);
    assert.equal(h.audioStatus(), null);
    console.log('  ok  无音频工程正常游玩，设置明确说明没有音频');
  }

  for(const h of ALL_HARNESSES){
   for(const t of h.timers)clearInterval(t);
   for(const el of h.audios){clearInterval(el._t);try{el.pause()}catch{}}
  }
  console.log('PASS: V0.6.1 title, menu, settings, save anomalies and audio lifecycle');
})().catch(e => { console.error(e); process.exit(1); });
