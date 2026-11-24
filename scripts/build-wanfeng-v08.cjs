'use strict';
/*
 * V0.8.0 · M6 验收用的《晚风经过二楼走廊》演出优化试玩版。
 *
 * 三条硬约束：
 *  1. **隔离副本**：只读取已有工程目录里的 PNG 字节，全部写入 release/wanfeng-v080/；
 *     原件与原件素材一律不写、不移动、不改名，脚本开始/结束各记一次 SHA-256 指纹做比对。
 *  2. **原始/优化对照**：同一份台词生成两个工程——before（只有台词与图层）与
 *     after（叠加舞台演出动作）。两者共用同一批素材与图层几何，差异只在 performance。
 *  3. **可独立运行**：after 直接导出单文件 HTML，不依赖本机工程目录。
 *
 * 运行：node scripts/build-wanfeng-v08.cjs
 * 产物：release/wanfeng-v080/{before,after,*.html}、release/wanfeng-v08-report.json、
 *       docs/screenshots/v080-wanfeng-scene{1,2,3}.png
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();
const PF = require('../dist/performance.js')();
const { buildPlayerHTML } = require('../dist/game-html.js');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SRC = process.env.WANFENG_SRC || 'C:/Users/Administrator/WorkBuddy/LAPTOP-O1JJ0J9M/PaperVNStudio-v0.3-source-and-AI-guide/wanfeng_alpha/projects/Wanfeng_Part1_Rehearsal';
const OUT = path.join(ROOT, 'release', 'wanfeng-v080');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { at: new Date().toISOString(), version: '0.8.0', source: SRC, sourceIntact: null, scenes: [], ok: true, problems: [] };
const bad = (m) => { report.ok = false; report.problems.push(m); console.log('  FAIL ' + m); };
const ok = (m, d) => { console.log('  ok  ' + m); if (d) report.detail = Object.assign(report.detail || {}, { [m]: d }); };

/* ---------- 素材读取（只读原件） ---------- */
function readSource() {
  const jsonPath = path.join(SRC, 'project.paper.json');
  if (!fs.existsSync(jsonPath)) throw new Error('找不到《晚风》工程：' + jsonPath + '（可用 WANFENG_SRC 指定目录）');
  const p = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return { p, jsonPath };
}
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.name === 'project.paper.json' || /\.(png|jpe?g|webp|ogg|wav|mp3)$/i.test(e.name)) {
        out[path.relative(dir, f).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}
function diffFingerprint(a, b) {
  const changed = [], missing = [], added = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) missing.push(k);
    else if (a[k] !== b[k]) changed.push(k);
  }
  for (const k of Object.keys(b)) if (!(k in a)) added.push(k);
  return { changed, missing, added, same: !changed.length && !missing.length && !added.length };
}

/* ---------- 图层几何 ---------- */
const BG = (asset, name) => ({ id: 'ly_bg', asset, name, kind: 'bg', x: 0, y: 0, w: 100, h: 100, fit: 'cover', opacity: 100, hidden: false, locked: true, motion: 'none' });
const CH = (id, asset, name, x, characterId, extra) => Object.assign({ id, asset, name, kind: 'char', x, y: 4, w: 34, h: 94, fit: 'contain', opacity: 100, hidden: false, locked: false, motion: 'none', characterId }, extra || {});
const YOU = (asset, x, extra) => CH('c_you', asset, '林悠', x == null ? 6 : x, 'lin_you', extra);
const CHE = (asset, x, extra) => CH('c_che', asset, '林澈', x == null ? 60 : x, 'lin_che', extra);
const SU = (asset, x, extra) => CH('c_su', asset, '苏雨晴', x == null ? 58 : x, 'su_yuqing', extra);

/* ---------- 台词与演出 ---------- */
let seq = 0;
const A = (type, target, params, opt) => {
  const a = PF.make('pa' + (++seq), type, target, Object.assign({ params: params || {} }, opt || {}));
  return a;
};
const root = () => ({ layers: [], perf: [] });

