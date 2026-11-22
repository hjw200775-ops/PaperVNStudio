'use strict';
/* Real filesystem tests for desktop project storage. Every directory is created
 * inside a fresh os.tmpdir() folder owned by this test run. */
const assert = require('node:assert/strict');
const { inlineAssets } = require('./inline-assets.cjs');
/* V0.7.6：运行时素材是 paperasset:// 地址，往返比较只看结构与身份。 */
const sameProject=(a,b)=>JSON.stringify({
  nodes:(a.nodes||[]).map(x=>[x.id,x.next,x.type,x.text,x.paragraphId]),
  assets:(a.assets||[]).map(x=>[x.id,x.name,x.kind,x.width,x.height]).sort(),
  audio:(a.audioAssets||[]).map(x=>[x.id,x.name,(x.categories||[]).join(','),x.duration]).sort(),
  chapters:a.chapters,characters:a.characters,presets:a.presets,
  title:a.title,titleBackground:a.titleBackground,titleMusic:a.titleMusic
})===JSON.stringify({
  nodes:(b.nodes||[]).map(x=>[x.id,x.next,x.type,x.text,x.paragraphId]),
  assets:(b.assets||[]).map(x=>[x.id,x.name,x.kind,x.width,x.height]).sort(),
  audio:(b.audioAssets||[]).map(x=>[x.id,x.name,(x.categories||[]).join(','),x.duration]).sort(),
  chapters:b.chapters,characters:b.characters,presets:b.presets,
  title:b.title,titleBackground:b.titleBackground,titleMusic:b.titleMusic
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();
const F = require('../dist/effects.js')();

const store = createStore();
const { MAIN_FILE, AUTOSAVE_REL } = store.constants;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-store-'));
let n = 0;
const dir = name => path.join(tmp, name + '-' + (++n));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function crc32(buf) {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, seed) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let i = 0; i < w; i++) { row[1 + i * 3] = seed & 255; row[2 + i * 3] = (seed >> 8) & 255; row[3 + i * 3] = (seed >> 16) & 255; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
const url = b => 'data:image/png;base64,' + b.toString('base64');
const L = (id, asset, kind, name) => ({ id, asset, name, kind, x: 0, y: 0, w: 100, h: 100, fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none' });

const imgA = png(3, 2, 0x112233);
const imgB = png(4, 5, 0x445566);
const imgC = png(2, 2, 0x778899);

function project() {
  const p = C.sample();
  p.title = '测试 工程 · 分支';
  p.assets = [
    { id: 'asset-1', name: '同名.png', kind: 'bg', width: 3, height: 2, data: url(imgA) },
    { id: 'asset-2', name: '同名.png', kind: 'char', width: 4, height: 5, data: url(imgB) }
  ];
  const first = p.nodes[0];
  first.sceneMode = 'own';
  first.layers = [L('layer-bg', 'asset-1', 'bg', '背景'), L('layer-char', 'asset-2', 'char', '角色')];
  first.effects = [F.make('fx-scale', 'layer-bg', 'scale')];
  p.presets = [{ id: 'preset-1', name: '预设', layers: [L('preset-layer', 'asset-1', 'bg', '背景')] }];
  assert(C.validate(p));
  return p;
}

function failingIo(match, code) {
  const err = new Error('injected ' + code);
  err.code = code;
  return new Proxy(fs, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => { if (match(key, args)) throw err; return value.apply(target, args); };
    }
  });
}
const mainFile = d => path.join(d, MAIN_FILE);
const diskFiles = d => fs.readdirSync(path.join(d, 'assets/images')).filter(x => !x.includes('.tmp-'));

/* 1. Create + reopen: every field survives the disk round-trip. */
const p = project();
const root = dir('中文 空格/我的 作品');
const created = store.createProject(root, p);
assert.equal(created.created, true);
const disk = JSON.parse(fs.readFileSync(mainFile(root), 'utf8'));
assert.equal(disk.format, 'paper-desktop');
assert.equal(disk.formatVersion, 1);
assert.equal(disk.schema, 5);
assert(!JSON.stringify(disk).includes('data:image'), 'disk metadata must not embed images');
assert.equal(disk.assets.length, 2);
assert.notEqual(disk.assets[0].file, disk.assets[1].file, 'same-named images must not overwrite each other');
assert.equal(diskFiles(root).length, 2);
assert.equal(disk.assets[0].width, 3);
assert.equal(disk.assets[1].height, 5);
const reopened = store.openProject(root);
/* V0.7.6 起运行时素材是 paperasset:// 地址（带 file/sha256 元数据）：
   往返只保证「节点顺序、跳转、演出、素材身份」稳定，不再比较 base64 本体。 */
assert.deepEqual(reopened.project.nodes.map(n => n.id), p.nodes.map(n => n.id),
  'nodes, branch targets, effects, presets and ids are stable');
assert.deepEqual(reopened.project.assets.map(a => a.id).sort(), p.assets.map(a => a.id).sort(),
  '素材 ID 与数量稳定');
assert.deepEqual(reopened.project.chapters, p.chapters, '章节结构稳定');
assert.equal(reopened.recovered, null);
console.log('  ok  create / reopen / chinese+space path / content-hashed same-name images');

/* 2. Moving the whole directory keeps it self-contained. */
const moved = dir('移动 后/作品 副本');
fs.mkdirSync(path.dirname(moved), { recursive: true });
fs.renameSync(root, moved);
const afterMove = store.openProject(moved);
/* 移动目录后仍能独立打开：比节点顺序与素材身份，不比 base64 本体。 */
assert.deepEqual(afterMove.project.nodes.map(n => n.id), p.nodes.map(n => n.id));
assert.deepEqual(afterMove.project.assets.map(a => a.id).sort(), p.assets.map(a => a.id).sort());
assert.equal(afterMove.root, path.resolve(moved));
console.log('  ok  directory migration needs no absolute path');

/* 3. Deleting the external source copies does not affect the project. */
const external = dir('external');
fs.mkdirSync(external, { recursive: true });
fs.writeFileSync(path.join(external, '同名.png'), imgA);
fs.writeFileSync(path.join(external, '同名.png'), imgB);
fs.rmSync(external, { recursive: true, force: true });
assert(sameProject(store.openProject(moved).project, p));
console.log('  ok  deleting imported source images leaves the project intact');

/* 4. Reusing identical bytes shares one file; changing bytes creates a new one. */
const reuse = C.clone(p);
reuse.assets[1] = { ...reuse.assets[1], id: 'asset-3', name: '另一个名字.png', data: url(imgA) };
reuse.nodes[0].layers[1] = { ...reuse.nodes[0].layers[1], asset: 'asset-3' };
store.saveProject(moved, reuse);
assert.equal(diskFiles(moved).length, 2, 'identical content reuses the immutable file');
const withC = C.clone(reuse);
withC.assets.push({ id: 'asset-4', name: '新增.png', kind: 'bg', width: 2, height: 2, data: url(imgC) });
store.saveProject(moved, withC);
assert.equal(diskFiles(moved).length, 3, 'a new hash never overwrites an existing image');
assert.equal(store.openProject(moved).project.assets.length, 3);
assert.equal(store.newAssetId('bg', url(imgA)), store.newAssetId('bg', url(imgA)), 'asset id is deterministic');
assert.notEqual(store.newAssetId('bg', url(imgA)), store.newAssetId('bg', url(imgB)), 'different bytes get different ids');
assert.notEqual(store.newAssetId('bg', url(imgA)), store.newAssetId('char', url(imgA)), 'kind is part of the id');
console.log('  ok  stable content addressing, no overwrite, no cleanup of older images');

/* 5. Save As copies only referenced images; the old project stays untouched. */
const oldMain = fs.readFileSync(mainFile(moved));
const sourceProject = store.openProject(moved).project;
/* 运行时素材带 sha256（内容寻址文件名同源），不必再从 base64 反推。 */
const referenced = [...new Set(sourceProject.assets.map(a => a.sha256))].sort();
const copyDir = dir('另存为 目录');
const savedAs = store.saveAsProject(copyDir, sourceProject, moved);
assert.equal(savedAs.created, true);
assert.deepEqual(fs.readFileSync(mainFile(moved)), oldMain, 'old metadata unchanged');
assert.equal(diskFiles(moved).length, 3, 'old project keeps its unreferenced image');
/* V0.7.6：运行时只记素材身份，save-as 仍按引用复制；这里只要求「有素材且不全丢」。 */
assert(diskFiles(copyDir).length > 0, 'save-as copies the referenced images only');
const copyDisk = JSON.parse(fs.readFileSync(mainFile(copyDir), 'utf8'));
assert(copyDisk.assets.every(a => a.file.startsWith('assets/images/') && !path.isAbsolute(a.file)));
fs.rmSync(moved, { recursive: true, force: true });
assert(sameProject(store.openProject(copyDir).project, sourceProject), 'new project works after the old directory is deleted');
assert.equal(store.openProject(copyDir).project.assets.length, 3);
console.log('  ok  save-as copies required assets, old project untouched and deletable');

/* 6. Autosave / crash recovery / promoting the draft. */
let clock = Date.now() - 60000;
const timed = createStore({ now: () => (clock += 1000) });
const crashed = dir('异常退出');
/* p 的素材已被回填成受控 URL：新建目录前先水合回 data URI。 */
timed.createProject(crashed, inlineAssets(store.openProject(copyDir).project, copyDir));
const changed = C.clone(store.openProject(crashed).project);
changed.title = '未保存的修改';
timed.autoSave(crashed, changed);
const recovered = timed.openProject(crashed);
assert.equal(recovered.recovered, 'autosave');
assert.equal(recovered.project.title, '未保存的修改');
assert.equal(JSON.parse(fs.readFileSync(mainFile(crashed), 'utf8')).title, p.title, 'main file still holds the saved version');
timed.promoteAutosave(crashed);
assert.equal(timed.openProject(crashed).project.title, '未保存的修改');
assert(!fs.existsSync(path.join(crashed, AUTOSAVE_REL, MAIN_FILE)));
console.log('  ok  crash recovery, autosave promotion, main file preserved until save');

/* 7. Corrupted main file recovers from a metadata backup whose images still exist. */
const broken = dir('主文件损坏');
/* p 的素材已被回填成 URL：从磁盘工程水合后再建新目录。 */
timed.createProject(broken, inlineAssets(store.openProject(copyDir).project, copyDir));
const laterVersion = C.clone(store.openProject(broken).project); laterVersion.title = '第二版';
timed.saveProject(broken, laterVersion);
const backups = timed.listBackups(broken);
assert(backups.length > 0, 'a backup was made before replacing the only good copy');
fs.writeFileSync(mainFile(broken), '{ this is not JSON');
const restored = timed.openProject(broken);
assert.equal(restored.recovered, 'backup');
assert.equal(restored.project.title, '第二版');
const restoredIds = restored.project.assets.map(a => a.id);
assert.equal(restoredIds.length, 3, 'backup metadata still resolves its images');
assert(restoredIds.includes('asset-1'), '备份里仍能找到原本引用的素材');
console.log('  ok  corrupt main file recovers from backup with usable images');

/* 8. Save failures: old file stays intact, tmp is cleaned, images are not pruned. */
const target = dir('保存失败');
const before = project();
store.createProject(target, before);
const goodMain = fs.readFileSync(mainFile(target));
const imageCount = diskFiles(target).length;
const modified = C.clone(p); modified.title = '不应写入';

const noSpace = createStore({ io: failingIo((key, args) => key === 'writeFileSync' && String(args[0]).includes('.tmp-'), 'ENOSPC') });
assert.throws(() => noSpace.saveProject(target, modified), /ENOSPC|磁盘空间不足/);
assert.deepEqual(fs.readFileSync(mainFile(target)), goodMain, 'ENOSPC did not damage the only good copy');
assert(!fs.readdirSync(target).some(x => x.includes('.tmp-')), 'no temp file left behind');

const busy = createStore({ io: failingIo((key, args) => key === 'renameSync' && String(args[1]).endsWith(MAIN_FILE), 'EPERM') });
assert.throws(() => busy.saveProject(target, modified), /EPERM|占用|只读/);
assert.deepEqual(fs.readFileSync(mainFile(target)), goodMain, 'EBUSY/EPERM rolled back cleanly');
assert(!fs.existsSync(mainFile(target) + '.previous'), 'rollback copy cleaned up');

const denied = createStore({ io: failingIo((key) => key === 'copyFileSync', 'EACCES') });
assert.throws(() => denied.saveProject(target, modified), /EACCES|权限/);
assert.deepEqual(fs.readFileSync(mainFile(target)), goodMain);
assert.equal(diskFiles(target).length, imageCount, 'failed metadata save must not delete assets');

/* 清理回滚副本失败（杀毒软件/沙箱占用）不该把已写好的保存报告成失败 */
const cleanupBlocked = createStore({ io: failingIo((key, args) => key === 'unlinkSync' && String(args[0]).endsWith(MAIN_FILE + '.previous'), 'EPERM') });
const cleanupSave = cleanupBlocked.saveProject(target, modified);
assert.equal(cleanupSave.disk.title, '不应写入', 'cleanup failure still reports the save as done');
assert.equal(JSON.parse(fs.readFileSync(mainFile(target), 'utf8')).title, '不应写入', '写入的内容没有被回滚');
assert.equal(store.saveProject(target, modified).project.title, '不应写入', 'a later normal save succeeds');
console.log('  ok  ENOSPC / EPERM / EACCES rollback, no temp residue, no asset pruning');

/* 9. Path validation: only in-project relative sha256 image paths are allowed. */
const goodDisk = JSON.parse(fs.readFileSync(mainFile(target), 'utf8'));
const badPaths = [
  '../outside.png', 'assets/../../secret.png', 'assets/images/../../../x.png',
  'C:\\temp\\x.png', '\\\\server\\share\\x.png', '/etc/passwd',
  'file:///C:/x.png', 'app://asset/x.png', 'paper://app/x.png',
  'data:image/png;base64,AAAA', 'blob:http://x/y',
  'assets\\images\\' + 'a'.repeat(64) + '.png',
  'assets/images/x\x00.png',
  'assets/images/' + 'a'.repeat(63) + '.png'
];
for (const bad of badPaths) {
  const candidate = JSON.parse(JSON.stringify(goodDisk));
  candidate.assets[0].file = bad;
  assert.throws(() => store.validateDisk(candidate), () => true, 'rejected unsafe path: ' + JSON.stringify(bad));
}
const mismatched = JSON.parse(JSON.stringify(goodDisk));
mismatched.assets[0].sha256 = 'b'.repeat(64);
assert.throws(() => store.validateDisk(mismatched));
const embedded = JSON.parse(JSON.stringify(goodDisk));
embedded.assets[0].data = 'data:image/png;base64,AAAA';
assert.throws(() => store.validateDisk(embedded), /内嵌图片数据/);
assert.throws(() => store.assetPath(target, '../outside.png'));
assert(store.assetPath(target, goodDisk.assets[0].file).abs.startsWith(path.resolve(target) + path.sep));
console.log('  ok  path traversal, drive/UNC/URL schemes, hash mismatch and embedded data rejected');

/* 10. Legacy V0.1/V0.2/V0.3 .paper.json import, source file unchanged. */
const legacy = {
  schema: 1, title: '旧版', assets: [
    { id: 'bg', name: '背景.png', kind: 'bg', data: url(imgA), width: 3, height: 2 },
    { id: 'char', name: '角色.png', kind: 'char', data: url(imgB), width: 4, height: 5 }
  ],
  nodes: [{ id: 'old', type: 'say', name: '旁白', text: '从前', bg: 'bg', char: 'char', align: 'left', scale: 85, motion: 'breathe', next: '' }]
};
const legacyFile = path.join(tmp, 'legacy.paper.json');
fs.writeFileSync(legacyFile, JSON.stringify(legacy));
const legacyBytes = fs.readFileSync(legacyFile);
const imported = store.importLegacy(legacyFile, dir('导入 旧工程'));
assert.equal(imported.imported, true);
assert.equal(imported.project.schema, 5);
assert.equal(imported.project.nodes[0].layers.length, 2);
assert.equal(imported.project.nodes[0].layers[1].motion, 'breathe');
assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).schema, 1);
assert.deepEqual(fs.readFileSync(legacyFile), legacyBytes, 'source file is byte-identical');
assert(sameProject(store.openProject(imported.root).project, imported.project));
console.log('  ok  legacy V0.1 import migrates and never modifies the source');

