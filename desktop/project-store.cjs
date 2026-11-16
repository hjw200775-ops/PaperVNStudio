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
 *     backups/<stamp>/...         metadata snapshots; images stay shared
 *     backups/autosave/...        crash-recovery copy
 *
 * Because image file names are the sha256 of their bytes and are never
 * deleted, any metadata backup can always resolve the images it references.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const createVNCore = require('../dist/core.js');
const createPaperEffects = require('../dist/effects.js');

const FORMAT = 'paper-desktop';
const FORMAT_VERSION = 1;
const MAIN_FILE = 'project.paper.json';
const IMAGES_REL = 'assets/images';
const BACKUPS_REL = 'backups';
const LATEST_REL = 'backups/latest';
const AUTOSAVE_REL = 'backups/autosave';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PROJECT_BYTES = 80 * 1024 * 1024;
const MAX_BACKUPS = 20;
const ASSET_FILE_RE = /^assets\/images\/([a-f0-9]{64})\.(png|jpg|webp)$/;
/* Legacy projects may contain arbitrary short ids; only path-like/control values are unsafe. */
function safeAssetId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 &&
    !/[\\/\0]/.test(id) && !id.includes('..') && !/^(file|app|paper|blob|data|https?):/i.test(id);
}
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

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
    if (typeof rel !== 'string' || !ASSET_FILE_RE.test(rel)) {
      throw new Error('素材路径无效：只允许工程内 assets/images/<sha256>.<ext>');
    }
    if (rel.includes('\\') || rel.includes('..') || rel.includes('\0')) {
      throw new Error('素材路径包含不安全字符');
    }
    const [, hash, ext] = ASSET_FILE_RE.exec(rel);
    return { abs: realInside(root, rel), hash, ext, mime: EXT_MIME[ext] };
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
    const merged = dedupeAssets(input);
    C.validate(merged);
    let p = C.migrate(merged);
    if (p.schema !== 4) throw new Error('工程版本无法迁移');
    C.validate(p);
    for (const n of p.nodes) F.validate(n.effects || []);
    const ids = new Set();
    for (const a of p.assets) {
      if (!safeAssetId(a.id)) throw new Error('素材 ID 含非法字符：' + a.id);
      if (ids.has(a.id)) throw new Error('素材 ID 重复');
      ids.add(a.id);
    }
    return p;
  }

  function diskAssets(p) {
    /* Decode each data URL exactly once; the result is reused for writing. */
    const out = [];
    const used = new Map();
    for (const a of p.assets) {
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
    return { assets: out, used };
  }

  function toDisk(p) {
    const { assets, used } = diskAssets(p);
    const disk = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      savedAt: new Date(clock()).toISOString(),
      schema: 4,
      id: p.id,
      title: p.title,
      assets,
      nodes: p.nodes,
      presets: p.presets,
      characters: p.characters || []
    };
    return { disk, used };
  }

  function validateDisk(disk) {
    if (!disk || disk.format !== FORMAT || disk.formatVersion !== FORMAT_VERSION) {
      throw new Error('不是桌面工程目录（缺少 project.paper.json 或格式版本不匹配）');
    }
    if (![3, 4].includes(disk.schema) || typeof disk.id !== 'string' || typeof disk.title !== 'string' ||
        !Array.isArray(disk.nodes) || !Array.isArray(disk.assets) || !Array.isArray(disk.presets)) {
      throw new Error('桌面工程元数据格式错误');
    }
    if (disk.characters !== undefined && !Array.isArray(disk.characters)) {
      throw new Error('桌面工程角色列表格式错误');
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
        data: 'data:' + info.mime + ';base64,' + buf.toString('base64')
      });
    }
    if (missing.length) throw new Error('工程引用的素材缺失，可从备份恢复：' + missing.join('、'));
    const runtime = {
      schema: disk.schema || 4, id: disk.id, title: disk.title,
      assets, nodes: disk.nodes, presets: disk.presets,
      characters: Array.isArray(disk.characters) ? disk.characters : []
    };
    return validateRuntime(runtime);
  }

  /* ---------- low-level writes ---------- */

  function writeAssets(root, used) {
    const imagesDir = realInside(root, IMAGES_REL);
    io.mkdirSync(imagesDir, { recursive: true });
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
      if (io.existsSync(previous)) io.unlinkSync(previous);
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
        for (const a of disk.assets) {
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

  function writeProject(root, runtime, { backup = true, autosave = false } = {}) {
    const p = validateRuntime(runtime);
    const { disk, used } = toDisk(p);
    writeAssets(root, used);                           // never deletes old images
    const target = autosave ? path.join(root, AUTOSAVE_REL, MAIN_FILE) : path.resolve(root, MAIN_FILE);
    io.mkdirSync(path.dirname(target), { recursive: true });
    if (!autosave && backup) makeBackup(root, 'save'); // before replacing the only good copy
    atomicWrite(target, disk);                        // metadata last, with rollback
    if (!autosave) updateLastGood(root, target);      // newest verified saved state
    return { root, disk, project: p };
  }

  function createProject(dir, runtime) {
    const root = ensureProjectDir(dir);
    if (io.existsSync(path.join(root, MAIN_FILE))) throw new Error('该目录已有工程，请选择空白目录或先打开它');
    const result = writeProject(root, runtime, { backup: false });
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
    for (const a of disk.assets) {
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
  function saveAsProject(dir, runtime) {
    const root = ensureProjectDir(dir);
    if (io.existsSync(path.join(root, MAIN_FILE))) throw new Error('目标目录已有工程，请选择空白目录');
    return { ...writeProject(root, runtime, { backup: false }), created: true };
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

  function inspectReferences(p) {
    const ids = new Set(p.assets.map(a => a.id));
    const layers = new Set(p.nodes.flatMap(n => (n.layers || []).map(l => l.id)));
    const brokenAssets = p.nodes.flatMap(n => (n.layers || [])
      .filter(l => !ids.has(l.asset)).map(l => n.id + '/' + l.name));
    const brokenEffects = p.nodes.flatMap(n => (n.effects || [])
      .filter(e => !layers.has(e.layer)).map(e => n.id + '/' + e.type));
    return { brokenAssets, brokenEffects };
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
    FORMAT, FORMAT_VERSION, MAIN_FILE, AUTOSAVE_REL, MAX_IMAGE_BYTES,
    constants: { FORMAT, FORMAT_VERSION, MAIN_FILE, IMAGES_REL, BACKUPS_REL, AUTOSAVE_REL },
    createProject, openProject, saveProject, autoSave, promoteAutosave, saveAsProject,
    importLegacy, validateRuntime, validateDisk, toDisk, diskToRuntime, parseDataUrl,
    imageSize, newAssetId, inspectReferences, listBackups, findRestorableBackup,
    readRecent, touchRecent, writeRecent, assetPath, friendlyError
  };
}

module.exports = createProjectStore;
module.exports.constants = { FORMAT, FORMAT_VERSION, MAIN_FILE, IMAGES_REL, BACKUPS_REL, AUTOSAVE_REL, MAX_IMAGE_BYTES };
