'use strict';
/*
 * V0.8.1 · 《晚风》音频演出优化版（隔离副本）。
 *
 * 在 V0.8.0 的演出工程上叠加音频动作：BGM 淡入 / 交叉淡化 / 循环区间 /
 * 配音 Ducking / 音效，并生成可直接试听的单文件 HTML。
 *
 * 原则：
 *  - 只读取，不写回 V0.8.0 工程与原始素材；新工程落在 release/wanfeng-v081/audio。
 *  - BGM 取自仓库自带的《晚风》OST（dist/samples/wanfeng-ch01，6 首 OGG）。
 *  - 音效与「配音」是脚本合成的 WAV（占位），文件名里写明，避免被当成真实配音。
 *
 * 用法：node scripts/build-wanfeng-audio.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();
const PF = require('../dist/performance.js')();
const { buildPlayerHTML } = require('../dist/game-html.js');

const ROOT = path.resolve(__dirname, '..');
const BASE_DIR = path.join(ROOT, 'release', 'wanfeng-v080', 'after');
const SAMPLE = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const OUT = path.join(ROOT, 'release', 'wanfeng-v081');
const PROJECT = path.join(OUT, 'audio');
const REPORT = path.join(ROOT, 'release', 'wanfeng-v081-audio.json');

/* 16-bit PCM WAV：合成占位音效与占位配音，不冒充真实录音 */
function wav(seconds, render, sampleRate = 22050) {
  const n = Math.floor(seconds * sampleRate);
  const bytes = Buffer.alloc(44 + n * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + n * 2, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const v = Math.max(-1, Math.min(1, render(t)));
    bytes.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
  }
  return bytes;
}
/* 风铃/纸张：两声短促衰减，用来验音效并发与停止 */
function sfxBytes() {
  return wav(1.2, (t) => {
    const a = Math.exp(-6 * t) * Math.sin(2 * Math.PI * 880 * t);
    const b = t > .35 ? Math.exp(-6 * (t - .35)) * Math.sin(2 * Math.PI * 1320 * (t - .35)) : 0;
    return (a + b * .7) * .35;
  });
}
/* 占位配音：五个「音节」包络，只为触发 Ducking 与语音互斥，不是真人录音 */
function voiceBytes() {
  return wav(3.2, (t) => {
    const syl = Math.floor(t / .6) % 5;
    const local = t % .6;
    const env = Math.min(1, local / .06) * Math.exp(-3.4 * local);
    const f = 165 + syl * 22 + 18 * Math.sin(2 * Math.PI * 3 * t);
    return .32 * env * Math.sin(2 * Math.PI * f * t);
  }, 16000);
}

function dataUri(mime, buf) { return 'data:' + mime + ';base64,' + buf.toString('base64'); }

function loadBase() {
  const json = path.join(BASE_DIR, 'project.paper.json');
  if (!fs.existsSync(json)) throw new Error('缺少 V0.8.0 演出工程：' + json + '（先跑 npm run wanfeng:v08）');
  const disk = JSON.parse(fs.readFileSync(json, 'utf8'));
  const assets = (disk.assets || []).map((a) => {
    const file = path.join(BASE_DIR, a.file);
    const bytes = fs.readFileSync(file);
    return { id: a.id, name: a.name, kind: a.kind, data: dataUri('image/png', bytes), width: a.width, height: a.height, bytes: bytes.length };
  });
  return { disk, assets };
}

function loadOst() {
  const store = createStore();
  const sample = store.openProject(SAMPLE).project;
  const want = { ost_02_morning: '九月的早晨', ost_03_school_road: '桂花香的小路', ost_05_after_school: '放学后的走廊', ost_06_night: '灯还亮着', ost_01_title: '晚风经过二楼走廊' };
  const out = [];
  for (const a of sample.audioAssets) {
    const track = a.meta && a.meta.trackId;
    if (!want[track]) continue;
    const file = path.join(SAMPLE, a.file);
    if (!fs.existsSync(file)) throw new Error('OST 素材缺失：' + file);
    const bytes = fs.readFileSync(file);
    out.push({
      id: 'bgm_' + track, name: want[track], category: 'bgm', categories: ['bgm'],
      data: dataUri(a.mime || 'audio/ogg', bytes), mime: a.mime || 'audio/ogg', ext: 'ogg',
      duration: a.duration, bytes: bytes.length, meta: { trackId: track, category: 'bgm', moodTags: (a.meta && a.meta.moodTags) || [], source: '晚风 OST（仓库自带）' }
    });
  }
  return out;
}

