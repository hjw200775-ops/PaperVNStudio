'use strict';
/*
 * Desktop project storage. Pure Node, no Electron dependency, so it can be
 * tested without a window. The renderer only ever sees the "runtime model"
 * (assets carry a data: URL, exactly like the V0.3 web editor). On disk the
 * project is a versioned directory with content-addressed images.
 *
 *   my-story/
 *     project.paper.json          metadata, relative asset paths only
 *     assets/images/<sha256>.png  immutable, never overwritten or removed
 *     assets/audio/<sha256>.wav   V0.5: content-addressed PCM WAV / decodable audio
 *     backups/<stamp>/...         metadata snapshots; assets stay shared
 *     backups/autosave/...        crash-recovery copy
 *
 * Because asset file names are the sha256 of their bytes and are never
 * deleted, any metadata backup can always resolve the files it references.
 * Audio uses its own path pattern and its own validation: image-specific
 * kind / data-URL / intrinsic-size checks must never be applied to audio.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');
const createPaperAudio = require('../dist/audio.js');
const AUDIO_PURE = createPaperAudio().pure;

const FORMAT = 'paper-desktop';
const FORMAT_VERSION = 1;
const MAIN_FILE = 'project.paper.json';
const IMAGES_REL = 'assets/images';
const AUDIO_REL = 'assets/audio';
const BACKUPS_REL = 'backups';
const LATEST_REL = 'backups/latest';
const AUTOSAVE_REL = 'backups/autosave';
/* 单图上限从 12MiB 放开到 64MiB：高分辨率背景/立绘需要，同时保留上限防止误导入。 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
/* 音频总量：支持 1GiB 级工程（15 首 OST + 配音）。 */
const MAX_AUDIO_TOTAL = 1536 * 1024 * 1024;
const MAX_PROJECT_BYTES = 80 * 1024 * 1024;
const MAX_BACKUPS = 20;
const ASSET_FILE_RE = /^assets\/images\/([a-f0-9]{64})\.(png|jpg|webp)$/;
const AUDIO_FILE_RE = /^assets\/audio\/([a-f0-9]{64})\.(wav|wave|mp3|ogg|oga|m4a|aac|flac|webm)$/;
const AUDIO_CATEGORIES = ['bgm', 'sfx', 'voice'];
/* Legacy projects may contain arbitrary short ids; only path-like/control values are unsafe. */
function safeAssetId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 &&
    !/[\\/\0]/.test(id) && !id.includes('..') && !/^(file|app|paper|blob|data|https?):/i.test(id);
}
/* 素材内容指纹：已落盘的用 sha256，内存里的 data URI 现算；两种表示可以互比，
   这样「同一张图从磁盘打开 + 再次导入」仍能正确去重。 */
function assetContentKey(a) {
  if (!a) return '';
  if (typeof a.sha256 === 'string' && a.sha256) return a.sha256;
  const m = /^data:[^;]+;base64,([\s\S]+)$/.exec(String(a.data || ''));
  if (!m) return String(a.data || '');
  return sha256(Buffer.from(m[1], 'base64'));
}

const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/;
const AUDIO_DATA_URL_RE = /^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const AUDIO_EXT_MIME = { wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
const AUDIO_MIME_EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/flac': 'flac', 'audio/webm': 'webm' };

function friendlyError(stage, err) {
  const code = err && err.code ? err.code : '';
  const hint = {
    ENOSPC: '磁盘空间不足，请清理磁盘后重试；原有工程保持不变。',
    EACCES: '没有写入权限，请换一个可写目录或关闭占用该目录的程序。',
    EPERM: '文件可能被占用或被设为只读，请关闭相关程序后重试。',
    EBUSY: '文件正被其他程序占用，请稍后重试。',
    EROFS: '目录为只读文件系统，无法保存。',
    ENOENT: '工程目录或素材缺失。'
  }[code] || '写入未完成，原有工程保持不变。';
  const e = new Error(stage + '失败：' + hint + '（' + (code || 'UNKNOWN') + '）');
  e.code = code || 'WRITE_FAILED';
  e.friendly = true;
  e.cause = err;
  /* 排查用户报告「保存失败」时可设 PAPER_STORE_DEBUG=1 拿到原始错误；默认静默。 */
  if (process.env.PAPER_STORE_DEBUG) console.error('[store] ' + stage + ' :: ' + (err && (err.stack || err)));
  return e;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function rand() { return crypto.randomBytes(5).toString('hex'); }

/* Best-effort intrinsic size; the renderer fills any gap with decodeAsset(). */
function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg' && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
    }
    if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        const at = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
        if (at > 0 && at + 6 < buf.length) {
          return { width: buf.readUInt16LE(at + 3) & 0x3fff, height: buf.readUInt16LE(at + 5) & 0x3fff };
        }
      }
      if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
  } catch { /* fall through */ }
  return null;
}