function script() {
  const nodes = [];
  const push = (o) => { nodes.push(o); return o; };

  /* ===== 第一章 · 清晨的相遇 ===== */
  const bgM = 'bg_home_corridor_morning';
  push({
    who: '', text: '六点二十，二楼的走廊还没完全亮起来。',
    layers: [BG(bgM, '家中二楼走廊·清晨')],
    perf: [A('camera.zoom', '', { scale: 104 }, { duration: 2.4, easing: 'linear' })]
  });
  push({
    who: '', text: '楼梯口的窗开了一条缝，风把晾着的校服下摆吹得轻轻晃。',
    layers: [BG(bgM, '家中二楼走廊·清晨')],
    perf: [A('screen.flash', '', { color: 'white' }, { duration: 0.7, mode: 'parallel' })]
  });
  push({
    who: 'lin_che', text: '鞋带。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), CHE('che_neutral', 62)],
    perf: [A('character.show', 'char:lin_che', { side: 'fade' }, { duration: 0.8, blocking: true })]
  });
  push({
    who: 'lin_you', text: '我知道。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_neutral', 4), CHE('che_neutral', 62)],
    perf: [
      A('character.show', 'char:lin_you', { side: 'left' }, { duration: 1.0, blocking: true }),
      A('character.expression', 'char:lin_you', { expressionId: 'ex_lin_you_you_annoyed' }, { duration: 0.03, mode: 'parallel' })
    ]
  });
  push({
    who: 'lin_che', text: '你昨天也这么说。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_neutral', 4), CHE('che_smile', 62)],
    perf: [A('character.expression', 'char:lin_che', { expressionId: 'ex_lin_che_che_smile' }, { duration: 0.03, mode: 'parallel' })]
  });
  push({
    who: 'lin_you', text: '那你走前面，别看。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_neutral', 4), CHE('che_smile', 62)],
    perf: [A('character.move', 'char:lin_you', { x: 14, y: 4 }, { duration: 0.7, easing: 'easeOut' })]
  });
  push({
    who: '', text: '他停在楼梯中间，回头看了她一眼，什么也没说。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_neutral', 14), CHE('che_smile', 54)],
    perf: [
      A('character.move', 'char:lin_che', { x: 48, y: 4 }, { duration: 0.8, easing: 'easeInOut' }),
      A('camera.zoom', '', { scale: 112 }, { duration: 1.2, easing: 'easeInOut', mode: 'parallel' })
    ]
  });
  push({
    who: 'lin_you', text: '……等一下。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_neutral', 22), CHE('che_serious', 48)],
    perf: [A('character.scale', 'char:lin_you', { scale: 108 }, { duration: 0.9, easing: 'easeOut' })]
  });
  push({
    who: 'lin_che', text: '嗯。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_neutral', 22), CHE('che_serious', 48)],
    perf: [A('character.bob', 'char:lin_che', { amplitude: 1.4, times: 1 }, { duration: 0.7 })]
  });
  push({
    who: '', text: '晨光从走廊尽头推过来，把两个人的影子拉得很长。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_smile', 22), CHE('che_neutral', 48)],
    perf: [
      A('camera.move', '', { x: -2, y: 1 }, { duration: 1.6, easing: 'linear' }),
      A('character.expression', 'char:lin_you', { expressionId: 'ex_lin_you_you_smile' }, { duration: 0.03, mode: 'parallel' })
    ]
  });
  push({
    who: 'lin_you', text: '走吧。',
    layers: [BG(bgM, '家中二楼走廊·清晨'), YOU('you_smile', 22), CHE('che_neutral', 48)],
    perf: [
      A('character.hide', 'char:lin_you', { mode: 'out' }, { duration: 0.8, blocking: true }),
      A('character.hide', 'char:lin_che', { mode: 'out' }, { duration: 0.8, blocking: true, mode: 'parallel' })
    ]
  });
  push({
    who: '', text: '楼梯的木扶手被太阳晒得发暖，风从楼梯口慢慢下来。',
    layers: [BG(bgM, '家中二楼走廊·清晨')],
    perf: [
      A('camera.move', '', { x: 0, y: -1 }, { duration: 1.8, easing: 'linear' }),
      A('camera.zoom', '', { scale: 102 }, { duration: 1.8, easing: 'linear', mode: 'parallel' })
    ]
  });
  push({
    who: '', text: '门在身后合上，走廊重新安静下来。',
    layers: [BG(bgM, '家中二楼走廊·清晨')],
    perf: [
      A('screen.fade', '', { to: 100, color: 'black' }, { duration: 0.6 }),
      A('screen.fade', '', { to: 0, color: 'black' }, { duration: 0.6, mode: 'after' })
    ]
  });

  /* ===== 第二章 · 放学后的走廊 ===== */
  const bgS = 'bg_school';
  push({
    who: '', text: '放学后的走廊比早上吵，风扇把卷子的一角掀起来又放下。',
    layers: [BG(bgS, '学校二楼走廊')],
    perf: [
      A('background.change', 'bg', { assetId: bgS, transition: 'crossfade' }, { duration: 1.0, blocking: true }),
      A('camera.zoom', '', { scale: 106 }, { duration: 1.4, easing: 'linear', mode: 'parallel' })
    ]
  });
  push({
    who: 'su_yuqing', text: '林悠，你的英语笔记借我抄一节课。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_base', 60), YOU('you_serious', 6)],
    perf: [
      A('character.show', 'char:su_yuqing', { side: 'right' }, { duration: 0.9, blocking: true }),
      A('character.show', 'char:lin_you', { side: 'fade' }, { duration: 0.5, mode: 'parallel' })
    ]
  });
  push({
    who: 'lin_you', text: '只借一节课。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_base', 60), YOU('you_serious', 6)],
    perf: [A('character.scale', 'char:lin_you', { scale: 104 }, { duration: 0.6 })]
  });
  push({
    who: 'su_yuqing', text: '两节。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_base', 60), YOU('you_serious', 6)],
    perf: [A('character.move', 'char:su_yuqing', { x: 48, y: 4 }, { duration: 0.7, easing: 'easeOut' })]
  });
  push({
    who: 'lin_you', text: '一节半。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_base', 48), YOU('you_serious', 6)],
    perf: [A('character.move', 'char:lin_you', { x: 16, y: 4 }, { duration: 0.7, easing: 'easeOut' })]
  });
  push({
    who: 'su_yuqing', text: '成交。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_shy', 48), YOU('you_serious', 16)],
    perf: [
      A('character.expression', 'char:su_yuqing', { expressionId: 'ex_su_yuqing_su_yuqing_summer_uniform_shy' }, { duration: 0.03 }),
      A('character.bob', 'char:su_yuqing', { amplitude: 1.2, times: 1 }, { duration: 0.6, mode: 'parallel' })
    ]
  });
  push({
    who: '', text: '风扇转过去，纸角压下去又翘起来。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_shy', 48), YOU('you_serious', 16)],
    perf: [A('camera.move', '', { x: -1, y: 0 }, { duration: 1.4, easing: 'linear' })]
  });
  push({
    who: '', text: '她把笔记递过去，指腹在封面上停了一下。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_shy', 48), YOU('you_serious', 16)],
    perf: [A('camera.zoom', '', { scale: 114 }, { duration: 1.8, easing: 'easeInOut' })]
  });
  push({
    who: 'su_yuqing', text: '你哥今天又没等你？',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_shy', 48), YOU('you_serious', 16)],
    perf: [A('camera.move', '', { x: 3, y: 0 }, { duration: 1.2 })]
  });
  push({
    who: 'lin_you', text: '他在车棚。',
    layers: [BG(bgS, '学校二楼走廊'), SU('su_yuqing_summer_uniform_shy', 48), YOU('you_smile', 16)],
    perf: [A('character.expression', 'char:lin_you', { expressionId: 'ex_lin_you_you_smile' }, { duration: 0.03 })]
  });
  push({
    who: '', text: '窗外的桂花落了一地，风一过就翻起来。',
    layers: [BG('bg_road', '上学路·桂花'), SU('su_yuqing_summer_uniform_shy', 48), YOU('you_smile', 16)],
    perf: [
      A('screen.flash', '', { color: 'white' }, { duration: 0.9, blocking: true }),
      A('background.change', 'bg', { assetId: 'bg_road', transition: 'fadeWhite' }, { duration: 1.0, mode: 'parallel' })
    ]
  });
  push({
    who: 'su_yuqing', text: '那我们一起走。',
    layers: [BG('bg_road', '上学路·桂花'), SU('su_yuqing_summer_uniform_shy', 46), YOU('you_smile', 18)],
    perf: [
      A('character.move', 'char:su_yuqing', { x: 40, y: 4 }, { duration: 0.9 }),
      A('character.move', 'char:lin_you', { x: 24, y: 4 }, { duration: 0.9, mode: 'parallel' })
    ]
  });
  push({
    who: '', text: '走廊尽头，蝉声忽然大了一阵。',
    layers: [BG('bg_road', '上学路·桂花'), SU('su_yuqing_summer_uniform_shy', 40), YOU('you_smile', 24)],
    perf: [A('screen.shake', '', { strength: 1.2 }, { duration: 0.7 })]
  });

  /* ===== 第三章 · 夜晚的房间 ===== */
  const bgN = 'bg_home_corridor_night';
  push({
    who: '', text: '夜里十点，二楼的走廊只亮着一盏灯。',
    layers: [BG(bgN, '家中二楼走廊·夜')],
    perf: [
      A('background.change', 'bg', { assetId: bgN, transition: 'fadeBlack' }, { duration: 1.2, blocking: true }),
      A('screen.fade', '', { to: 0, color: 'black' }, { duration: 0.8, mode: 'parallel' })
    ]
  });
  push({
    who: 'lin_che', text: '灯关不关？',
    layers: [BG(bgN, '家中二楼走廊·夜'), CHE('che_neutral', 60)],
    perf: [A('character.show', 'char:lin_che', { side: 'right' }, { duration: 1.0, blocking: true })]
  });
  push({
    who: 'lin_you', text: '再等十分钟。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_neutral', 8), CHE('che_neutral', 60)],
    perf: [A('character.show', 'char:lin_you', { side: 'left' }, { duration: 1.0, blocking: true })]
  });
  push({
    who: 'lin_che', text: '你每次都这么说。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_neutral', 8), CHE('che_serious', 60)],
    perf: [
      A('character.expression', 'char:lin_che', { expressionId: 'ex_lin_che_che_serious' }, { duration: 0.03 }),
      A('character.move', 'char:lin_che', { x: 54, y: 4 }, { duration: 0.8, mode: 'parallel' })
    ]
  });
  push({
    who: '', text: '他把一杯温水放在她手边，杯壁上很快起了一层雾。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_neutral', 8), CHE('che_serious', 54)],
    perf: [A('camera.zoom', '', { scale: 110 }, { duration: 1.6, easing: 'easeInOut' })]
  });
  push({
    who: 'lin_you', text: '哥。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_serious', 8), CHE('che_serious', 54)],
    perf: [A('character.expression', 'char:lin_you', { expressionId: 'ex_lin_you_you_serious' }, { duration: 0.03 })]
  });
  push({
    who: 'lin_che', text: '嗯。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_serious', 8), CHE('che_serious', 54)],
    perf: [A('character.bob', 'char:lin_che', { amplitude: 1.6, times: 1 }, { duration: 0.8 })]
  });
  push({
    who: 'lin_you', text: '明天早上，你等我一下。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_serious', 16), CHE('che_smile', 50)],
    perf: [
      A('character.move', 'char:lin_you', { x: 16, y: 4 }, { duration: 1.0 }),
      A('character.expression', 'char:lin_che', { expressionId: 'ex_lin_che_che_smile' }, { duration: 0.03, mode: 'parallel' })
    ]
  });
  push({
    who: 'lin_che', text: '我一直都在等。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_serious', 16), CHE('che_smile', 50)],
    perf: [A('character.scale', 'char:lin_che', { scale: 106 }, { duration: 1.0, easing: 'easeInOut' })]
  });
  push({
    who: '', text: '她没有再说什么，只把那杯水握了很久。',
    layers: [BG(bgN, '家中二楼走廊·夜'), YOU('you_serious', 16), CHE('che_smile', 50)],
    perf: [
      A('character.opacity', 'char:lin_you', { opacity: 88 }, { duration: 2.0, easing: 'linear' }),
      A('camera.zoom', '', { scale: 106 }, { duration: 2.0, easing: 'linear', mode: 'parallel' })
    ]
  });
  push({
    who: '', text: '灯关了。走廊慢慢暗下去，风从窗缝里进来，把门轻轻碰上。',
    layers: [BG('bg_home', '林家·餐桌')],
    perf: [
      A('screen.fade', '', { to: 100, color: 'black' }, { duration: 1.0, blocking: true }),
      A('background.change', 'bg', { assetId: 'bg_home', transition: 'cut' }, { duration: 0.05, mode: 'after' }),
      A('screen.fade', '', { to: 0, color: 'black' }, { duration: 1.2, mode: 'after' })
    ]
  });

  return nodes;
}