function addAudioActions(nodes, ids) {
  const at = (i) => nodes[i];
  const push = (i, action) => { const n = at(i); if (!n) return; if (!n.performance) n.performance = { version: 1, actions: [] }; n.performance.actions.push(action); };
  const act = (type, params, opt) => PF.make('pa_' + C.id(), type, '', Object.assign({ params, duration: (opt && opt.duration) || 1 }, opt || {}));
  const bgm = (track) => (ids.audioAssets.find((a) => a.meta && a.meta.trackId === track) || {}).id || '';

  /* 片段一 · 清晨：BGM 自然淡入，与镜头推进同时开始 */
  push(0, act('audio.bgm.play', { audioId: bgm('ost_02_morning'), volume: 70, fadeIn: 2.6, loopMode: 'all', loopStart: 0, loopEnd: 0 }, { duration: 2.6, easing: 'linear' }));
  /* 压低参数只配一次，之后由配音动作自动触发 */
  push(2, act('audio.ducking', { enabled: true, level: 35, attack: 0.22, release: 0.8 }, { duration: 0.3 }));

  /* 片段二 · 放学：画面交叉淡化的同时切 BGM（等功率，2.5s） */
  push(13, act('audio.bgm.crossfade', { audioId: bgm('ost_03_school_road'), volume: 72, duration: 2.5, curve: 'equalPower', loopMode: 'all', loopStart: 0, loopEnd: 0 }, { duration: 2.5, easing: 'linear' }));
  /* 风铃音效：与闪白同一瞬间 */
  push(23, act('audio.sfx.play', { audioId: ids.sfx, volume: 80, key: 'chime' }, { duration: 0.4 }));

  /* 片段三 · 夜晚：白天音乐退出、夜晚音乐进入（线性 3s），随后配音触发 Ducking */
  push(29, act('audio.bgm.crossfade', { audioId: bgm('ost_06_night'), volume: 68, duration: 3, curve: 'linear', loopMode: 'region', loopStart: 4, loopEnd: 34 }, { duration: 3, easing: 'linear' }));
  push(31, act('audio.voice.play', { audioId: ids.voice, volume: 100, duck: true }, { duration: 1.2 }));
  push(37, act('audio.voice.stop', {}, { duration: 0.1 }));
  /* 收尾：场景结束时音乐淡出 */
  push(39, act('audio.bgm.stop', { fadeOut: 4 }, { duration: 4, easing: 'linear' }));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { disk, assets } = loadBase();
  const ost = loadOst();
  const sfxBuf = sfxBytes(), voiceBuf = voiceBytes();
  const sfx = { id: 'sfx_chime', name: '风铃（合成占位）', category: 'sfx', categories: ['sfx'], data: dataUri('audio/wav', sfxBuf), mime: 'audio/wav', ext: 'wav', duration: 1.2, bytes: sfxBuf.length, meta: { category: 'sfx', source: '脚本合成' } };
  const voice = { id: 'voice_placeholder', name: '林悠·独白（合成占位，仅验 Ducking）', category: 'voice', categories: ['voice'], data: dataUri('audio/wav', voiceBuf), mime: 'audio/wav', ext: 'wav', duration: 3.2, bytes: voiceBuf.length, meta: { category: 'voice', source: '脚本合成' } };

  const titleTrack = ost.find((a) => a.meta && a.meta.trackId === 'ost_01_title');
  const p = C.blank();
  p.schema = 6;
  p.title = '晚风经过二楼走廊 · 音频演出版';
  p.assets = assets;
  p.characters = disk.characters;
  p.chapters = disk.chapters;
  p.nodes = disk.nodes;
  p.audioAssets = ost.concat([sfx, voice]);
  p.publish = disk.publish;
  /* 标题音乐：带循环区间（6s→14s），用于「长时间停留标题」的循环演示 */
  p.titleMusic = titleTrack ? { audioId: titleTrack.id, volume: 65, fadeIn: 1.5, loop: true, loopStart: 6, loopEnd: 14 } : null;

  addAudioActions(p.nodes, { audioAssets: p.audioAssets, sfx: sfx.id, voice: voice.id });
  C.validate(p);

  /* 单文件试听版：素材全部内嵌，双击即听。
     必须在落盘之前导出——createProject 会把 data 改写成 paper:// 受控地址。 */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t0 = Date.now();
  const html = buildPlayerHTML(p, esc);
  const htmlMs = Date.now() - t0;

  /* 落盘：新建独立工程目录，不改 V0.8.0 产物 */
  if (fs.existsSync(PROJECT)) fs.rmSync(PROJECT, { recursive: true, force: true });
  createStore().createProject(PROJECT, p);
  const file = path.join(OUT, '晚风经过二楼走廊·音频演出版.html');
  fs.writeFileSync(file, html, 'utf8');

  const audioActions = p.nodes.reduce((n, x) => n + ((x.performance && x.performance.actions) ? x.performance.actions.filter((a) => PF.isAudioType(a.type)).length : 0), 0);
  const byType = {};
  for (const n of p.nodes) for (const a of (n.performance && n.performance.actions) || []) if (PF.isAudioType(a.type)) byType[a.type] = (byType[a.type] || 0) + 1;

  const report = {
    at: new Date().toISOString(), version: '0.8.1',
    project: path.relative(ROOT, PROJECT).replace(/\\/g, '/'),
    trial: path.relative(ROOT, file).replace(/\\/g, '/'),
    nodes: p.nodes.length, audioActions, byType,
    audio: p.audioAssets.map((a) => ({ id: a.id, name: a.name, ext: a.ext, bytes: a.bytes, duration: a.duration, source: a.meta && a.meta.source || '晚风 OST' })),
    audioBytes: p.audioAssets.reduce((s, a) => s + a.bytes, 0),
    titleMusic: p.titleMusic,
    export: { bytes: Buffer.byteLength(html), ms: htmlMs, scriptTags: (html.match(/<script/g) || []).length, hasEngine: /crossfadeGains/.test(html) }
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 1));
})();