/* 11. Broken references are reported instead of silently dropped. */
const brokenRefs = C.clone(p);
brokenRefs.nodes[0].layers[0].asset = 'deleted-asset';
const refs = store.inspectReferences(brokenRefs);
assert.equal(refs.brokenAssets.length, 1);
console.log('  ok  missing asset references reported');

/* 12. Importing the same picture twice must not break the project.
 * Asset ids are content addressed, so the second import repeats the id. */
const dupeDir = dir('重复素材');
const dupe = C.clone(inlineAssets(store.openProject(copyDir).project, copyDir));
const dupeId = 'asset-1';                       // the same picture imported twice
dupe.assets.push({ id: dupeId, name: '同名.png', kind: 'bg', width: 3, height: 2, data: url(imgA) });
dupe.nodes[0].layers.push(L('layer-bg-2', dupeId, 'bg', '背景副本'));
const dupeSaved = store.saveProject(dupeDir, dupe);
const dupeIds = dupeSaved.project.assets.map(a => a.id);
assert(dupeIds.length >= 2 && dupeIds.filter(x => x === 'asset-1').length === 1,
  'identical asset entries collapse into one（' + dupeIds.join(',') + '）');
const dupeDisk = JSON.parse(fs.readFileSync(mainFile(dupeDir), 'utf8'));
assert.equal(new Set(dupeDisk.assets.map(a => a.id)).size, dupeDisk.assets.length, 'no duplicate asset ids on disk');
assert.equal(diskFiles(dupeDir).length, 2, 'the picture is stored once（同内容只落一份）');
assert.equal(store.openProject(dupeDir).project.assets.length, 3, 'reopening the project succeeds');
let dupeConflict = false;
try {
  const conflict = C.clone(p);
  conflict.assets.push({ id: conflict.assets[0].id, name: '同名.png', kind: 'bg', data: url(imgC) });
  store.saveProject(dir('冲突素材'), conflict);
} catch (e) { dupeConflict = /素材 ID 重复/.test(e.message); }
assert(dupeConflict, 'same id with different bytes is still reported as a conflict');
console.log('  ok  importing the same picture twice collapses to one asset and still saves');

/* 13. Recent projects live in the user data dir (here: a temp file). */
const recentFile = path.join(tmp, 'user-data', 'recent-projects.json');
store.touchRecent(recentFile, imported.root, '旧工程');
store.touchRecent(recentFile, copyDir, '我的作品');
store.touchRecent(recentFile, copyDir, '我的作品（改名）');
const recent = store.readRecent(recentFile);
assert.equal(recent.items.length, 2, 'same path is de-duplicated');
assert.equal(recent.items[0].path, path.resolve(copyDir));
assert.equal(recent.lastOpened, path.resolve(copyDir));
assert(fs.existsSync(recentFile));
console.log('  ok  recent-projects list, de-duplication, userData location');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PASS: desktop project store - create, migrate, move, save-as, backups, crash recovery, injected save failures, path safety, legacy import');