/* ---------- 工程装配 ---------- */
const USED_ASSETS = new Set([
  'bg_home_corridor_morning', 'bg_school', 'bg_road', 'bg_home_corridor_night', 'bg_home',
  'you_neutral', 'you_smile', 'you_serious', 'you_annoyed',
  'che_neutral', 'che_smile', 'che_serious',
  'su_yuqing_summer_uniform_base', 'su_yuqing_summer_uniform_shy'
]);
const USED_CHARS = ['lin_you', 'lin_che', 'su_yuqing'];

function buildProject(src, withPerformance) {
  const p = C.blank();
  p.title = '晚风经过二楼走廊 · 演出优化试玩';
  p.schema = 6;

  /* 素材：只保留用到的位图，字节原样复制成 data URI */
  const byId = new Map(src.assets.map((a) => [a.id, a]));
  const assets = [];
  for (const id of USED_ASSETS) {
    const a = byId.get(id);
    if (!a) throw new Error('源工程缺少素材：' + id);
    const file = path.join(SRC, a.file);
    if (!fs.existsSync(file)) throw new Error('源素材文件缺失：' + file);
    const bytes = fs.readFileSync(file);
    assets.push({ id: a.id, name: a.name, kind: a.kind, data: 'data:image/png;base64,' + bytes.toString('base64'), width: a.width, height: a.height, bytes: bytes.length });
  }
  p.assets = assets;
  const have = new Set(assets.map((a) => a.id));

  /* 角色：表情表裁到实际带进包内的素材，避免指向缺失素材 */
  p.characters = USED_CHARS.map((cid) => {
    const c = src.characters.find((x) => x.id === cid);
    const expressions = (c.expressions || []).filter((e) => have.has(e.assetId));
    return { id: c.id, name: c.name, color: c.color, defaultExpressionId: expressions[0] ? expressions[0].id : '', expressions };
  });

  /* 章节：一场一章，便于在编辑器里核对 */
  const titles = ['第一章 · 清晨的相遇', '第二章 · 放学后的走廊', '第三章 · 夜晚的房间'];
  p.chapters = titles.map((t) => ({ id: 'ch_' + C.id(), title: t, collapsed: false, paragraphs: [{ id: 'pg_' + C.id(), title: '场景', collapsed: false }] }));

  const lines = script();
  const nodes = [];
  const perScene = [13, 11, 12];
  let scene = 0, count = 0;
  lines.forEach((line) => {
    if (count >= perScene[scene] && scene < perScene.length - 1) { count = 0; scene++; }
    count++;
    const ch = p.chapters[scene];
    const n = C.makeNode('say');
    n.name = line.who ? '' : '旁白';
    n.text = line.text;
    n.sceneMode = 'own';
    if (line.who) n.speakerId = line.who;
    n.layers = line.layers.map((l) => ({ ...l }));
    n.paragraphId = ch.paragraphs[0].id;
    n.performance = withPerformance && line.perf.length ? { version: 1, actions: line.perf.map((a) => ({ ...a })) } : null;
    nodes.push(n);
  });
  nodes.forEach((n, i) => { if (i + 1 < nodes.length) n.next = nodes[i + 1].id; });

  /* 分支：第二章结尾给一个选择，两条路都汇合到第三章。
     演出验收要求覆盖「分支」——两条路台词与舞台状态都不同，最后回到同一句，
     这样存档/读档、跳过与终态一致才有真正的分支路径可验。 */
  const lastOfScene2 = nodes[perScene[0] + perScene[1] - 1];
  const firstOfScene3 = nodes[perScene[0] + perScene[1]];
  const pg2 = lastOfScene2.paragraphId;
  const mkSay = (line) => {
    const n = C.makeNode('say');
    n.name = line.who ? '' : '旁白';
    n.text = line.text;
    n.sceneMode = 'own';
    if (line.who) n.speakerId = line.who;
    n.layers = line.layers.map((l) => ({ ...l }));
    n.paragraphId = pg2;
    n.performance = withPerformance && line.perf.length ? { version: 1, actions: line.perf.map((a) => ({ ...a })) } : null;
    return n;
  };
  const choice = C.makeNode('choice');
  choice.name = '';
  choice.text = '走廊尽头还留着一点风，要先走哪一边？';
  choice.sceneMode = 'own';
  choice.paragraphId = pg2;
  choice.layers = [BG('bg_road', '上学路·桂花'), SU('su_yuqing_summer_uniform_shy', 40), YOU('you_smile', 24)];
  choice.performance = null;
  const branchA = mkSay({
    who: 'lin_you', text: '那就一起走。',
    layers: [BG('bg_road', '上学路·桂花'), SU('su_yuqing_summer_uniform_shy', 36), YOU('you_smile', 20)],
    perf: [
      A('character.move', 'char:su_yuqing', { x: 32, y: 4 }, { duration: 1.0, easing: 'easeOut' }),
      A('character.move', 'char:lin_you', { x: 16, y: 4 }, { duration: 1.0, easing: 'easeOut', mode: 'parallel' })
    ]
  });
  const branchB = mkSay({
    who: 'lin_you', text: '我先去车棚找他。',
    layers: [BG('bg_road', '上学路·桂花'), YOU('you_neutral', 24)],
    perf: [
      A('character.hide', 'char:su_yuqing', { mode: 'fade' }, { duration: 0.6, blocking: true }),
      A('character.expression', 'char:lin_you', { expressionId: 'ex_lin_you_you_neutral' }, { duration: 0.03, mode: 'parallel' })
    ]
  });
  branchA.next = firstOfScene3.id;
  branchB.next = firstOfScene3.id;
  choice.options = [
    { id: 'opt_' + C.id(), text: '和她一起走', target: branchA.id },
    { id: 'opt_' + C.id(), text: '先去车棚找林澈', target: branchB.id }
  ];
  lastOfScene2.next = choice.id;
  nodes.splice(perScene[0] + perScene[1], 0, choice, branchA, branchB);

  p.nodes = nodes;
  C.validate(p);
  return p;
}

