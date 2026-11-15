'use strict';
/* The exported HTML must stay self-contained and must run with the SAME
 * core.js / effects.js factories as the editor. We execute the generated
 * <script> in a minimal DOM stub to prove that. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildGameHTML, assertSelfContained } = require('../dist/export.js');
const { paperPlayer, paperPlayerCSS } = require('../dist/player.js');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');
const C = createVNCore();
const F = createPaperEffects();

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const deps = { player: paperPlayer, coreFactory: createVNCore, effectFactory: createPaperEffects, css: paperPlayerCSS, esc };

function project() {
  const p = C.sample();
  p.title = '离线 游戏 · 分支';
  p.assets = [{ id: 'a1', name: '背景', kind: 'bg', width: 1, height: 1, data: 'data:image/png;base64,' + PNG }];
  const first = p.nodes[0];
  first.sceneMode = 'own';
  first.layers = [{ id: 'L1', asset: 'a1', name: '背景', kind: 'bg', x: 0, y: 0, w: 100, h: 100, fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none' }];
  first.effects = [F.make('e1', 'L1', 'scale')];
  assert(C.validate(p));
  assert.deepEqual(C.analyze(p).errors, []);
  return p;
}

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {},
    textContent: '', className: '', disabled: false, onclick: null,
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...items) { this.children = [...items]; },
    getBoundingClientRect() { return { width: 1280, height: 720 }; },
    setAttribute() {}, focus() {}, remove() {}
  };
}
function runExported(html) {
  const nodes = {};
  const document = {
    getElementById(id) { return nodes[id] || (nodes[id] = makeElement('div')); },
    createElement(tag) { return makeElement(tag); },
    onkeydown: null
  };
  const store = {};
  const sandbox = {
    document, console,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false })
  };
  vm.createContext(sandbox);
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert(match, 'exported HTML embeds the player script');
  vm.runInContext(match[1], sandbox, { filename: 'exported-game.js' });
  return { nodes, document };
}

const p = project();
const html = buildGameHTML(p, deps);
assertSelfContained(html);
assert(html.includes('data:image/png;base64,' + PNG), 'images are inlined');
assert(html.includes('function createVNCore'), 'uses the editor core factory');
assert(html.includes('function createPaperEffects'), 'uses the editor effects factory');
assert(html.includes('function paperPlayer'), 'embeds the standalone player');
assert(html.includes('"options"'), 'branch data is embedded');
assert(html.includes('"effects"'), 'per-line effects are embedded');
const head = html.split('<script>')[0];
for (const local of ['file:///', 'app://', 'paper://', 'blob:', 'http://127.0.0.1', 'C:\\']) {
  assert(!head.includes(local), 'no local dependency in head: ' + local);
}
console.log('  ok  standalone HTML is self-contained with inlined images and shared factories');

const { nodes } = runExported(html);
assert.equal(nodes.title.textContent, p.title);
assert.equal(nodes.text.textContent, p.nodes[0].text);
assert.equal(nodes.layers.children.length, 1, 'scene layers rendered');
assert.equal(nodes.layers.children[0].dataset.layer, 'L1');
assert.match(nodes.layers.children[0].style.transform, /scale\(/, 'effects applied through the shared renderer');
assert.equal(nodes.back.disabled, true);
nodes.scene.onclick();                                  // advance one line
assert.equal(nodes.text.textContent, p.nodes[1].text);
assert.equal(nodes.choices.children.length, 3, 'three-way branch');
nodes.choices.children[0].onclick({ stopPropagation() {} });
assert.equal(nodes.text.textContent, p.nodes[2].text, 'choice enters a normal dialogue');
nodes.save.onclick();
assert.equal(nodes.msg.textContent, '进度已保存');
nodes.scene.onclick();
nodes.load.onclick();
assert.equal(nodes.msg.textContent, '已读取进度');
assert.equal(nodes.text.textContent, p.nodes[2].text, 'load restores the current line end-state');
console.log('  ok  exported player runs: inheritance, effects, branching, save/load');

assert.throws(() => buildGameHTML({ ...p, format: 'paper-desktop', formatVersion: 1 }, deps), /磁盘相对路径/);
const relative = C.clone(p);
delete relative.assets[0].data;
relative.assets[0].file = 'assets/images/aaaa.png';
assert.throws(() => buildGameHTML(relative, deps), /不是内嵌图片/);
const withPath = C.clone(p);
withPath.assets[0].path = 'C:\\Users\\me\\bg.png';
assert.throws(() => buildGameHTML(withPath, deps), /本地文件路径/);
assert.throws(() => assertSelfContained('<script src="core.js"></script><link rel="stylesheet" href="style.css">'), /外部脚本/);
console.log('  ok  desktop-relative paths and external resource references are rejected');

console.log('PASS: self-contained HTML export, shared core/effects runtime, branch and save/load parity');
