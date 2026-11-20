'use strict';
/*
 * 通用导出验收用的两套工程（不写入仓库，全部生成到系统临时目录）。
 *
 *   A：《晚风经过二楼走廊》45 节点原作节选 —— 从 dist/samples 复制，改一份独立的
 *      工程身份（避免和真实玩家的存档目录混在一起），内容与台词原样保留。
 *   B：极简测试工程 —— 不同标题、作者、图标、窗口尺寸，含一个二选一分支与音频。
 *
 * 图片与音频都用代码生成（PNG 编码器 + PCM WAV 写入器），不引入外部素材，
 * 也不消耗生成额度；这样每次验收都能拿到完全一致、可重复的输入。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = buf => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** painter(x, y) -> [r, g, b, a] */
function pngBuffer(width, height, painter) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = painter(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a == null ? 255 : a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

function wavBuffer({ seconds = 1.2, freq = 440, rate = 22050 } = {}) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / (rate * 0.05)) * Math.min(1, (samples - i) / (rate * 0.1));
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.25 * 32767 * env), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const dataUrl = (mime, buf) => 'data:' + mime + ';base64,' + buf.toString('base64');

/* 不用 fs.cpSync：受限环境里它会被安全策略直接终止进程（exit 127）。 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/* ---------- 工程 A：晚风原作节选（独立测试身份） ---------- */

function buildProjectA(root, { stamp, title = '晚风经过二楼走廊', author = '黄嘉文', version = '1.0.0' } = {}) {
  const sampleDir = path.join(__dirname, '..', 'dist', 'samples', 'wanfeng-ch01');
  const sample = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.paper.json'), 'utf8'));
  const out = path.join(root, 'project-a');
  fs.mkdirSync(out, { recursive: true });
  copyDir(path.join(sampleDir, 'assets'), path.join(out, 'assets'));
  const copy = JSON.parse(JSON.stringify(sample));
  /* 独立身份：id 与 releaseId 都换成 QA 专用，避免和真实玩家/内置示例的存档目录串用。 */
  copy.id = 'qa-wanfeng-' + stamp;
  copy.publish = {
    gameName: title, author, version, copyright: 'Copyright © 2026 ' + author,
    icon: null,
    window: { width: 1180, height: 760, resizable: true, mode: 'window' },
    releaseId: 'qa-wanfeng-' + stamp
  };
  fs.writeFileSync(path.join(out, 'project.paper.json'), JSON.stringify(copy, null, 2) + '\n', 'utf8');
  return { dir: out, id: copy.id, releaseId: copy.publish.releaseId, nodes: copy.nodes.length, title };
}

/* ---------- 工程 B：极简分支 + 音频 + 自定义图标 ---------- */

