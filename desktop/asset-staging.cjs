'use strict';
/*
 * V0.7.6-M3: streaming asset staging.
 *
 * The renderer never receives a Base64 copy of an imported file. The main
 * process streams the file into userData/asset-staging/<sha256>.<ext> while
 * hashing it in chunks, and returns only a controlled paper:// URL plus
 * metadata. Files are immutable and content-addressed, so importing the same
 * bytes twice never increases disk usage.
 *
 * Nothing in here requires Electron: the module is pure Node so it can be
 * exercised by unit tests with an injected fs shim.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const AUDIO_MIME = { wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
const HASH_RE = /^[a-f0-9]{64}$/;
const HASH_FILE_RE = /^([a-f0-9]{64})\.([a-z0-9]+)$/i;
const HEAD_BYTES = 1024 * 1024;           // bounded header sample, never the whole file
const CHUNK = 1024 * 1024;

class Cancelled extends Error {
  constructor() { super('已取消导入'); this.name = 'Cancelled'; this.cancelled = true; }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function rand() { return crypto.randomBytes(6).toString('hex'); }

function imageHeader(buf, mime) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (mime === 'image/png') {
    if (b.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
    if (b.length < 24) return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg') {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return {};                            // magic OK; renderer decodes intrinsic size
  }
  if (mime === 'image/webp') {
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
    return {};
  }
  return null;
}

function audioHeader(buf, ext) {
  if (!buf || buf.length < 12) return {};
  const ascii = (a, b) => buf.toString('ascii', a, b);
  if (ext === 'wav' || ext === 'wave') {
    if (buf.length < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE') {
      throw new Error('不是有效的 WAV 文件（缺少 RIFF/WAVE 头）');
    }
    /* 只解析 fmt / data 块头：大文件的 data 段比头部样本长，不能用 wavInfo 的整段边界检查。 */
    const le = (a, n) => { let v = 0; for (let i = 0; i < n; i++) v += buf[a + i] * (256 ** i); return v; };
    let at = 12, fmt = null, dataSize = 0, found = false;
    while (at + 8 <= buf.length) {
      const name = ascii(at, at + 4), size = le(at + 4, 4), body = at + 8;
      if (size < 0 || body > buf.length) throw new Error('WAV 文件已损坏（数据块长度越界）');
      if (name === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
        const format = le(body, 2), channels = le(body + 2, 2), sampleRate = le(body + 4, 4), byteRate = le(body + 8, 4);
        if (!channels || !sampleRate || !byteRate || !le(body + 14, 2)) throw new Error('WAV 文件已损坏（格式参数无效）');
        if (format !== 1 && format !== 3 && format !== 0xFFFE) throw new Error('暂不支持压缩编码的 WAV，请使用 PCM WAV');
        fmt = { channels, sampleRate, byteRate };
      }
      if (name === 'data') { dataSize = size; found = true; }
      if (found && fmt) break;
      at = body + size + (size % 2);
    }
    if (!fmt || !found || !dataSize || !fmt.byteRate) throw new Error('WAV 文件缺少 fmt 或音频数据块');
    return { duration: dataSize / fmt.byteRate, durationNote: '' };
  }
  if (ext === 'ogg' || ext === 'oga') return ascii(0, 4) === 'OggS' ? {} : (() => { throw new Error('不是有效的 OGG 音频'); })();
  if (ext === 'flac') return ascii(0, 4) === 'fLaC' ? {} : (() => { throw new Error('不是有效的 FLAC 音频'); })();
  if (ext === 'mp3') {
    const ok = ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    return ok ? {} : (() => { throw new Error('不是有效的 MP3 音频'); })();
  }
  if (ext === 'm4a' || ext === 'aac') return ascii(4, 8) === 'ftyp' ? {} : {};
  return {};                              // webm and unknown-but-allowed: decoder decides
}

