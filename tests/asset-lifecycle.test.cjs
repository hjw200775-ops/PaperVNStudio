'use strict';
/*
 * V0.7.6-M3 回归：内容寻址去重矩阵 + 暂存素材生命周期状态机。
 *
 * 覆盖任务书 M3-2 的六类去重场景、M3-3 的导入后未保存 / 取消 / 失败中断 /
 * 撤销重做 / 删除后撤销 / 保存失败重试 / 关闭不保存 / 异常退出重启 / 另存为，
 * 并明确验证 GC 绝不误删仍被当前工程、历史快照或撤销栈引用的素材。
 * 全部使用真实 fs 与真实 project-store，不使用模拟存储。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const createStaging = require('../desktop/asset-staging.cjs');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-m3-life-'));
let seq = 0;
const dir = n => path.join(tmp, n + '-' + (++seq));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function crc32(buf) {
  const t = [];
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function png(w, h, seed) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = seed & 255; row[2 + x * 3] = (seed >> 8) & 255; row[3 + x * 3] = (seed >> 16) & 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds, seed) {
  const rate = 8000, frames = seconds * rate, data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(i / (seed || 12)) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const url = (b, mime) => 'data:' + mime + ';base64,' + b.toString('base64');
const IMG_A = png(24, 14, 0x102030), IMG_B = png(24, 14, 0x405060), AUD_A = wav(.5, 12), AUD_B = wav(.5, 31);
const H_IMG_A = sha(IMG_A), H_IMG_B = sha(IMG_B), H_AUD_A = sha(AUD_A), H_AUD_B = sha(AUD_B);

const src = dir('source'); fs.mkdirSync(src, { recursive: true });
const fSame1 = path.join(src, 'a.png'), fRenamed = path.join(src, 'renamed.png'), fOther = path.join(src, 'b.png');
fs.writeFileSync(fSame1, IMG_A); fs.writeFileSync(fRenamed, IMG_A); fs.writeFileSync(fOther, IMG_B);
const sameNameDir = dir('same-name'); fs.mkdirSync(sameNameDir, { recursive: true });
const fSameNameOther = path.join(sameNameDir, 'a.png'); fs.writeFileSync(fSameNameOther, IMG_B);
const fAud1 = path.join(src, 'v.wav'), fAudRenamed = path.join(src, 'v-renamed.wav'), fAudOther = path.join(src, 'v2.wav');
fs.writeFileSync(fAud1, AUD_A); fs.writeFileSync(fAudRenamed, AUD_A); fs.writeFileSync(fAudOther, AUD_B);

const stagingRoot = dir('staging');
const staging = createStaging({ root: stagingRoot });
const store = createStore({ stagingRoot });

/* 渲染进程侧的引用保护：当前工程 + 撤销栈 + 重做栈。与 app.js stagedRefs 同构。 */
function refsOf(current, past = [], future = []) {
  const out = new Set();
  for (const q of [current, ...past, ...future]) {
    for (const a of [...(q.assets || []), ...(q.audioAssets || [])]) {
      const h = staging.hashFromUrl(a.data); if (h) out.add(h);
    }
  }
  return out;
}
function baseProject() {
  const p = C.blank(); p.title = 'M3 生命周期';
  p.nodes.push(C.makeNode('say'));
  p.nodes[0].paragraphId = p.chapters[0].paragraphs[0].id;
  return p;
}

