'use strict';
/* 合成大型工程：用于验证 V0.7.4 预览与导出不再受素材总量限制。
 * 生成的是噪声 PNG（压缩率低），所以体积接近真实大工程的量级。
 *
 * 用法：node scripts/make-large-project.cjs --out "F:/tmp/Big" --images 75 --w 1920 --h 1080 --nodes 48
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { crc32 } = require('./game-export-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const OUT = path.resolve(arg('out', path.join(ROOT, '..', 'pvn-large-project')));
const COUNT = Number(arg('images', 75));
const W = Number(arg('w', 1920));
const H = Number(arg('h', 1080));
const NODES = Number(arg('nodes', 48));
const OST = arg('ost', 'F:/Wanfeng-Demo/素材交付/Wanfeng_OST_Vol1_Release');

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function noisePng(w, h, seed) {
  const stride = w * 4 + 1;
  /* 真随机像素：压缩率接近 0，体积才能贴近真实美术资源，而不是被 zlib 压成几十分之一。 */
  const raw = Buffer.alloc(stride * h);
  crypto.randomFillSync(raw);
  for (let y = 0; y < h; y++) raw[y * stride] = 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const dataUrl = (mime, buf) => 'data:' + mime + ';base64,' + buf.toString('base64');

const store = require(path.join(ROOT, 'desktop', 'project-store.cjs'))();

const assets = [];
const characters = [];
let seed = 1;

/* 19 张背景 + 31 张立绘（7 位角色分摊），其余作为未引用的备用素材。 */
for (let i = 0; i < COUNT; i++) {
  const isBg = i < 19;
  const buf = noisePng(W, H, seed++);
  const id = 'big_' + String(i + 1).padStart(3, '0');
  assets.push({
    id, name: (isBg ? '背景 ' : '立绘 ') + (i + 1), kind: isBg ? 'bg' : 'char',
    width: W, height: H, data: dataUrl('image/png', buf)
  });
}

/* 7 位角色，31 张立绘里前 24 张做成表情；其余留在素材库但不引用。 */
const charAssets = assets.filter(a => a.kind === 'char');
for (let c = 0; c < 7; c++) {
  const from = c * 4;
  const expressions = [];
  for (let k = 0; k < 4; k++) {
    const a = charAssets[from + k];
    if (!a) break;
    expressions.push({ id: 'ex_' + c + '_' + k, name: '表情 ' + (k + 1), assetId: a.id });
  }
  characters.push({ id: 'ch_' + c, name: '角色 ' + (c + 1), color: '#3f6753',
    defaultExpressionId: expressions[0] ? expressions[0].id : '', expressions });
}

const chapters = [];
const paragraph = { id: 'pg_big', title: '大型工程段落', collapsed: false };
const nodes = [];
for (let i = 0; i < NODES; i++) {
  const bg = assets[i % 19];
  const ch = charAssets[(i * 3) % Math.min(24, charAssets.length)];
  const node = {
    id: 'big_n' + String(i + 1).padStart(3, '0'),
    type: 'say', name: i % 3 === 0 ? '角色 1' : '', text: '第 ' + (i + 1) + ' 句：用于验证大工程预览与资源按需加载。',
    next: null, effects: [], sceneMode: 'own',
    layers: [
      { id: 'l_bg', asset: bg.id, name: bg.name, kind: 'bg', x: 0, y: 0, w: 100, h: 100, opacity: 100, hidden: false, locked: false, fit: 'cover', motion: 'none' },
      { id: 'l_ch', asset: ch.id, name: ch.name, kind: 'char', x: 55, y: 10, w: 30, h: 90, opacity: 100, hidden: false, locked: false, fit: 'contain', motion: 'none', characterId: 'ch_' + ((i * 3) % 7) }
    ],
    paragraphId: paragraph.id, speakerId: '', expressionId: '', cast: [],
    audio: i === 0 ? { bgm: { action: 'play', audioId: 'big_ost_1', volume: 0.8, loop: true, fadeIn: 0.8, fadeOut: 0.8 }, sfx: [], voice: null } : null
  };
  nodes.push(node);
}
chapters.push({ id: 'ch_big', title: '大型工程', paragraphs: [paragraph] });

/* 音频：复用正式 OST，避免重新编码。 */
const audioAssets = [];
if (fs.existsSync(path.join(OST, 'BGM'))) {
  const files = fs.readdirSync(path.join(OST, 'BGM')).filter(f => /\.ogg$/i.test(f));
  files.forEach((f, i) => {
    const buf = fs.readFileSync(path.join(OST, 'BGM', f));
    audioAssets.push({
      id: 'big_ost_' + (i + 1), name: f.replace(/\.ogg$/i, ''), categories: ['bgm'],
      mime: 'audio/ogg', ext: 'ogg', bytes: buf.length, duration: 40,
      data: dataUrl('audio/ogg', buf),
      meta: { category: '场景 BGM', moodTags: ['测试'], scene: '合成工程', trackId: 'big_' + f }
    });
  });
}

const project = {
  schema: 5, id: 'big-project-v074', title: '大型工程 · 200MB 级', titleBackground: assets[0].id,
  publish: { gameName: '大型工程预览测试', author: '纸间测试组', version: '0.7.4', copyright: '', icon: null,
    window: { width: 1280, height: 840, resizable: true, mode: 'window' }, releaseId: 'qa-large-v074' },
  assets, audioAssets, nodes, presets: [], characters, chapters,
  titleMusic: audioAssets.length ? { audioId: audioAssets[0].id, volume: 80, fadeIn: 1.2, loop: true } : null
};

fs.mkdirSync(OUT, { recursive: true });
const created = store.createProject(OUT, project);

let bytes = 0, files = 0;
for (const rel of ['assets/images', 'assets/audio']) {
  const dir = path.join(OUT, rel);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) { bytes += fs.statSync(path.join(dir, f)).size; files++; }
}

console.log(JSON.stringify({
  out: OUT, root: created.root || OUT,
  images: assets.length, audios: audioAssets.length, nodes: nodes.length,
  diskFiles: files, diskBytes: bytes, diskMB: +(bytes / 1048576).toFixed(1)
}, null, 1));