function createStagingManager(options = {}) {
  const io = options.io || fs;
  const root = path.resolve(options.root);
  const jobs = new Map();
  let seq = 0;

  function ensureRoot() { io.mkdirSync(root, { recursive: true }); }
  function absFor(hash, ext) {
    if (!HASH_RE.test(String(hash)) || !/^[a-z0-9]{1,8}$/i.test(String(ext))) throw new Error('暂存素材标识无效');
    return path.join(root, hash + '.' + ext.toLowerCase());
  }
  function urlFor(hash, ext) { return 'paper://app/staging/' + hash + '.' + ext.toLowerCase(); }
  function relFor(hash, ext) { return hash + '.' + ext.toLowerCase(); }
  function isStagingUrl(data) { return /^paper:\/\/app\/staging\//i.test(String(data || '')); }
  function hashFromUrl(data) {
    const m = /^paper:\/\/app\/staging\/([a-f0-9]{64})\.[a-z0-9]+$/i.exec(String(data || ''));
    return m ? m[1] : '';
  }
  function stagedPathFor(data) {
    const m = /^paper:\/\/app\/staging\/([a-f0-9]{64})\.([a-z0-9]+)$/i.exec(String(data || ''));
    return m ? absFor(m[1], m[2]) : null;
  }

  /* 只按文件头验证「像不像」可解码素材，不做整图解码；真实解码由渲染进程完成。 */
  function validateHeader(head, mime, ext, kind) {
    const buf = Buffer.from(head);
    if (kind === 'image') {
      const size = imageHeader(buf, mime);
      if (!size) throw new Error('无法识别的 PNG / JPEG / WebP 图片');
      return { width: size.width, height: size.height };
    }
    return audioHeader(buf, ext);
  }

  async function stageFile(filePath, opts = {}) {
    const kind = opts.kind === 'audio' ? 'audio' : opts.kind === 'image' ? 'image' : '';
    if (!kind) throw new Error('暂存素材类型无效');
    const abs = path.resolve(String(filePath || ''));
    let stat;
    try { stat = await io.promises.stat(abs); }
    catch { throw new Error('素材文件不存在：' + abs); }
    if (!stat.isFile() || !stat.size) throw new Error('素材文件为空或不是普通文件');
    const ext = path.extname(abs).toLowerCase().replace(/^\./, '');
    const mime = (kind === 'image' ? IMAGE_MIME : AUDIO_MIME)[ext];
    if (!mime) throw new Error(kind === 'image' ? '仅支持 PNG / JPEG / WebP 图片' : '不支持的音频格式；本版可靠支持 PCM WAV');
    if (kind === 'image' && stat.size > (opts.maxBytes || 64 * 1024 * 1024)) throw new Error('图片超过 64MB，请压缩后重试');
    if (kind === 'audio' && stat.size > (opts.maxBytes || 16 * 1024 * 1024)) throw new Error('音频超过 16MB，请压缩后重试');
    if (Number(opts.totalBytes) + stat.size > (opts.maxTotalBytes || Infinity)) {
      throw new Error('音频总量将超过 1.5GB，请先移除不用的素材');
    }

    const token = opts.token || ('stage-' + (++seq));
    const job = { token, cancelled: false };
    jobs.set(token, job);
    const tmp = path.join(root, '.tmp-' + process.pid + '-' + rand());
    const hash = crypto.createHash('sha256');
    const head = [];
    let headLen = 0, copied = 0;
    const report = (phase) => {
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ token, phase, file: path.basename(abs), bytes: copied,
          total: stat.size, percent: stat.size ? Math.min(100, Math.round(copied * 100 / stat.size)) : 0 });
      }
    };
    try {
      ensureRoot();
      report('read');
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          if (job.cancelled || (opts.isCancelled && opts.isCancelled())) {
            job.cancelled = true;
            return cb(new Cancelled());
          }
          hash.update(chunk);
          copied += chunk.length;
          if (headLen < HEAD_BYTES) {
            const take = Math.min(chunk.length, HEAD_BYTES - headLen);
            head.push(chunk.subarray(0, take));
            headLen += take;
          }
          report('read');
          cb(null, chunk);
        }
      });
      await pipeline(io.createReadStream(abs, { highWaterMark: CHUNK }), counter,
        io.createWriteStream(tmp, { flags: 'wx', highWaterMark: CHUNK }));
      if (job.cancelled) throw new Cancelled();
      report('verify');
      const digest = hash.digest('hex');
      const meta = validateHeader(Buffer.concat(head), mime, ext, kind);
      const dest = absFor(digest, ext);
      if (io.existsSync(dest)) {
        if (io.statSync(dest).size !== stat.size) throw new Error('同名内容文件已损坏，已拒绝覆盖；请清理暂存目录后重试');
      } else {
        io.renameSync(tmp, dest);
      }
      const data = urlFor(digest, ext);
      const id = kind === 'audio' ? 'au_' + digest.slice(0, 16)
        : 'a_' + sha256(Buffer.from((opts.assetKind || 'bg') + ':' + digest)).slice(0, 16);
      const descriptor = {
        id, name: path.basename(abs), size: stat.size, bytes: stat.size,
        type: mime, mime, ext, sha256: digest, dataUrl: data, data, staged: true,
        source: abs, stagedFile: relFor(digest, ext),
        width: meta.width, height: meta.height
      };
      if (kind === 'audio') {
        descriptor.duration = Number.isFinite(meta.duration) ? meta.duration : null;
        if (meta.durationNote) descriptor.durationNote = meta.durationNote;
      }
      report('done');
      return descriptor;
    } catch (err) {
      if (err && err.cancelled) return { cancelled: true };
      throw err;
    } finally {
      jobs.delete(token);
      try { if (io.existsSync(tmp)) io.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  async function stageFiles(files, opts = {}) {
    const out = [], errors = [], seen = new Map();
    for (let i = 0; i < files.length; i++) {
      if (opts.isCancelled && opts.isCancelled()) return { cancelled: true, files: out, errors };
      const token = (opts.token || 'stage') + '-' + i;
      try {
        const f = await stageFile(files[i], Object.assign({}, opts, {
          token,
          onProgress: p => { if (opts.onProgress) opts.onProgress(Object.assign({}, p, { index: i, count: files.length })); }
        }));
        if (f.cancelled) return { cancelled: true, files: out, errors };
        const key = f.sha256 + '.' + f.ext;
        if (seen.has(key)) {
          /* 内容相同：只返回一次素材，但保留本次文件名便于界面提示。 */
          out.push(Object.assign({}, seen.get(key), { duplicateOf: seen.get(key).name, importedAs: f.name }));
        } else {
          seen.set(key, f);
          out.push(f);
        }
      } catch (err) {
        errors.push({ file: path.basename(String(files[i])), message: err.message });
        if (opts.onProgress) opts.onProgress({ token, phase: 'error', index: i, count: files.length,
          file: path.basename(String(files[i])), message: err.message, percent: 0 });
        if (opts.failFast) throw err;
      }
    }
    return { cancelled: false, files: out, errors };
  }

  function cancel(token) {
    if (token) { const job = jobs.get(token); if (job) job.cancelled = true; }
    else for (const job of jobs.values()) job.cancelled = true;
    return { cancelled: true, pending: jobs.size };
  }

  /* GC：只删除没有任何有效引用的暂存文件。protectedHashes 由渲染进程根据
     当前工程 + 撤销/重做栈 + 其他有效引用计算；缓存未命中时宁可不删。 */
  function collectGarbage({ protectedHashes = new Set(), maxAgeMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
    const removed = [], kept = [];
    let names = [];
    try { names = io.readdirSync(root); } catch { return { removed, kept }; }
    for (const name of names) {
      if (/^\.tmp-/.test(name)) {
        try {
          const st = io.statSync(path.join(root, name));
          if (now - st.mtimeMs > maxAgeMs) { io.unlinkSync(path.join(root, name)); removed.push(name); }
        } catch { /* keep */ }
        continue;
      }
      const m = HASH_FILE_RE.exec(name);
      if (!m) continue;
      if (protectedHashes.has(m[1].toLowerCase())) { kept.push(name); continue; }
      try {
        const st = io.statSync(path.join(root, name));
        if (now - st.mtimeMs < maxAgeMs) { kept.push(name); continue; }
        io.unlinkSync(path.join(root, name));
        removed.push(name);
      } catch { /* keep */ }
    }
    return { removed, kept };
  }

  /* 异常退出后重新启动：没有任何渲染进程引用，可以整体清理。 */
  function reset() {
    let removed = [];
    try {
      for (const name of io.readdirSync(root)) {
        try { io.unlinkSync(path.join(root, name)); removed.push(name); } catch { /* keep */ }
      }
    } catch { /* no staging dir yet */ }
    return { removed };
  }

  function stats() {
    let files = 0, bytes = 0;
    try {
      for (const name of io.readdirSync(root)) {
        if (!HASH_FILE_RE.test(name)) continue;
        try { bytes += io.statSync(path.join(root, name)).size; files++; } catch { /* ignore */ }
      }
    } catch { /* no staging dir yet */ }
    return { files, bytes, root };
  }

  return { root, absFor, urlFor, relFor, isStagingUrl, hashFromUrl, stagedPathFor,
    stageFile, stageFiles, cancel, collectGarbage, reset, stats, Cancelled };
}

module.exports = createStagingManager;
module.exports.IMAGE_MIME = IMAGE_MIME;
module.exports.AUDIO_MIME = AUDIO_MIME;
module.exports.HASH_RE = HASH_RE;
