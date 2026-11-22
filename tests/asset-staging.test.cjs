'use strict';
/* V0.7.6-M3: streaming import, content addressing, cancellation and GC. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const createStaging = require('../desktop/asset-staging.cjs');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-stage-'));
let n = 0;
const dir = name => path.join(tmp, name + '-' + (++n));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function crc32(buf) {
  const table = [];
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[i] = c >>> 0; }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
  for (let i = 0; i < w; i++) { row[1 + i * 3] = seed & 255; row[2 + i * 3] = (seed >> 8) & 255; row[3 + i * 3] = (seed >> 16) & 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlibDeflate(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
function zlibDeflate(buf) { return require('node:zlib').deflateSync(buf); }
function wav(seconds, seed) {
  const rate = 8000, frames = Math.floor(seconds * rate), data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(i / (seed || 20)) * 12000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const sourceDir = dir('source');
fs.mkdirSync(sourceDir, { recursive: true });
const one = path.join(sourceDir, '背景A.png'), two = path.join(sourceDir, 'different-name.png');
fs.writeFileSync(one, png(32, 18, 1));
fs.writeFileSync(two, png(32, 18, 1));       // same bytes, different name
const separate = path.join(sourceDir, 'other.png');
fs.writeFileSync(separate, png(40, 22, 99));
/* name collision test uses a separate directory so the same name fits */
const nameDir = dir('same-name'); fs.mkdirSync(nameDir, { recursive: true });
const sameName = path.join(nameDir, '背景A.png'); fs.writeFileSync(sameName, png(16, 9, 7));
const audioFile = path.join(sourceDir, 'voice.wav'); fs.writeFileSync(audioFile, wav(1, 10));

const stagingRoot = dir('staging');
const staging = createStaging({ root: stagingRoot });