(async () => {
  /* ============ M3-2 去重矩阵 ============ */
  const a1 = await staging.stageFile(fSame1, { kind: 'image', assetKind: 'bg' });
  const a2 = await staging.stageFile(fRenamed, { kind: 'image', assetKind: 'bg' });
  const a3 = await staging.stageFile(fSameNameOther, { kind: 'image', assetKind: 'bg' });
  assert.equal(a1.sha256, H_IMG_A);
  assert.equal(a2.sha256, H_IMG_A, '文件名不同但内容相同 -> 同一内容标识');
  assert.equal(a2.data, a1.data, '改名同内容复用同一个暂存文件');
  assert.equal(a3.sha256, H_IMG_B, '文件名相同但内容不同 -> 不同内容标识');
  assert.notEqual(a3.data, a1.data);
  assert.equal(fs.readdirSync(stagingRoot).filter(x => /^[a-f0-9]{64}\./.test(x)).length, 2,
    '重复导入不增加磁盘占用');

  const u1 = await staging.stageFile(fAud1, { kind: 'audio' });
  const u2 = await staging.stageFile(fAudRenamed, { kind: 'audio' });
  const u3 = await staging.stageFile(fAudOther, { kind: 'audio' });
  assert.equal(u1.sha256, H_AUD_A); assert.equal(u2.sha256, H_AUD_A);
  assert.equal(u3.sha256, H_AUD_B); assert.notEqual(u3.data, u1.data);

  /* 图片去重按内容 + 用途；音频去重按内容，分类合并。 */
  const p = baseProject();
  const i1 = C.assetForImport(p, { id: 'i1', name: 'a.png', kind: 'bg', data: a1.data, sha256: a1.sha256 });
  p.assets.push(i1.asset);
  const i2 = C.assetForImport(p, { id: 'i2', name: 'renamed.png', kind: 'bg', data: a2.data, sha256: a2.sha256 });
  assert.equal(i2.reused, true, '图片：改名同内容复用');
  assert.equal(i2.asset.id, 'i1');
  const i3 = C.assetForImport(p, { id: 'i3', name: 'a.png', kind: 'bg', data: a3.data, sha256: a3.sha256 });
  assert.equal(i3.reused, false, '图片：同名不同内容不复用');
  const i4 = C.assetForImport(p, { id: 'i4', name: 'a.png', kind: 'char', data: a1.data, sha256: a1.sha256 });
  assert.equal(i4.reused, false, '图片：同内容不同用途仍分开，避免 kind 被带回');
  const v1 = C.assetForAudioImport(p, { id: 'v1', name: 'v', categories: ['voice'],
    data: u1.data, sha256: u1.sha256, mime: 'audio/wav', ext: 'wav', bytes: u1.size });
  p.audioAssets.push(v1.asset);
  const v2 = C.assetForAudioImport(p, { id: 'v2', name: 'v-renamed', categories: ['bgm'],
    data: u2.data, sha256: u2.sha256, mime: 'audio/wav', ext: 'wav', bytes: u2.size });
  assert.equal(v2.reused, true, '音频：改名同内容复用');
  assert.deepEqual(v2.categories, ['voice', 'bgm'], '分类合并');
  const v3 = C.assetForAudioImport(p, { id: 'v3', name: 'v', categories: ['voice'],
    data: u3.data, sha256: u3.sha256, mime: 'audio/wav', ext: 'wav', bytes: u3.size });
  assert.equal(v3.reused, false, '音频：同名不同内容不复用');
  console.log('  ok  M3-2 去重矩阵：改名同内容 / 同名不同内容 / 图片与音频各自语义');

  /* ============ M3-3 生命周期：待导入 → 暂存 → 工程引用 → 正式保存 ============ */
  const root = dir('project');
  p.assets = [i1.asset, i3.asset, i4.asset];
  p.audioAssets = [v1.asset, v3.asset];
  C.appendAssetLayer(p.nodes[0], i1.asset);

  /* 1) 导入后尚未保存 + 撤销/重做栈仍引用：GC 不得清理。 */
  const past = [C.clone(p)], future = [];
  p.assets.push({ id: 'tmp_only', name: 'only-in-current.png', kind: 'bg', data: a3.data,
    sha256: a3.sha256, bytes: a3.size });
  const protectedBefore = refsOf(p, past, future);
  assert(protectedBefore.has(a1.sha256) && protectedBefore.has(u1.sha256));
  const gc1 = staging.collectGarbage({ protectedHashes: protectedBefore, maxAgeMs: 0 });
  assert(!gc1.removed.includes(a1.sha256 + '.png'), '当前工程引用的暂存素材不能删');
  assert(!gc1.removed.includes(u1.sha256 + '.wav'), '当前工程引用的暂存音频不能删');
  console.log('  ok  M3-3 导入后未保存：GC 保护当前工程与撤销栈引用');

  /* 2) 删除素材后撤销：历史快照里的哈希必须继续保护暂存文件。 */
  const snapshot = C.clone(p);
  p.assets = p.assets.filter(x => x.id !== 'tmp_only');
  past.push(snapshot);
  const gc2 = staging.collectGarbage({ protectedHashes: refsOf(p, past, future), maxAgeMs: 0 });
  assert(!gc2.removed.includes(a3.sha256 + '.png'), '撤销栈里的素材不能被清理');
  const undone = C.clone(past.pop());
  assert(undone.assets.some(x => x.id === 'tmp_only'), '撤销能恢复被删除的素材');
  console.log('  ok  M3-3 删除素材后撤销：历史快照引用受保护');

  /* 3) 取消 / 失败中断：不留半成品，已成功文件仍在。 */
  let cancel = false;
  const beforeCancel = staging.stats();
  const cancelled = await staging.stageFiles([fAud1], { kind: 'audio',
    isCancelled: () => cancel, onProgress: e => { if (e.phase === 'read') cancel = true; } });
  assert.equal(cancelled.cancelled, true);
  assert.equal(staging.stats().bytes, beforeCancel.bytes, '取消后暂存体积不变');
  assert(!fs.readdirSync(stagingRoot).some(x => x.startsWith('.tmp-')), '取消后无临时文件残留');
  const failed = await staging.stageFiles([path.join(src, 'missing.png'), fOther], { kind: 'image' });
  assert.equal(failed.errors.length, 1, '失败文件给出错误提示');
  assert.equal(failed.files.length, 1, '一个失败不阻断后续文件');
  assert(fs.existsSync(staging.absFor(H_IMG_B, 'png')), '中断前的成功文件未被破坏');
  console.log('  ok  M3-3 取消 / 失败中断：不留半成品，错误可见且不阻断后续');

  /* 4) 保存失败后重试：第一次失败不改工程 JSON，第二次成功保持一致性。 */
  p.assets = p.assets.filter(x => x.id !== 'tmp_only');
  const broken = C.clone(p);
  broken.assets.push({ id: 'broken', name: 'gone.png', kind: 'bg',
    data: staging.urlFor('f'.repeat(64), 'png'), sha256: 'f'.repeat(64), bytes: 1 });
  assert.throws(() => store.createProject(root, broken), /素材文件缺失|素材路径无效|素材为空/,
    '保存失败必须报错而不是写出指向不存在文件的工程');
  assert(!fs.existsSync(path.join(root, store.constants.MAIN_FILE)), '失败后不得留下主工程 JSON');
  const created = store.createProject(root, p);
  const disk = JSON.parse(fs.readFileSync(path.join(root, store.constants.MAIN_FILE), 'utf8'));
  for (const a of [...disk.assets, ...disk.audioAssets]) {
    assert(fs.existsSync(path.join(root, a.file)), '工程引用的素材必须真实存在：' + a.file);
    assert(/^assets\/(images|audio)\//.test(a.file), '保存后不能残留暂存地址：' + a.file);
  }
  assert(!JSON.stringify(disk).includes('base64,'), '磁盘工程无 Base64');
  console.log('  ok  M3-3 保存失败后重试：不产生悬空资源地址，JSON 与素材一致');

  /* 5) 已保存素材 + 新导入重复：跨表示精确复用；重开与另存为后仍成立。 */
  const reopened = store.openProject(root).project;
  const imgDisk = reopened.assets.find(x => x.sha256 === H_IMG_A);
  const audDisk = reopened.audioAssets.find(x => x.sha256 === H_AUD_A);
  assert(imgDisk && audDisk, '重开后仍保留内容哈希');
  const reImg = C.assetForImport(reopened, { id: 'new', name: 'again.png', kind: 'bg',
    data: a1.data, sha256: H_IMG_A });
  assert.equal(reImg.reused, true, '重开后跨表示去重仍生效');
  assert.equal(reImg.asset.id, imgDisk.id);
  const reAud = C.assetForAudioImport(reopened, { id: 'new2', name: 'again.wav', categories: ['sfx'],
    data: u1.data, sha256: H_AUD_A, mime: 'audio/wav', ext: 'wav', bytes: u1.size });
  assert.equal(reAud.reused, true, '重开后音频跨表示去重仍生效');
  assert.equal(reAud.asset.id, audDisk.id);

  const asRoot = dir('save-as');
  store.saveAsProject(asRoot, reopened, root);
  const asDisk = JSON.parse(fs.readFileSync(path.join(asRoot, store.constants.MAIN_FILE), 'utf8'));
  for (const a of [...asDisk.assets, ...asDisk.audioAssets]) {
    assert(fs.existsSync(path.join(asRoot, a.file)), '另存为复制了素材：' + a.file);
    assert.equal(sha(fs.readFileSync(path.join(asRoot, a.file))), a.sha256, '另存为素材内容未变');
  }
  const asOpened = store.openProject(asRoot).project;
  const asImg = C.assetForImport(asOpened, { id: 'new3', name: 'again.png', kind: 'bg',
    data: a1.data, sha256: H_IMG_A });
  const asAud = C.assetForAudioImport(asOpened, { id: 'new4', name: 'again.wav', categories: ['voice'],
    data: u1.data, sha256: H_AUD_A, mime: 'audio/wav', ext: 'wav', bytes: u1.size });
  assert.equal(asImg.reused, true, '另存为后仍能识别重复图片');
  assert.equal(asAud.reused, true, '另存为后仍能识别重复音频');
  console.log('  ok  M3-2/M3-3 保存 / 重开 / 另存为后跨表示精确去重');

  /* 6) 关闭工程不保存：自动保存草稿可恢复，且不写主工程。 */
  const draft = store.autoSave(root, C.clone(Object.assign({}, p, { title: '未保存的草稿' })));
  assert(draft.disk.savedAt, '自动保存写入草稿');
  const draftFile = path.join(root, store.constants.AUTOSAVE_REL, store.constants.MAIN_FILE);
  assert(fs.existsSync(draftFile));
  const mainBefore = fs.readFileSync(path.join(root, store.constants.MAIN_FILE), 'utf8');
  assert(!mainBefore.includes('未保存的草稿'), '关闭不保存不得覆盖主工程');
  store.promoteAutosave(root);
  const promoted = JSON.parse(fs.readFileSync(path.join(root, store.constants.MAIN_FILE), 'utf8'));
  assert.equal(promoted.title, '未保存的草稿', '恢复草稿生效');
  assert(fs.existsSync(path.join(root, promoted.assets[0].file)), '恢复后素材引用仍有效');
  console.log('  ok  M3-3 关闭不保存 / 自动保存恢复：主工程不被覆盖且素材有效');

  /* 7) 异常退出后重新启动：无渲染进程引用时可整体清理。 */
  const orphan = await staging.stageFile(fOther, { kind: 'image' });
  assert(fs.existsSync(staging.absFor(orphan.sha256, 'png')));
  const afterRestart = createStaging({ root: stagingRoot });
  afterRestart.reset();
  assert(!fs.existsSync(staging.absFor(orphan.sha256, 'png')), '重启清理无引用的暂存文件');
  console.log('  ok  M3-3 异常退出后重启：孤儿暂存可清理');

  /* 8) 静态约束：桌面导入路径不得把素材读成 Base64。 */
  const app = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8');
  for (const line of app.split('\n')) {
    if (!line.includes('readAsDataURL') && !line.includes('new FileReader')) continue;
    const desktopImport = /\bfunction upload\b|\bfunction importAudioAsset\b|#titleBgImport|#addExpr/.test(line);
    if (desktopImport) {
      assert(/H\?f\.dataUrl/.test(line) || /pick\('audio'/.test(line),
        '桌面版素材入口不得使用 FileReader 读素材：' + line.slice(0, 120));
    }
  }
  assert(/function pick\(accept/.test(app) && /stageFiles/.test(app), '批量导入入口存在');
  console.log('  ok  M3-1 所有桌面素材入口走受控 URL（Base64 仅保留在浏览器版回退）');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS: M3 content addressing, dedupe matrix and staging lifecycle');
})().catch(e => { console.error(e); process.exit(1); });