/* 读完一句需要的时间：中文按 0.26 秒/字，另加 0.8 秒停手 */
function readingSeconds(text) { return text.replace(/\s/g, '').length * 0.26 + 0.8; }
function playthroughSeconds(p, autoAdvance) {
  let t = 0;
  for (const n of p.nodes) {
    const acts = n.performance && n.performance.actions ? n.performance.actions : [];
    const perfTime = acts.length ? PF.blockUntil(acts) : 0;
    t += Math.max(readingSeconds(n.text), perfTime + 0.4);
  }
  return t;
}

/* ---------- 真实窗口取证 ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
async function httpJson(url, ms = 1500) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await (await fetch(url, { signal: ctl.signal })).json(); } finally { clearTimeout(t); }
}
async function waitPage(port, match, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await httpJson('http://127.0.0.1:' + port + '/json/list').catch(() => []);
    const p = (Array.isArray(list) ? list : []).find((x) => x.type === 'page' && match(x.url || ''));
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(250);
  }
  return null;
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP 超时')), 12000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text); return r.result && r.result.value; };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; };
  return { send, ev, shot, close: () => { try { ws.close(); } catch {} } };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const before = fingerprint(SRC);
  console.log('[1/6] 读取源工程（只读）：' + SRC);

  const { p: src } = readSource();
  const srcInfo = { nodes: src.nodes.length, assets: src.assets.length, chapters: (src.chapters || []).length, characters: (src.characters || []).length };

  /* 隔离副本：把用到的素材单独落到 release 下，原件保持不动 */
  const isoDir = path.join(OUT, 'source-copy');
  fs.mkdirSync(path.join(isoDir, 'assets', 'images'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'project.paper.json'), path.join(isoDir, 'project.paper.json'));
  const copied = [];
  for (const a of src.assets) {
    if (!USED_ASSETS.has(a.id)) continue;
    const from = path.join(SRC, a.file);
    const to = path.join(isoDir, 'assets', 'images', path.basename(a.file));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(a.file);
  }
  report.isolation = { dir: path.relative(ROOT, isoDir).replace(/\\/g, '/'), copiedAssets: copied.length, sourceNodes: srcInfo.nodes };
  ok('隔离副本（' + copied.length + ' 个素材，原件未改动）', report.isolation);

  console.log('[2/6] 生成 before / after 两个工程');
  const pBefore = buildProject(src, false);
  const pAfter = buildProject(src, true);
  /* 导出必须在 createProject 之前：落盘会把 data 改写成 paper:// 受控地址，
     而单文件试玩版要求素材完全内嵌。 */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const htmlAfter = buildPlayerHTML(pAfter, esc);
  const htmlBefore = buildPlayerHTML(pBefore, esc);
  const store = createStore();
  const dirBefore = path.join(OUT, 'before');
  const dirAfter = path.join(OUT, 'after');
  for (const d of [dirBefore, dirAfter]) {
    /* 只清自己上一次的产物：路径必须落在 release/wanfeng-v080 之下 */
    if (path.resolve(d).startsWith(path.resolve(OUT) + path.sep)) fs.rmSync(d, { recursive: true, force: true });
  }
  store.createProject(dirBefore, pBefore);
  store.createProject(dirAfter, pAfter);
  const secBefore = playthroughSeconds(pBefore);
  const secAfter = playthroughSeconds(pAfter);
  const perfCount = pAfter.nodes.reduce((n, x) => n + ((x.performance && x.performance.actions) ? x.performance.actions.length : 0), 0);
  report.duration = { beforeSeconds: Math.round(secBefore), afterSeconds: Math.round(secAfter), nodes: pAfter.nodes.length, performanceActions: perfCount };
  /* 分支信息交给后续验收脚本：不靠猜下标，直接读工程结构 */
  const choiceNode = pAfter.nodes.find((x) => x.type === 'choice');
  report.branch = choiceNode ? {
    nodeId: choiceNode.id, index: pAfter.nodes.indexOf(choiceNode),
    text: choiceNode.text,
    options: choiceNode.options.map((o) => ({ text: o.text, target: o.target, targetIndex: pAfter.nodes.findIndex((n) => n.id === o.target) }))
  } : null;
  ok('工程生成：' + pAfter.nodes.length + ' 句 / ' + perfCount + ' 个演出动作 / 预计 ' + Math.round(secAfter) + ' 秒', report.duration);

  console.log('[3/6] 导出可独立运行的单文件试玩版');
  const fileAfter = path.join(OUT, '晚风经过二楼走廊·演出优化版.html');
  const fileBefore = path.join(OUT, '晚风经过二楼走廊·原始对照版.html');
  fs.writeFileSync(fileAfter, htmlAfter, 'utf8');
  fs.writeFileSync(fileBefore, htmlBefore, 'utf8');
  const hasPerf = /createPaperPerformance/.test(htmlAfter) && /character\.show/.test(htmlAfter);
  const scriptTags = (htmlAfter.match(/<script/g) || []).length;
  report.exports = {
    after: { file: path.relative(ROOT, fileAfter).replace(/\\/g, '/'), bytes: Buffer.byteLength(htmlAfter), scriptTags, hasPerf },
    before: { file: path.relative(ROOT, fileBefore).replace(/\\/g, '/'), bytes: Buffer.byteLength(htmlBefore) }
  };
  if (!hasPerf || scriptTags !== 1) bad('单文件导出缺少演出运行时或出现多个 <script>');
  else ok('单文件试玩版：' + (Buffer.byteLength(htmlAfter) / 1048576).toFixed(1) + ' MB / 单 script / 含演出运行时', report.exports);

  console.log('[4/6] 真实窗口截图（三个场景）');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-wanfeng-v08-'));
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: dirAfter, items: [{ path: dirAfter, title: pAfter.title, openedAt: new Date().toISOString() }]
  }));

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData], { cwd: ROOT, stdio: 'ignore', env });
  let editor = null, preview = null;
  try {
    const page = await waitPage(port, (u) => u.startsWith('paper://app/'));
    if (!page) throw new Error('编辑器窗口未出现');
    editor = await connect(page.webSocketDebuggerUrl);
    for (let i = 0; i < 120; i++) { if (await editor.ev(`!!window.__pvnM3 && document.querySelectorAll('#list .node').length > 0`)) break; await sleep(250); }
    await editor.ev(`document.querySelector('#fullPreview').click()`);
    const previewPage = await waitPage(port, (u) => u.startsWith('pvres://'), 60000);
    if (!previewPage) throw new Error('预览窗口未出现');
    preview = await connect(previewPage.webSocketDebuggerUrl);
    for (let i = 0; i < 150; i++) { if (await preview.ev(`!!document.getElementById('startGame')`)) break; await sleep(200); }
    await preview.ev(`document.getElementById('startGame').click()`);
    await sleep(400);

    /* 走完整段：每句先结算演出（若在演出中），再进入下一句；到指定下标截图 */
    const marks = [
      { at: 3, name: '清晨的相遇', file: 'v080-wanfeng-scene1.png' },
      { at: 20, name: '放学后的走廊', file: 'v080-wanfeng-scene2.png' },
      { at: 34, name: '夜晚的房间', file: 'v080-wanfeng-scene3.png' }
    ];
    const shots = [];
    /* 一次只前进一句：若正在播阻塞演出，先点一下把它结算到终态，再点一下才进下一句。 */
    const stepOnce = async () => {
      /* 分支节点不响应「点舞台」：先点第一个选项走过去 */
      const hasChoice = await preview.ev(`document.querySelectorAll('#choices button').length`);
      if (hasChoice) {
        await preview.ev(`document.querySelectorAll('#choices button')[0].click()`);
        await sleep(400);
        return;
      }
      const hint = await preview.ev(`document.getElementById('hint').textContent`);
      if (/演出中/.test(hint)) { await preview.ev(`document.getElementById('scene').click()`); await sleep(90); }
      await preview.ev(`document.getElementById('scene').click()`);
      await sleep(240);
    };
    for (const mark of marks) {
      for (let guard = 0; guard < 80; guard++) {
        const st = await preview.ev(`window.paperGameState()`);
        if (!st || st.i >= mark.at) break;
        await stepOnce();
      }
      await sleep(900);
      const st = await preview.ev(`window.paperGameState()`);
      if (!st || st.i !== mark.at) throw new Error(mark.name + ' 没有停在目标句：' + JSON.stringify(st));
      const stage = await preview.ev(`(() => {
        const box = document.getElementById('layers');
        const r = box.getBoundingClientRect();
        const cam = new DOMMatrix(getComputedStyle(box).transform);
        const layers = [...box.querySelectorAll('.visual-layer')].map(w => {
          const inner = w.querySelector('.pf-frame');
          const img = w.querySelector('img');
          return { layer: w.dataset.layer, src: img ? img.src.slice(-24) : '', display: getComputedStyle(w).display,
                   opacity: inner ? Number(getComputedStyle(inner).opacity) : 1, transform: inner ? inner.style.transform : '' };
        });
        return { camera: [cam.a, cam.e, cam.f], layers, w: Math.round(r.width), h: Math.round(r.height),
                 text: document.getElementById('text').textContent, who: document.getElementById('who').textContent };
      })()`);
      const file = path.join(SHOTS, mark.file);
      await preview.shot(file);
      shots.push({ scene: mark.name, node: st.i, shot: path.relative(ROOT, file).replace(/\\/g, '/'), camera: stage.camera, layers: stage.layers, text: stage.text });
      ok('场景截图：' + mark.name + '（' + stage.w + '×' + stage.h + '）');
    }
    report.scenes = shots;

    /* 优化前后的同一句对照：before 工程没有演出，舞台保持布局位置 */
    await editor.ev(`window.PaperHost.closePreview()`);
    await sleep(300);
    const sameNode = await editor.ev(`(() => {
      const n = p.nodes[3];
      const ls = C.stage(p, n.id, []);
      return { acts: (n.performance && n.performance.actions || []).length, layers: ls.map(l => l.id + '@' + l.x + '%'), text: n.text };
    })()`);
    report.contrast = { node: sameNode, beforeActions: 0, afterActions: sameNode.acts };

    console.log('[5/6] 源工程指纹比对');
    const after = fingerprint(SRC);
    const diff = diffFingerprint(before, after);
    report.sourceIntact = diff.same;
    if (!diff.same) bad('源工程被改动：' + JSON.stringify(diff));
    else ok('源工程与源素材未被修改（' + Object.keys(before).length + ' 个文件指纹一致）');

    console.log('[6/6] 写报告');
    report.files = {
      beforeProject: path.relative(ROOT, dirBefore).replace(/\\/g, '/'),
      afterProject: path.relative(ROOT, dirAfter).replace(/\\/g, '/'),
      trialAfter: report.exports.after.file,
      trialBefore: report.exports.before.file,
      screenshots: shots.map((s) => s.shot)
    };
    fs.writeFileSync(path.join(ROOT, 'release', 'wanfeng-v08-report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' — ' + (report.ok ? '晚风演出试玩版构建完成' : report.problems.join('；')));
  } catch (e) {
    bad(e.message);
  } finally {
    if (preview) preview.close();
    if (editor) editor.close();
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    fs.writeFileSync(path.join(ROOT, 'release', 'wanfeng-v08-report.json'), JSON.stringify(report, null, 2), 'utf8');
    process.exit(report.ok ? 0 : 1);
  }
})();