function createProjectStore(options = {}) {
  const io = options.io || fs;
  const C = options.core || createVNCore();
  const F = options.effects || createPaperEffects();
  const clock = options.now || (() => Date.now());

  /* ---------- path safety ---------- */

  function inside(root, target) {
    const base = path.resolve(root);
    const full = path.resolve(base, target);
    if (full === base || full.startsWith(base + path.sep)) return full;
    return null;
  }

  function realInside(root, target) {
    const full = inside(root, target);
    if (!full) throw new Error('路径越出工程目录');
    let baseReal, fileReal;
    try { baseReal = io.realpathSync(path.resolve(root)); } catch { baseReal = path.resolve(root); }
    try { fileReal = io.realpathSync(full); } catch { return full; }
    if (fileReal !== baseReal && !fileReal.startsWith(baseReal + path.sep)) {
      throw new Error('检测到指向工程目录外的链接：' + String(target));
    }
    return full;
  }

  function assetPath(root, rel) {
    if (typeof rel !== 'string') throw new Error('素材路径无效');
    const image = ASSET_FILE_RE.exec(rel), audio = AUDIO_FILE_RE.exec(rel);
    if (!image && !audio) {
      throw new Error('素材路径无效：只允许工程内 assets/images/ 或 assets/audio/ 下的内容寻址文件');
    }
    if (rel.includes('\\') || rel.includes('..') || rel.includes('\0')) {
      throw new Error('素材路径包含不安全字符');
    }
    const m = image || audio;
    const [, hash, ext] = m;
    return { abs: realInside(root, rel), hash, ext,
      mime: audio ? AUDIO_EXT_MIME[ext] : EXT_MIME[ext], kind: audio ? 'audio' : 'image' };
  }

  function rejectUnsafeLinks(value, where) {
    if (typeof value !== 'string') return;
    if (/^(file|app|paper|blob|data|https?):/i.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\0')) {
      throw new Error(where + ' 包含不安全的链接或绝对路径');
    }
  }

  /* ---------- runtime <-> disk ---------- */

  function parseDataUrl(data) {
    const m = typeof data === 'string' ? DATA_URL_RE.exec(data) : null;
    if (!m) throw new Error('图片素材不是有效的内嵌 PNG/JPEG/WebP 数据');
    const mime = 'image/' + m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 12MB');
    return { buf, mime, hash: sha256(buf) };
  }

  /* 音频走独立校验：不检查图片的 kind / 尺寸，也不接受图片 data URL。 */
  function parseAudioDataUrl(data) {
    const m = typeof data === 'string' ? AUDIO_DATA_URL_RE.exec(data) : null;
    if (!m) throw new Error('音频素材不是有效的内嵌 audio data URL');
    const mime = m[1].toLowerCase();
    const ext = AUDIO_MIME_EXT[mime];
    if (!ext) throw new Error('不支持的音频类型：' + mime);
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_AUDIO_BYTES) throw new Error('音频为空或超过 16MB');
    /* 第二道防线：手工改坏的 PCM WAV 不能写进工程。与导入端共用同一个解析器。 */
    if (ext === 'wav' || ext === 'wave') {
      try { AUDIO_PURE.wavInfo(buf); }
      catch (err) { throw new Error('音频素材已损坏：' + err.message); }
    }
    return { buf, mime, ext, hash: sha256(buf) };
  }

  /* 同内容音频在运行时已合并为一条；这里防御性折叠同 ID 同内容的重复条目。 */
  function dedupeAudio(input) {
    const list = Array.isArray(input.audioAssets) ? input.audioAssets : undefined;
    if (!list) return input;
    const byId = new Map(), out = [];
    let total = 0;
    for (const a of list) {
      const prev = byId.get(a && a.id);
      if (prev) {
        if (assetContentKey(prev) !== assetContentKey(a)) throw new Error('音频素材 ID 重复且内容不同：' + a.id);
        continue;
      }
      byId.set(a && a.id, a);
      total += Number(a && a.bytes) || 0;
      out.push(a);
    }
    if (total > MAX_AUDIO_TOTAL) throw new Error('音频素材总量超过 96MB');
    return Object.assign({}, input, { audioAssets: out });
  }

  /* Asset ids are content addressed, so importing the same picture twice
   * produces the same id. Collapse identical entries instead of failing the
   * whole save; a real conflict (same id, different bytes or different use)
   * stays an error — silently dropping one of them would lose a layer's kind. */
  function dedupeAssets(input) {
    const list = Array.isArray(input.assets) ? input.assets : [];
    const byId = new Map();
    const assets = [];
    for (const a of list) {
      const prev = byId.get(a && a.id);
      if (prev) {
        if (String(prev.data) !== String(a.data)) {
          throw new Error('素材 ID 重复且内容不同：' + a.id);
        }
        if (String(prev.kind) !== String(a.kind)) {
          throw new Error('素材 ID 重复且用途不同：' + a.id);
        }
        continue;                        // same picture, same use: keep one entry
      }
      byId.set(a && a.id, a);
      assets.push(a);
    }
    return Object.assign({}, input, { assets });
  }

  function validateRuntime(input) {
    if (!input || typeof input !== 'object') throw new Error('不是有效的纸间工程');
    const merged = dedupeAudio(dedupeAssets(input));
    C.validate(merged);
    let p = C.migrate(merged);
    if (p.schema !== 5) throw new Error('工程版本无法迁移');
    C.validate(p);
    for (const n of p.nodes) F.validate(n.effects || []);
    const ids = new Set();
    for (const a of p.assets) {
      if (!safeAssetId(a.id)) throw new Error('素材 ID 含非法字符：' + a.id);
      if (ids.has(a.id)) throw new Error('素材 ID 重复');
      ids.add(a.id);
    }
    const audioIds = new Set();
    for (const a of p.audioAssets) {
      if (!safeAssetId(a.id)) throw new Error('音频素材 ID 含非法字符：' + a.id);
      if (audioIds.has(a.id)) throw new Error('音频素材 ID 重复');
      audioIds.add(a.id);
      /* 运行时可以带「受控相对路径 + 内容哈希」（V0.7.6 起素材本体在磁盘），
         但绝不能带本机绝对路径或外部 URL。 */
      if ('path' in a || 'src' in a) throw new Error('运行时音频素材含本机绝对路径');
      if ('file' in a && !/^assets\/audio\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(String(a.file))) {
        throw new Error('运行时音频素材路径不合法：' + a.file);
      }
      if ('sha256' in a && !/^[a-f0-9]{64}$/i.test(String(a.sha256))) {
        throw new Error('运行时音频素材哈希不合法：' + a.sha256);
      }
    }
    return p;
  }

  function diskAssets(p, root) {
    /* Decode each data URL exactly once; the result is reused for writing. */
    const out = [], audio = [];
    const used = new Map();
    for (const a of p.assets || []) {
      /* 打开自磁盘的素材已经是「受控 URL + 已落盘文件」：沿用元数据，不重新编码。 */
      if (a.file && /^paper:\/\/app\/asset\//i.test(String(a.data || ''))) {
        const m = ASSET_FILE_RE.exec(a.file);
        if (!m) throw new Error('素材路径无效：' + a.file);
        /* 关键：另存为/备份靠 used 决定要写哪些文件。URL 素材必须把原文件读进来，
           否则目标工程只有元数据、没有图片。 */
        const abs = path.join(root, ...a.file.split('/'));
        let buf;
        try { buf = io.readFileSync(abs); } catch { throw new Error('素材文件缺失：' + a.file); }
        const hash = sha256(buf);
        if (hash !== m[1]) throw new Error('素材内容与文件名不一致：' + a.file);
        used.set(a.file, { buf, hash });
        out.push({ id: a.id, name: a.name, kind: a.kind, width: a.width, height: a.height,
          mime: EXT_MIME[m[2]], file: a.file, sha256: hash, bytes: buf.length });
        continue;
      }
      const { buf, mime, hash } = parseDataUrl(a.data);
      const ext = MIME_EXT[mime];
      const rel = IMAGES_REL + '/' + hash + '.' + ext;
      const size = imageSize(buf, mime) || {};
      used.set(rel, { buf, hash });
      out.push({
        id: a.id, name: a.name, kind: a.kind,
        width: a.width || size.width || null,
        height: a.height || size.height || null,
        mime, file: rel, sha256: hash, bytes: buf.length
      });
    }
    /* 音频按内容哈希单独存到 assets/audio/，工程元数据只留受控相对路径。 */
    for (const a of p.audioAssets || []) {
      if (a.file && /^paper:\/\/app\/asset\//i.test(String(a.data || ''))) {
        const m = AUDIO_FILE_RE.exec(a.file);
        if (!m) throw new Error('音频路径无效：' + a.file);
        const absA = path.join(root, ...a.file.split('/'));
        let bufA;
        try { bufA = io.readFileSync(absA); } catch { throw new Error('音频文件缺失：' + a.file); }
        const hashA = sha256(bufA);
        if (hashA !== m[1]) throw new Error('音频内容与文件名不一致：' + a.file);
        used.set(a.file, { buf: bufA, hash: hashA });
        const item = {
          id: a.id, name: a.name, categories: [...(a.categories || [])],
          mime: AUDIO_EXT_MIME[m[2]], ext: m[2], duration: a.duration == null ? null : a.duration,
          file: a.file, sha256: hashA, bytes: bufA.length
        };
        if (a.durationNote) item.durationNote = a.durationNote;
        if (a.meta && typeof a.meta === 'object') item.meta = a.meta;
        audio.push(item);
        continue;
      }
      const { buf, ext, hash } = parseAudioDataUrl(a.data);
      const mime = AUDIO_EXT_MIME[ext];
      const rel = AUDIO_REL + '/' + hash + '.' + ext;
      used.set(rel, { buf, hash });
      const item = {
        id: a.id, name: a.name, categories: [...(a.categories || [])],
        mime, ext, duration: a.duration == null ? null : a.duration,
        file: rel, sha256: hash, bytes: buf.length
      };
      if (a.durationNote) item.durationNote = a.durationNote;
      /* 素材库标签（分类/情绪/场景/曲目 ID）随工程保存，用于检索与「按 ID 替换音源」。 */
      if (a.meta && typeof a.meta === 'object') item.meta = a.meta;
      audio.push(item);
    }
    return { assets: out, audioAssets: audio, used };
  }

  function toDisk(p, root) {
    const { assets, audioAssets, used } = diskAssets(p, root);
    const disk = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      savedAt: new Date(clock()).toISOString(),
      schema: 5,
      id: p.id,
      title: p.title,
      titleBackground: typeof p.titleBackground === 'string' ? p.titleBackground : '',
      assets,
      audioAssets,
      nodes: p.nodes,
      presets: p.presets,
      characters: p.characters || [],
      chapters: p.chapters || [],
      publish: p.publish && typeof p.publish === 'object' ? p.publish : undefined,
      titleMusic: p.titleMusic && typeof p.titleMusic === 'object' ? p.titleMusic : undefined
    };
    return { disk, used };
  }

  function validateDisk(disk) {
    if (!disk || disk.format !== FORMAT || disk.formatVersion !== FORMAT_VERSION) {
      throw new Error('不是桌面工程目录（缺少 project.paper.json 或格式版本不匹配）');
    }
    if (![3, 4, 5].includes(disk.schema) || typeof disk.id !== 'string' || typeof disk.title !== 'string' ||
        !Array.isArray(disk.nodes) || !Array.isArray(disk.assets) || !Array.isArray(disk.presets)) {
      throw new Error('桌面工程元数据格式错误');
    }
    if (disk.characters !== undefined && !Array.isArray(disk.characters)) {
      throw new Error('桌面工程角色列表格式错误');
    }
    /* 标题背景是可选的素材 ID；旧工程没有这个字段就是默认标题页。 */
    if (disk.titleBackground !== undefined && typeof disk.titleBackground !== 'string') {
      throw new Error('桌面工程标题背景格式错误');
    }
    if (disk.chapters !== undefined && !Array.isArray(disk.chapters)) {
      throw new Error('桌面工程章节列表格式错误');
    }
    /* 发行设置是可选增量字段：旧工程没有它，读出来用运行时默认值。 */
    if (disk.publish !== undefined) {
      const pub = disk.publish;
      if (!pub || typeof pub !== 'object') throw new Error('桌面工程发行设置格式错误');
      for (const k of ['gameName', 'author', 'version', 'copyright', 'releaseId']) {
        if (pub[k] !== undefined && typeof pub[k] !== 'string') throw new Error('发行设置字段格式错误：' + k);
      }
      if (pub.icon !== null && pub.icon !== undefined) {
        if (typeof pub.icon !== 'object' || typeof pub.icon.data !== 'string' ||
            !/^data:image\/png;base64,/.test(pub.icon.data) || pub.icon.data.length > 4 * 1024 * 1024) {
          throw new Error('游戏图标格式错误：请重新导入 PNG 图片');
        }
      }
      if (pub.window !== undefined) {
        const w = pub.window;
        if (!w || typeof w !== 'object' || !Number.isFinite(w.width) || !Number.isFinite(w.height) ||
            typeof w.resizable !== 'boolean' || !['window', 'fullscreen'].includes(w.mode)) {
          throw new Error('窗口设置格式错误');
        }
      }
    }
    if (disk.audioAssets !== undefined) {
      if (!Array.isArray(disk.audioAssets) || disk.audioAssets.length > 200) {
        throw new Error('桌面工程音频素材列表格式错误');
      }
      const audioIds = new Set();
      let total = 0;
      for (const a of disk.audioAssets) {
        if (!a || !safeAssetId(a.id) || audioIds.has(a.id) || typeof a.name !== 'string' ||
            !Array.isArray(a.categories) || !a.categories.length ||
            a.categories.some(c => !AUDIO_CATEGORIES.includes(c)) ||
            typeof a.mime !== 'string' || typeof a.ext !== 'string' ||
            typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256) ||
            !Number.isInteger(a.bytes) || a.bytes < 0 || a.bytes > MAX_AUDIO_BYTES ||
            !(a.duration === null || (Number.isFinite(a.duration) && a.duration >= 0))) {
          throw new Error('音频素材元数据格式错误');
        }
        if ('data' in a) throw new Error('桌面工程不应包含内嵌音频数据');
        audioIds.add(a.id);
        total += a.bytes;
        rejectUnsafeLinks(a.file, '音频素材路径');
        const m = AUDIO_FILE_RE.exec(a.file || '');
        if (!m || m[1] !== a.sha256 || AUDIO_EXT_MIME[m[2]] !== a.mime || AUDIO_EXT_MIME[a.ext] !== a.mime) {
          throw new Error('音频素材路径或校验值不匹配：' + String(a.file));
        }
      }
      if (total > MAX_AUDIO_TOTAL) throw new Error('音频素材总量超过 96MB');
    }
    if (disk.nodes.length > 20000 || disk.assets.length > 1000 || disk.presets.length > 200) {
      throw new Error('工程超过体验版限制');
    }
    const ids = new Set();
    for (const a of disk.assets) {
      if (!a || !safeAssetId(a.id) || ids.has(a.id) || typeof a.name !== 'string' ||
          !['bg', 'char'].includes(a.kind) || typeof a.sha256 !== 'string' ||
          !Number.isInteger(a.bytes) || a.bytes < 0 || a.bytes > MAX_IMAGE_BYTES) {
        throw new Error('素材元数据格式错误');
      }
      if ('data' in a) throw new Error('桌面工程不应包含内嵌图片数据');
      ids.add(a.id);
      rejectUnsafeLinks(a.file, '素材路径');
      const m = ASSET_FILE_RE.exec(a.file || '');
      if (!m || m[1] !== a.sha256 || EXT_MIME[m[2]] !== a.mime) {
        throw new Error('素材路径或校验值不匹配：' + String(a.file));
      }
    }
    return disk;
  }

  function readDisk(root, file) {
    const abs = path.resolve(root, file);
    const stat = io.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) throw new Error('工程文件无效或过大');
    return validateDisk(JSON.parse(io.readFileSync(abs, 'utf8')));
  }

  function diskToRuntime(root, disk) {
    const assets = [];
    const missing = [];
    for (const a of disk.assets) {
      const info = assetPath(root, a.file);
      if (info.hash !== a.sha256) throw new Error('素材校验值不匹配：' + a.file);
      let buf;
      try { buf = io.readFileSync(info.abs); } catch (e) {
        missing.push(a.name + '（' + a.file + '）');
        continue;
      }
      if (buf.length !== a.bytes || sha256(buf) !== a.sha256) {
        missing.push(a.name + '（' + a.file + '，内容已变化）');
        continue;
      }
      const size = imageSize(buf, info.mime) || {};
      assets.push({
        id: a.id, name: a.name, kind: a.kind,
        width: a.width || size.width, height: a.height || size.height,
        file: a.file, sha256: a.sha256, bytes: buf.length, mime: info.mime,
        /* 运行时只持有受控 URL：舞台按需读取，不再把整张图 base64 进内存。 */
        data: 'paper://app/asset/' + a.file
      });
    }
    const audioAssets = [];
    for (const a of disk.audioAssets || []) {
      const info = assetPath(root, a.file);
      if (info.kind !== 'audio' || info.hash !== a.sha256) throw new Error('音频素材校验值不匹配：' + a.file);
      let buf;
      try { buf = io.readFileSync(info.abs); } catch {
        missing.push(a.name + '（' + a.file + '）');
        continue;
      }
      if (buf.length !== a.bytes || sha256(buf) !== a.sha256) {
        missing.push(a.name + '（' + a.file + '，内容已变化）');
        continue;
      }
      const item = {
        id: a.id, name: a.name, categories: [...a.categories],
        file: a.file, sha256: a.sha256,
        data: 'paper://app/asset/' + a.file,
        mime: info.mime, ext: info.ext, bytes: buf.length, duration: a.duration
      };
      if (a.durationNote) item.durationNote = a.durationNote;
      if (a.meta && typeof a.meta === 'object') item.meta = a.meta;
      audioAssets.push(item);
    }
    if (missing.length) throw new Error('工程引用的素材缺失，可从备份恢复：' + missing.join('、'));
    const runtime = {
      schema: disk.schema || 4, id: disk.id, title: disk.title,
      titleBackground: typeof disk.titleBackground === 'string' ? disk.titleBackground : '',
      assets, audioAssets, nodes: disk.nodes, presets: disk.presets,
      characters: Array.isArray(disk.characters) ? disk.characters : [],
      chapters: Array.isArray(disk.chapters) ? disk.chapters : []
    };
    if (disk.publish && typeof disk.publish === 'object') runtime.publish = disk.publish;
    /* 标题音乐同样是可选增量字段：只有配过才存在。 */
    if (disk.titleMusic !== undefined && disk.titleMusic !== null) {
      const tm = disk.titleMusic;
      if (typeof tm !== 'object' || typeof tm.audioId !== 'string' || !tm.audioId) {
        throw new Error('桌面工程标题音乐格式错误');
      }
      runtime.titleMusic = tm;
    }
    return validateRuntime(runtime);
  }

  /* ---------- low-level writes ---------- */

  function writeAssets(root, used) {
    io.mkdirSync(realInside(root, IMAGES_REL), { recursive: true });
    if ([...used.keys()].some(r => r.startsWith(AUDIO_REL + '/'))) {
      io.mkdirSync(realInside(root, AUDIO_REL), { recursive: true });
    }
    for (const [rel, entry] of used) {
      const abs = realInside(root, rel);
      if (io.existsSync(abs)) {
        const existing = io.readFileSync(abs);
        if (sha256(existing) !== entry.hash) throw new Error('素材文件与校验值冲突，已拒绝覆盖：' + rel);
        continue;
      }
      const tmp = abs + '.tmp-' + process.pid + '-' + rand();
      try {
        io.writeFileSync(tmp, entry.buf, { flag: 'wx' });
        if (sha256(io.readFileSync(tmp)) !== entry.hash) throw new Error('素材写入校验失败');
        if (!io.existsSync(abs)) io.renameSync(tmp, abs);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('素材')) throw err;
        throw friendlyError('写入素材', err);
      } finally {
        if (io.existsSync(tmp)) { try { io.unlinkSync(tmp); } catch { /* keep, never delete user data */ } }
      }
    }
  }

  function atomicWrite(abs, disk) {
    const payload = JSON.stringify(disk, null, 2);
    if (Buffer.byteLength(payload) > MAX_PROJECT_BYTES) throw new Error('工程元数据超过 80MB');
    const tmp = abs + '.tmp-' + process.pid + '-' + rand();
    const previous = abs + '.previous';
    try {
      io.writeFileSync(tmp, payload, { flag: 'wx' });
      // fsync is best effort: Windows / some volumes reject it with EPERM.
      let fd = null;
      try {
        fd = io.openSync(tmp, 'r+');
        io.fsyncSync(fd);
      } catch (err) {
        if (!['EPERM', 'EINVAL', 'ENOTSUP', 'ENOSYS'].includes(err && err.code)) throw friendlyError('写入临时文件', err);
      } finally {
        if (fd !== null) io.closeSync(fd);
      }
      if (JSON.stringify(JSON.parse(io.readFileSync(tmp, 'utf8'))) !== JSON.stringify(disk)) {
        throw new Error('临时文件校验失败');
      }
      if (io.existsSync(abs)) io.copyFileSync(abs, previous);
      try { io.renameSync(tmp, abs); }
      catch (err) {
        throw friendlyError('替换工程文件', err);
      }
      const final = JSON.parse(io.readFileSync(abs, 'utf8'));
      if (final.format !== disk.format || final.id !== disk.id || final.savedAt !== disk.savedAt) {
        throw new Error('替换后校验失败');
      }
      // 清理临时回滚副本是尽力而为：删不掉不能把已经写好的工程报告成失败。
      if (io.existsSync(previous)) { try { io.unlinkSync(previous); } catch { /* 保留也无害 */ } }
    } catch (err) {
      if (io.existsSync(tmp)) { try { io.unlinkSync(tmp); } catch { /* best effort */ } }
      if (io.existsSync(previous)) {
        try { io.copyFileSync(previous, abs); } catch { /* backup copy stays available */ }
        try { io.unlinkSync(previous); } catch { /* best effort */ }
      }
      if (err && err.friendly) throw err;
      if (err instanceof Error && /^(临时文件校验失败|替换后校验失败|工程元数据超过|素材)/.test(err.message)) throw err;
      throw friendlyError('保存工程', err);
    }
  }

  function makeBackup(root, reason) {
    const main = path.resolve(root, MAIN_FILE);
    if (!io.existsSync(main)) return null;
    const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-');
    const dir = path.join(root, BACKUPS_REL, stamp + '-' + reason + '-' + rand());
    io.mkdirSync(dir, { recursive: true });
    io.copyFileSync(main, path.join(dir, MAIN_FILE));
    io.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify({
      createdAt: new Date(clock()).toISOString(), reason,
      note: '素材为内容寻址文件，保存在工程 assets/images/ 中，不会被覆盖或删除。'
    }, null, 2));
    pruneBackups(root);
    return dir;
  }

  function pruneBackups(root) {
    const base = path.join(root, BACKUPS_REL);
    if (!io.existsSync(base)) return;
    const dirs = io.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'autosave' && d.name !== 'latest')
      .map(d => d.name).sort().reverse();
    for (const name of dirs.slice(MAX_BACKUPS)) {
      try { io.rmSync(path.join(base, name), { recursive: true, force: true }); } catch { /* keep */ }
    }
  }

  function listBackups(root) {
    const base = path.join(root, BACKUPS_REL);
    if (!io.existsSync(base)) return [];
    return io.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'autosave' && d.name !== 'latest' && io.existsSync(path.join(base, d.name, MAIN_FILE)))
      .map(d => d.name).sort().reverse();
  }

  /* A copy of the last successfully written main file. Unlike the pre-save
   * versioned backups, this one represents the newest saved state. */
  function updateLastGood(root, mainFile) {
    try {
      const dir = path.join(root, LATEST_REL);
      io.mkdirSync(dir, { recursive: true });
      io.copyFileSync(mainFile, path.join(dir, MAIN_FILE));
    } catch { /* the main save already succeeded; never fail it for a backup */ }
  }

  /* Find the newest backup whose metadata parses AND whose images are intact. */
  function findRestorableBackup(root) {
    const candidates = [path.join(root, LATEST_REL),
      ...listBackups(root).map(name => path.join(root, BACKUPS_REL, name))];
    for (const dir of candidates) {
      try {
        const disk = readDisk(dir, MAIN_FILE);
        for (const a of [...(disk.assets || []), ...(disk.audioAssets || [])]) {
          const info = assetPath(root, a.file);
          const buf = io.readFileSync(info.abs);
          if (sha256(buf) !== a.sha256) throw new Error('素材校验失败');
        }
        return { name: path.basename(dir), disk };
      } catch { /* try an older backup */ }
    }
    return null;
  }

  /* ---------- public operations ---------- */

  function ensureProjectDir(dir) {
    if (!dir || typeof dir !== 'string') throw new Error('未指定工程目录');
    const root = path.resolve(dir);
    io.mkdirSync(root, { recursive: true });
    return root;
  }

  function writeProject(root, runtime, { backup = true, autosave = false, sourceRoot = null } = {}) {
    const p = validateRuntime(runtime);
    /* sourceRoot：另存为时素材仍在旧目录，读源文件用旧根，写新文件用新根。 */
    const { disk, used } = toDisk(p, sourceRoot || root);
    writeAssets(root, used);                           // never deletes old images
    const target = autosave ? path.join(root, AUTOSAVE_REL, MAIN_FILE) : path.resolve(root, MAIN_FILE);
    io.mkdirSync(path.dirname(target), { recursive: true });
    if (!autosave && backup) makeBackup(root, 'save'); // before replacing the only good copy
    atomicWrite(target, disk);                        // metadata last, with rollback
    if (!autosave) updateLastGood(root, target);      // newest verified saved state
    /* 保存后运行时改用受控 URL：素材已经在磁盘上，内存里没必要再留一份 base64。
       下一次编辑、撤销与自动保存都只处理元数据。 */
    for (const a of p.assets || []) {
      const d = (disk.assets || []).find(x => x.id === a.id);
      if (d && d.file) { a.file = d.file; a.sha256 = d.sha256; a.bytes = d.bytes; a.data = 'paper://app/asset/' + d.file; }
    }
    for (const a of p.audioAssets || []) {
      const d = (disk.audioAssets || []).find(x => x.id === a.id);
      if (d && d.file) { a.file = d.file; a.sha256 = d.sha256; a.bytes = d.bytes; a.data = 'paper://app/asset/' + d.file; }
    }
    return { root, disk, project: p };
  }

  /* sourceRoot：素材已经是受控 URL 时，从旧目录读原文件；省略则与目标目录相同。 */
  function createProject(dir, runtime, sourceRoot) {
    const root = ensureProjectDir(dir);
    if (io.existsSync(path.join(root, MAIN_FILE))) throw new Error('该目录已有工程，请选择空白目录或先打开它');
    const result = writeProject(root, runtime, { backup: false, sourceRoot });
    return { ...result, created: true };
  }

  function openProject(dir) {
    const root = path.resolve(dir);
    let disk, recovered = null;
    try {
      disk = readDisk(root, MAIN_FILE);
    } catch (err) {
      const found = findRestorableBackup(root);
      if (!found) throw new Error('打开工程失败：' + err.message);
      disk = found.disk;
      atomicWrite(path.resolve(root, MAIN_FILE), { ...disk, savedAt: new Date(clock()).toISOString() });
      recovered = 'backup';
    }
    let active = disk;
    const autosave = path.join(root, AUTOSAVE_REL, MAIN_FILE);
    if (io.existsSync(autosave)) {
      try {
        const draft = readDisk(root, path.join(AUTOSAVE_REL, MAIN_FILE));
        const mainTime = Date.parse(disk.savedAt || '') || 0;
        const draftTime = Date.parse(draft.savedAt || '') || 0;
        if (draftTime > mainTime) { active = draft; recovered = 'autosave'; }
      } catch { /* ignore a broken autosave, the main file is still good */ }
    }
    return { root, disk: active, project: diskToRuntime(root, active), recovered };
  }

  /* Explicit save: full backup + atomic replace, then clear the crash draft. */
  function saveProject(dir, runtime) {
    const result = writeProject(path.resolve(dir), runtime, { backup: true });
    const draft = path.join(result.root, AUTOSAVE_REL, MAIN_FILE);
    if (io.existsSync(draft)) {
      try { io.unlinkSync(draft); } catch { /* safe: main file is now current */ }
    }
    return result;
  }

  /* Autosave never touches the main file. It is valid on its own because images
     are written to the shared immutable asset store before the metadata. */
  function autoSave(dir, runtime) {
    return writeProject(path.resolve(dir), runtime, { backup: false, autosave: true });
  }

  /* Promote an autosave into the main file (used by "save before close"). */
  function promoteAutosave(dir) {
    const root = path.resolve(dir);
    const draftFile = path.join(AUTOSAVE_REL, MAIN_FILE);
    const disk = readDisk(root, draftFile);
    for (const a of [...(disk.assets || []), ...(disk.audioAssets || [])]) {
      const info = assetPath(root, a.file);
      if (sha256(io.readFileSync(info.abs)) !== a.sha256) throw new Error('自动保存的素材不可用，未覆盖主工程');
    }
    makeBackup(root, 'recover');
    atomicWrite(path.resolve(root, MAIN_FILE), disk);
    try { io.unlinkSync(path.join(root, draftFile)); } catch { /* best effort */ }
    return { root, disk, project: diskToRuntime(root, disk), recovered: 'save-before-close' };
  }

  /* Save As: write only the images the current project actually references into
     a brand new directory. The old project is read-only in this operation. */
  function saveAsProject(dir, runtime, sourceRoot) {
    const root = ensureProjectDir(dir);
    if (io.existsSync(path.join(root, MAIN_FILE))) throw new Error('目标目录已有工程，请选择空白目录');
    return { ...writeProject(root, runtime, { backup: false, sourceRoot }), created: true };
  }

  /* Import a V0.1/V0.2/V0.3 .paper.json (data URLs). The source is read-only. */
  function importLegacy(sourceFile, targetDir) {
    const abs = path.resolve(sourceFile);
    const stat = io.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) throw new Error('工程文件无效或超过 80MB');
    const before = io.readFileSync(abs);
    const raw = JSON.parse(before.toString('utf8'));
    const p = validateRuntime(raw);                  // validate + migrate first
    const result = saveAsProject(targetDir, p);       // then decode into a new dir
    if (!io.readFileSync(abs).equals(before)) throw new Error('导入过程修改了原文件');
    return { ...result, imported: true, source: abs };
  }

  /* Stable content-derived id for newly imported images. */
  function newAssetId(kind, dataUrl) {
    const { hash } = parseDataUrl(dataUrl);
    return 'a_' + sha256(Buffer.from(kind + ':' + hash)).slice(0, 16);
  }
  /* 音频 ID 只由内容决定：重复导入同一个文件复用同一条素材，不产生第二个 ID。 */
  function newAudioAssetId(dataUrl) {
    const { hash } = parseAudioDataUrl(dataUrl);
    return 'au_' + hash.slice(0, 16);
  }

  function inspectReferences(p) {
    const ids = new Set(p.assets.map(a => a.id));
    const audioIds = new Set((p.audioAssets || []).map(a => a.id));
    const layers = new Set(p.nodes.flatMap(n => (n.layers || []).map(l => l.id)));
    const brokenAssets = p.nodes.flatMap(n => (n.layers || [])
      .filter(l => !ids.has(l.asset)).map(l => n.id + '/' + l.name));
    const brokenEffects = p.nodes.flatMap(n => (n.effects || [])
      .filter(e => !layers.has(e.layer)).map(e => n.id + '/' + e.type));
    const brokenAudio = [];
    for (const n of p.nodes) {
      const c = C.audioCue(p, n);
      if (c.bgm && c.bgm.action === 'play' && !audioIds.has(c.bgm.audioId)) brokenAudio.push(n.id + '/bgm');
      for (const s of c.sfx) if (!audioIds.has(s.audioId)) brokenAudio.push(n.id + '/sfx');
      if (c.voice && !audioIds.has(c.voice.audioId)) brokenAudio.push(n.id + '/voice');
    }
    return { brokenAssets, brokenEffects, brokenAudio,
      brokenTitleBackground: p.titleBackground && !ids.has(p.titleBackground) ? p.titleBackground : '' };
  }

  /* ---------- recent projects (in Electron userData, never in Git) ---------- */

  function readRecent(file) {
    try {
      const data = JSON.parse(io.readFileSync(file, 'utf8'));
      const items = (Array.isArray(data.items) ? data.items : [])
        .filter(x => x && typeof x.path === 'string' && typeof x.title === 'string')
        .slice(0, 12);
      return { lastOpened: typeof data.lastOpened === 'string' ? data.lastOpened : null, items };
    } catch { return { lastOpened: null, items: [] }; }
  }

  function writeRecent(file, state) {
    io.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, {
      format: 'paper-recent', formatVersion: 1,
      savedAt: new Date(clock()).toISOString(),
      lastOpened: state.lastOpened, items: state.items
    });
  }

  function touchRecent(file, dir, title) {
    const state = readRecent(file);
    const key = path.resolve(dir);
    state.items = [{ path: key, title, openedAt: new Date(clock()).toISOString() },
      ...state.items.filter(x => path.resolve(x.path) !== key)].slice(0, 12);
    state.lastOpened = key;
    writeRecent(file, state);
    return state;
  }

  return {
    FORMAT, FORMAT_VERSION, MAIN_FILE, AUTOSAVE_REL, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES,
    constants: { FORMAT, FORMAT_VERSION, MAIN_FILE, IMAGES_REL, AUDIO_REL, BACKUPS_REL, AUTOSAVE_REL },
    createProject, openProject, saveProject, autoSave, promoteAutosave, saveAsProject,
    importLegacy, validateRuntime, validateDisk, toDisk, diskToRuntime, parseDataUrl, parseAudioDataUrl,
    imageSize, newAssetId, newAudioAssetId, inspectReferences, listBackups, findRestorableBackup,
    readRecent, touchRecent, writeRecent, assetPath, friendlyError
  };
}

module.exports = createProjectStore;
module.exports.constants = { FORMAT, FORMAT_VERSION, MAIN_FILE, IMAGES_REL, AUDIO_REL,
  BACKUPS_REL, AUTOSAVE_REL, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES };
