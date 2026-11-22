'use strict';
/*
 * V0.7.6-M3 1 GiB 级测试工程生成器。
 *
 * 原则：素材必须真实可解码、可显示、可播放；每个文件内容不同（种子不同），
 * 不用空文件、稀疏文件或重复素材凑体积。生成过程全部走流式暂存与工程存储，
 * 和用户在编辑器里导入素材的路径一致，所以脚本本身就是可复现证据。
 *
 * 用法：node scripts/make-large-project-m3.cjs --out F:/pvn-1gib-m3 [--bytes 1073741824]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const createStaging = require('../desktop/asset-staging.cjs');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();

const ARGS = process.argv.slice(2);
const argOf = (k, d) => { const i = ARGS.indexOf('--' + k); return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d; };
const OUT = path.resolve(argOf('out', 'F:/pvn-1gib-m3'));
const TARGET = Number(argOf('bytes', 1073741824));
const SEED = Number(argOf('seed', 20261123));
const IMAGE_COUNT = Number(argOf('images', 100));
const AUDIO_SECONDS = Number(argOf('seconds', 60));
const KEEP_SOURCE = ARGS.includes('--keep-source');
const ROOT = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-m3-gen-'));
const SOURCE = path.join(WORK, 'source');
const STAGING = path.join(WORK, 'staging');
fs.mkdirSync(SOURCE, { recursive: true });

function rng(seed) {
  let s = seed >>> 0;
  return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function crc32(buf) {
  const t = [];
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
/* 真实 PNG：IHDR + 随机 RGB 像素（不可压缩，避免用重复内容虚增体积）。 */
function makePng(file, w, h, seed) {
  const rand = rng(seed), rowBytes = 1 + w * 3;
  const raw = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const base = y * rowBytes; raw[base] = 0;
    for (let x = 0; x < w; x++) {
      const at = base + 1 + x * 3;
      raw[at] = (rand() * 256) | 0; raw[at + 1] = (rand() * 256) | 0; raw[at + 2] = (rand() * 256) | 0;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
  return { bytes: png.length, width: w, height: h };
}
/* 真实 PCM WAV：44.1kHz 立体声，伪随机波形；不同种子产生不同字节。 */
function makeWav(file, seconds, seed) {
  const rate = 44100, frames = seconds * rate, samples = frames * 2;
  const data = Buffer.alloc(samples * 2);
  const rand = rng(seed);
  for (let i = 0; i < samples; i++) {
    const v = Math.round((rand() * 2 - 1) * 18000);
    data.writeInt16LE(v, i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  const wav = Buffer.concat([head, data]);
  fs.writeFileSync(file, wav);
  return { bytes: wav.length, duration: seconds };
}

(async () => {
  const started = Date.now();
  const staging = createStaging({ root: STAGING });
  const imageDescriptors = [], audioDescriptors = [];
  let sourceBytes = 0;

  /* 先算一个音频文件能贡献多少，再决定需要多少个音频，保证总体积达标。 */
  const probeFile = path.join(SOURCE, 'probe.wav');
  const probe = makeWav(probeFile, AUDIO_SECONDS, SEED + 999999);
  const probeDesc = await staging.stageFile(probeFile, { kind: 'audio' });
  const audioCount = Math.max(8, Math.ceil(TARGET / probe.bytes) + 2);
  console.log('目标 ' + TARGET + ' bytes；单个音频 ' + probe.bytes + ' bytes，计划 ' + audioCount + ' 曲 + ' + IMAGE_COUNT + ' 图');

  for (let i = 0; i < IMAGE_COUNT; i++) {
    const isChar = i % 5 === 0;
    const w = isChar ? 1200 : 1600, h = isChar ? 1800 : 900;
    const file = path.join(SOURCE, (isChar ? 'char_' : 'bg_') + String(i).padStart(3, '0') + '.png');
    const info = makePng(file, w, h, SEED + i * 7919);
    sourceBytes += info.bytes;
    const d = await staging.stageFile(file, { kind: 'image', assetKind: isChar ? 'char' : 'bg' });
    imageDescriptors.push(Object.assign({}, d, { width: w, height: h }));
    fs.unlinkSync(file);                       // 暂存已落盘，立刻释放源目录空间
    if ((i + 1) % 20 === 0) console.log('  图片 ' + (i + 1) + '/' + IMAGE_COUNT);
  }
  for (let i = 0; i < audioCount; i++) {
    const file = path.join(SOURCE, 'track_' + String(i).padStart(3, '0') + '.wav');
    const info = makeWav(file, AUDIO_SECONDS, SEED + 100000 + i * 104729);
    sourceBytes += info.bytes;
    const category = i % 7 === 0 ? 'bgm' : i % 7 === 1 ? 'sfx' : 'voice';
    const d = await staging.stageFile(file, { kind: 'audio' });
    audioDescriptors.push(Object.assign({}, d, { name: 'track_' + String(i).padStart(3, '0'), categories: [category] }));
    fs.unlinkSync(file);
    if ((i + 1) % 20 === 0) console.log('  音频 ' + (i + 1) + '/' + audioCount);
  }
  fs.unlinkSync(probeFile);

  /* 组装多章节工程：背景、立绘、表情、BGM、SFX、Voice 都有真实引用。 */
  const project = C.blank();
  project.title = '1 GiB 流式素材压力测试 · M3';
  project.id = 'pvn_1gib_m3_' + SEED;
  const chapterCount = 12, paraPerChapter = 6, nodesPerPara = 8;
  project.chapters = [];
  const chars = [];
  const charImages = imageDescriptors.filter(d => d.name.startsWith('char_'));
  const bgImages = imageDescriptors.filter(d => !d.name.startsWith('char_'));
  for (let ci = 0; ci < chapterCount; ci++) {
    const chapter = { id: 'ch_big_' + ci, title: '第 ' + (ci + 1) + ' 章 · 风与回声', collapsed: false, paragraphs: [] };
    for (let pi = 0; pi < paraPerChapter; pi++) {
      const para = { id: 'pg_big_' + ci + '_' + pi, title: '段落 ' + (pi + 1), collapsed: false, nodes: [] };
      chapter.paragraphs.push(para);
      for (let ni = 0; ni < nodesPerPara; ni++) {
        const idx = ci * paraPerChapter * nodesPerPara + pi * nodesPerPara + ni;
        const n = C.makeNode(ni === nodesPerPara - 1 && pi === paraPerChapter - 1 ? 'end' : 'say');
        n.paragraphId = para.id;
        n.name = '角色 ' + (idx % 6 + 1);
        n.text = '第 ' + (ci + 1) + ' 章第 ' + (pi + 1) + ' 段，第 ' + (ni + 1) + ' 句：' + '晚风穿过走廊，书页停在尚未写完的那一行。';
        n.sceneMode = 'own';
        const bg = bgImages[idx % bgImages.length];
        const ch = charImages[idx % charImages.length];
        n.layers.push({ id: 'l_bg_' + idx, asset: bg.id, name: '背景 ' + idx, kind: 'bg', x: 0, y: 0, w: 100, h: 100,
          fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none', characterId: '', expressionId: '' });
        n.layers.push({ id: 'l_ch_' + idx, asset: ch.id, name: '立绘 ' + idx, kind: 'char', x: 28, y: 15, w: 44, h: 85,
          fit: 'contain', opacity: 100, hidden: false, locked: false, motion: 'none', characterId: '', expressionId: '' });
        const bgmA = audioDescriptors[(idx * 3) % audioDescriptors.length];
        const sfxA = audioDescriptors[(idx * 3 + 1) % audioDescriptors.length];
        const voiceA = audioDescriptors[(idx * 3 + 2) % audioDescriptors.length];
        if (ni === 0) n.audio = { bgm: { action: 'play', audioId: bgmA.id, volume: .7, loop: true, fadeIn: .5, fadeOut: .5 },
          sfx: [{ id: 's_' + idx, audioId: sfxA.id, volume: .6, delay: 0 }],
          voice: { audioId: voiceA.id, volume: .9 } };
        project.nodes.push(n);
        para.nodes.push(n.id);
      }
    }
    project.chapters.push(chapter);
  }
  for (let i = 0; i < 6; i++) {
    const expressions = [0, 1, 2].map(k => {
      const a = charImages[(i * 3 + k) % charImages.length];
      return { id: 'ex_big_' + i + '_' + k, name: '表情 ' + (k + 1), assetId: a.id };
    });
    chars.push({ id: 'c_big_' + i, name: '角色 ' + (i + 1), color: '#3f6753',
      defaultExpressionId: expressions[0].id, expressions });
  }
  project.characters = chars;
  project.assets = imageDescriptors.map(d => ({ id: d.id, name: d.name, kind: d.name.startsWith('char_') ? 'char' : 'bg',
    data: d.data, sha256: d.sha256, bytes: d.bytes, width: d.width, height: d.height, mime: 'image/png' }));
  project.audioAssets = audioDescriptors.map(d => ({ id: d.id, name: d.name, categories: d.categories,
    data: d.data, sha256: d.sha256, bytes: d.bytes, mime: 'audio/wav', ext: 'wav', duration: d.duration }));
  project.titleBackground = bgImages[0].id;
  project.titleMusic = { audioId: audioDescriptors[0].id, volume: 60, fadeIn: 1, loop: true };
  project.publish = Object.assign({}, project.publish, { gameName: '1GiB 压力测试', author: 'PaperVNStudio M3', version: '0.7.6' });

  C.validate(project);
  const store = createStore({ stagingRoot: STAGING });
  const created = store.createProject(OUT, project);
  const disk = JSON.parse(fs.readFileSync(path.join(OUT, store.MAIN_FILE), 'utf8'));
  const unique = new Map();
  for (const a of [...disk.assets, ...disk.audioAssets]) unique.set(a.sha256, a.bytes);
  let actual = 0;
  for (const bytes of unique.values()) actual += bytes;
  const report = {
    at: new Date().toISOString(), out: OUT, targetBytes: TARGET, actualAssetBytes: actual,
    meetsTarget: actual >= TARGET, images: disk.assets.length, audio: disk.audioAssets.length,
    nodes: project.nodes.length, chapters: project.chapters.length,
    uniqueHashes: unique.size, sourceBytes, generateMs: Date.now() - started,
    schema: disk.schema, runtimeJsonBytes: JSON.stringify(created.project).length,
    machine: { platform: process.platform, arch: process.arch, cpus: require('node:os').cpus().length,
      totalMem: os.totalmem(), freeMem: os.freemem(), node: process.version }
  };
  fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'release', 'large-project-m3-generation.json'), JSON.stringify(report, null, 2), 'utf8');
  if (!KEEP_SOURCE) fs.rmSync(STAGING, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  if (actual < TARGET) { console.error('素材总量没有达到目标'); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