function buildProjectB(root, { stamp } = {}) {
  const title = '雨停之前 · 分支测试';
  const author = '纸间测试组';
  const version = '2.3.1';
  const bgA = pngBuffer(960, 540, (x, y) => {
    const t = y / 540;
    return [Math.round(30 + 40 * t), Math.round(70 + 60 * t), Math.round(90 + 40 * t)];
  });
  const bgB = pngBuffer(960, 540, (x, y) => {
    const t = x / 960;
    return [Math.round(90 + 60 * t), Math.round(60 + 20 * t), Math.round(50 + 10 * t)];
  });
  const charImg = pngBuffer(360, 600, (x, y) => {
    const edge = x < 6 || x > 353 || y < 6 || y > 593;
    if (edge) return [245, 245, 235];
    return y < 220 ? [226, 208, 180] : [70, 96, 82];
  });
  const icon = pngBuffer(512, 512, (x, y) => {
    const d = Math.hypot(x - 256, y - 256);
    if (d < 210) return [56, 92, 76];
    const bar = (x > 140 && x < 372 && y > 236 && y < 276);
    return bar ? [244, 214, 150] : [22, 38, 30];
  });
  const bgm = wavBuffer({ seconds: 1.5, freq: 392 });
  const voice = wavBuffer({ seconds: 0.8, freq: 523 });

  const now = Date.now();
  const asset = (id, name, kind, buf) => ({
    id, name, kind, width: kind === 'char' ? 360 : 960, height: kind === 'char' ? 600 : 540,
    data: dataUrl('image/png', buf)
  });
  const assets = [asset('b_bg_rain', '雨停之前·天台', 'bg', bgA),
    asset('b_bg_stairs', '雨停之前·楼梯口', 'bg', bgB),
    asset('b_char_mio', '澪·校服', 'char', charImg)];
  const audioAssets = [
    { id: 'b_bgm_rain', name: '雨声·主题', categories: ['bgm'], mime: 'audio/wav', ext: 'wav',
      bytes: bgm.length, duration: 1.5, data: dataUrl('audio/wav', bgm) },
    { id: 'b_voice_01', name: '澪·第一句', categories: ['voice'], mime: 'audio/wav', ext: 'wav',
      bytes: voice.length, duration: 0.8, data: dataUrl('audio/wav', voice) }
  ];

  const layer = (id, assetId, name, kind, x, y, w, h) => ({
    id, asset: assetId, name, kind, x, y, w, h, fit: kind === 'bg' ? 'cover' : 'contain',
    opacity: 100, hidden: false, locked: kind === 'bg', motion: 'none', characterId: '', expressionId: ''
  });
  const node = (id, type, text, extra) => Object.assign({
    id, type, name: '', text, next: '', sceneMode: 'own', layers: [], effects: [],
    speakerId: '', expressionId: '', cast: [], paragraphId: 'pg_b1', audio: null
  }, extra || {});

  const chapter = { id: 'ch_b1', title: '雨停之前', collapsed: false,
    paragraphs: [{ id: 'pg_b1', title: '天台', collapsed: false }] };
  const cast = [{ characterId: 'ch_mio', expressionId: 'ex_mio' }];

  const n1 = node('b_01', 'say', '雨停了。天台的水洼映着一小块天空。', {
    layers: [layer('l_bg', 'b_bg_rain', '背景·天台', 'bg', 0, 0, 100, 100),
      layer('l_mio', 'b_char_mio', '澪·校服', 'char', 62, 12, 30, 88)],
    speakerId: 'ch_mio', expressionId: 'ex_mio', cast,
    audio: { bgm: { action: 'play', audioId: 'b_bgm_rain', volume: 0.8, loop: true, fadeIn: 0, fadeOut: 0 }, sfx: [], voice: null }
  });
  const n2 = node('b_02', 'say', '要一起下去吗？', {
    sceneMode: 'inherit', layers: [], speakerId: 'ch_mio', expressionId: 'ex_mio', cast,
    audio: { sfx: [], voice: { audioId: 'b_voice_01', volume: 1 } }
  });
  const n3 = node('b_03', 'choice', '楼梯口的风有点凉。', {
    sceneMode: 'inherit', layers: [], speakerId: 'ch_mio', expressionId: 'ex_mio', cast
  });
  n3.options = [{ text: '一起下楼', target: 'b_04a' }, { text: '再站一会儿', target: 'b_04b' }];
  const n4a = node('b_04a', 'say', '那就走吧。楼梯间的灯一层层亮起来。', {
    layers: [layer('l_bg2', 'b_bg_stairs', '背景·楼梯口', 'bg', 0, 0, 100, 100)],
    speakerId: 'ch_mio', expressionId: 'ex_mio', cast
  });
  const n4b = node('b_04b', 'say', '那就再站一会儿。雨后的风把校服吹得鼓起来。', {
    sceneMode: 'inherit', layers: [], speakerId: 'ch_mio', expressionId: 'ex_mio', cast
  });
  const n5 = node('b_05', 'say', '两条路都通向同一扇门。', { sceneMode: 'inherit', layers: [] });
  const n6 = node('b_06', 'end', '雨停之前，我们谁也没先走。', {
    layers: [layer('l_bg3', 'b_bg_rain', '背景·天台', 'bg', 0, 0, 100, 100)]
  });
  n1.next = 'b_02'; n2.next = 'b_03'; n4a.next = 'b_05'; n4b.next = 'b_05';

  const project = {
    schema: 5, id: 'qa-rain-' + stamp, title,
    titleBackground: 'b_bg_rain',
    publish: {
      gameName: '雨停之前', author, version, copyright: 'Copyright © 2026 ' + author,
      icon: { name: 'rain-icon.png', data: dataUrl('image/png', icon), width: 512, height: 512 },
      window: { width: 1024, height: 640, resizable: false, mode: 'window' },
      releaseId: 'qa-rain-' + stamp
    },
    assets, audioAssets,
    nodes: [n1, n2, n3, n4a, n4b, n5, n6],
    presets: [],
    characters: [{ id: 'ch_mio', name: '澪', color: '#3f6753', defaultExpressionId: 'ex_mio',
      expressions: [{ id: 'ex_mio', name: '平静', assetId: 'b_char_mio' }] }],
    chapters: [chapter]
  };
  const out = path.join(root, 'project-b');
  return {
    dir: out, project, id: project.id, releaseId: project.publish.releaseId,
    nodes: project.nodes.length, title, author, version,
    iconPng: icon, wavBytes: bgm.length, stamp: now
  };
}

module.exports = { pngBuffer, wavBuffer, buildProjectA, buildProjectB, crc32 };