(async () => {
  /* 1. 单文件流式导入：返回 URL/哈希/大小/MIME/元数据，绝不包含 Base64。 */
  const events = [];
  const first = await staging.stageFile(one, { kind: 'image', assetKind: 'bg', onProgress: e => events.push(e) });
  assert.equal(first.sha256, sha(fs.readFileSync(one)));
  assert.equal(first.size, fs.statSync(one).size);
  assert.equal(first.mime, 'image/png');
  assert.equal(first.width, 32); assert.equal(first.height, 18);
  assert.equal(first.data, 'paper://app/staging/' + first.sha256 + '.png');
  assert(!JSON.stringify(first).includes('base64'), '渲染进程不得收到 Base64');
  assert(events.some(e => e.phase === 'read' && e.percent > 0), '必须有流式读取进度');
  assert(fs.existsSync(staging.absFor(first.sha256, 'png')), '暂存文件按内容寻址落盘');
  console.log('  ok  流式导入返回受控 URL、哈希、大小与 MIME，无 Base64');

  /* 2. 同内容不同文件名 -> 同一文件；同名不同内容 -> 两个文件。 */
  const renamed = await staging.stageFile(two, { kind: 'image', assetKind: 'bg' });
  assert.equal(renamed.sha256, first.sha256);
  assert.equal(renamed.data, first.data);
  assert.equal(fs.readdirSync(stagingRoot).filter(x => !x.startsWith('.tmp-')).length, 1);
  const collided = await staging.stageFile(sameName, { kind: 'image', assetKind: 'bg' });
  assert.notEqual(collided.sha256, first.sha256);
  assert.equal(path.basename(collided.source), path.basename(one), '同名不同内容不能互相覆盖');
  assert.equal(fs.readdirSync(stagingRoot).filter(x => !x.startsWith('.tmp-')).length, 2);
  console.log('  ok  改名同内容复用、同名不同内容各自独立');

  /* 3. 批量导入：进度按文件数汇总，逐条错误不阻断后续文件。 */
  const batch = await staging.stageFiles([one, separate, path.join(sourceDir, 'missing.png')], {
    kind: 'image', onProgress: () => {}
  });
  assert.equal(batch.files.length, 2);
  assert.equal(batch.errors.length, 1);
  console.log('  ok  批量导入：进度、部分失败与跳过策略');

  /* 4. 音频流式导入：WAV 头算时长，不要求整文件进内存。 */
  const audio = await staging.stageFile(audioFile, { kind: 'audio' });
  assert.equal(audio.sha256, sha(fs.readFileSync(audioFile)));
  assert.equal(audio.mime, 'audio/wav');
  assert(Math.abs(audio.duration - 1) < 0.01, '时长来自 WAV 文件头');
  console.log('  ok  音频流式导入与 WAV 头时长');

  /* 5. 取消：中途取消不留半成品。 */
  let shouldCancel = false;
  const before = fs.readdirSync(stagingRoot).length;
  const cancelled = await staging.stageFiles([audioFile], {
    kind: 'audio', token: 'cancel-test', isCancelled: () => shouldCancel,
    onProgress: e => { if (e.phase === 'read') shouldCancel = true; }
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(fs.readdirSync(stagingRoot).length, before, '取消后没有临时文件残留');
  console.log('  ok  导入可取消且不留临时文件');

  /* 6. 生命周期 GC：仍被引用的不删，无引用的过期暂存才清。 */
  const gc = staging.collectGarbage({ protectedHashes: new Set([first.sha256, audio.sha256]), maxAgeMs: 0 });
  assert(gc.kept.includes(first.sha256 + '.png'), '工程引用的暂存文件必须保留');
  assert(gc.kept.includes(audio.sha256 + '.wav'), '音频暂存文件同样受引用保护');
  assert(gc.removed.includes(collided.sha256 + '.png'), '无引用的暂存文件可以清理');
  assert(fs.existsSync(staging.absFor(first.sha256, 'png')));
  assert(!fs.existsSync(staging.absFor(collided.sha256, 'png')));
  console.log('  ok  暂存 GC 先检查真实引用，不误删仍在使用的素材');

  /* 7. 与工程存储联动：暂存素材在保存时复制进工程，重开与另存为都完整。 */
  const projectRoot = dir('project');
  const project = C.blank();
  project.title = 'M3 暂存验收';
  const a = { id: 'a_stage', name: '背景A.png', kind: 'bg', data: first.data,
    sha256: first.sha256, bytes: first.size, width: 32, height: 18 };
  const au = { id: 'au_stage', name: 'voice.wav', categories: ['voice'], data: audio.data,
    sha256: audio.sha256, bytes: audio.bytes, mime: 'audio/wav', ext: 'wav',
    duration: audio.duration, durationNote: audio.durationNote };
  project.assets = [a]; project.audioAssets = [au];
  project.nodes.push(C.makeNode('say'));
  project.nodes[0].paragraphId = project.chapters[0].paragraphs[0].id;
  C.appendAssetLayer(project.nodes[0], a);
  const store = createStore({ stagingRoot });
  const created = store.createProject(projectRoot, project);
  assert(/^paper:\/\/app\/asset\/assets\/images\//.test(created.project.assets[0].data));
  const imageFile = path.join(projectRoot, created.project.assets[0].file);
  assert(fs.readFileSync(imageFile).equals(fs.readFileSync(one)), '保存后素材内容不变');
  const reopened = store.openProject(projectRoot);
  assert.equal(reopened.project.audioAssets[0].sha256, audio.sha256);
  assert.equal(reopened.project.assets[0].bytes, first.size);
  const asRoot = dir('save-as');
  const as = store.saveAsProject(asRoot, reopened.project, projectRoot);
  assert(fs.existsSync(path.join(asRoot, as.project.assets[0].file)), '另存为复制了暂存来源的素材');
  console.log('  ok  暂存 → 工程引用 → 正式保存，重开与另存为一致');

  /* 8. 跨表示精确去重：已落盘 URL + 新导入哈希识别为同一素材。 */
  const diskAsset = reopened.project.audioAssets[0];
  const exact = C.assetForAudioImport(reopened.project, {
    id: 'should_not_be_used', name: 'voice-renamed.wav', categories: ['bgm'],
    data: audio.data, sha256: audio.sha256, mime: 'audio/wav', ext: 'wav',
    bytes: audio.bytes, duration: audio.duration
  });
  assert.equal(exact.reused, true, '跨表示同内容必须复用');
  assert.equal(exact.asset.id, diskAsset.id, '复用不产生第二个素材 ID');
  assert.deepEqual(exact.categories, ['voice', 'bgm']);
  console.log('  ok  跨表示精确去重（同内容、不同名、不同表示）');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS: asset staging, cross-representation dedupe and lifecycle');
})().catch(err => { console.error(err); process.exit(1); });
