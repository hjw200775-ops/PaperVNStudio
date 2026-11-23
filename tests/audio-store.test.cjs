'use strict';
/* V0.5 桌面存储：音频独立目录、内容寻址复用、原子保存 / 备份恢复 / 目录移动，
   以及「图片专用校验不得误用于音频」。全部在 os.tmpdir() 的新目录里进行。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const createStore = require('../desktop/project-store.cjs');
const createVNCore = require('../dist/core.js');
const createPaperAudio = require('../dist/audio.js');

const store = createStore();
const C = createVNCore();
const A = createPaperAudio();
const { MAIN_FILE, AUDIO_REL } = store.constants;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-audio-store-'));
let n = 0;
const dir = name => path.join(tmp, name + '-' + (++n));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function wav(seconds, sampleRate = 8000, channels = 1, seed = 1) {
  const bytes = sampleRate * seconds * channels * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let i = 44; i < b.length; i++) b[i] = (i * seed) & 255;
  return b;
}
const url = b => 'data:audio/wav;base64,' + b.toString('base64');
function asset(id, buf, categories = ['bgm'], duration = 1) {
  return { id, name: id + '.wav', categories, data: url(buf), mime: 'audio/wav', ext: 'wav',
    bytes: buf.length, duration };
}
function project(audio) {
  const p = C.blank();
  p.title = '音频测试工程';
  p.audioAssets = audio;
  const pid = p.chapters[0].paragraphs[0].id;
  for (let i = 0; i < 3; i++) {
    const node = C.makeNode('say');
    Object.assign(node, { id: 'n' + i, text: '第 ' + (i + 1) + ' 句', paragraphId: pid, next: i < 2 ? 'n' + (i + 1) : '' });
    p.nodes.push(node);
  }
  if (audio.length) {
    p.nodes[0].audio = { bgm: { action: 'play', audioId: audio[0].id, volume: .8, loop: true, fadeIn: .3, fadeOut: .4 } };
    p.nodes[1].audio = { sfx: [{ id: 's1', audioId: audio[0].id, volume: 1, delay: .2 }],
      voice: { audioId: audio[audio.length - 1].id, volume: .9 } };
    p.nodes[2].audio = { bgm: { action: 'stop', fadeOut: .2 } };
  }
  assert(C.validate(p));
  return p;
}

/* 1. 五个音频素材落盘：内容寻址、元数据只有相对路径 */
const B1 = wav(1, 8000, 1, 3), B2 = wav(2, 8000, 2, 5), B3 = wav(.5, 11025, 1, 7),
  B4 = wav(1.5, 8000, 1, 9), B5 = wav(1, 16000, 1, 11);
const five = [asset('au_1', B1, ['bgm'], 1), asset('au_2', B2, ['sfx'], 2),
  asset('au_3', B3, ['sfx'], .5), asset('au_4', B4, ['voice'], 1.5), asset('au_5', B5, ['voice'], 1)];
const p = project(five);
const root = dir('audio-project');
const created = store.createProject(root, p);
const disk = JSON.parse(fs.readFileSync(path.join(root, MAIN_FILE), 'utf8'));
assert.equal(disk.audioAssets.length, 5);
assert.equal(disk.schema, 6, '演出是 schema 6 的增量；音频仍是 schema 5 引入的可选字段');
for (const a of disk.audioAssets) {
  assert.equal(a.file, AUDIO_REL + '/' + sha(Buffer.from(a.id === 'au_1' ? B1 : a.id === 'au_2' ? B2 : a.id === 'au_3' ? B3 : a.id === 'au_4' ? B4 : B5)) + '.wav');
  assert(!('data' in a), '磁盘元数据不内嵌音频数据');
  assert.equal(a.sha256, sha(fs.readFileSync(path.join(root, a.file))));
  assert(fs.existsSync(path.join(root, a.file)), 'assets/audio 下文件存在');
  assert(!/[A-Za-z]:[\\/]/.test(a.file) && !a.file.startsWith('paper://'), '无本机绝对路径或 paper:// 引用');
}
assert.equal(fs.readdirSync(path.join(root, AUDIO_REL)).length, 5, '五个内容哈希文件');
assert.equal(store.inspectReferences(p).brokenAudio.length, 0);
console.log('  ok  五个音频素材按内容哈希落到 assets/audio/，元数据只含受控相对路径');

/* 2. 回读：data URL 恢复、时长与指令都在 */
const opened = store.openProject(root);
assert.equal(opened.project.audioAssets.length, 5);
for (const a of opened.project.audioAssets) {
  /* V0.7.6：运行时恢复为受控地址，音频本体在 assets/audio 下按内容命名。 */
  assert(/^paper:\/\/app\/asset\/assets\/audio\//.test(a.data), '运行时恢复为受控地址');
  const fileBuf = fs.readFileSync(path.join(root, a.file));
  assert.equal(a.bytes, fileBuf.length);
  assert.equal(a.duration, five.find(x => x.id === a.id).duration);
  assert.equal(A.pure.wavInfo(fileBuf).duration, a.duration, 'WAV 头时长与元数据一致');
}
assert.equal(opened.project.nodes[0].audio.bgm.audioId, 'au_1');
assert.equal(opened.project.nodes[2].audio.bgm.action, 'stop');
console.log('  ok  打开工程恢复音频数据、时长与逐句指令');

/* 3. 重复内容复用：不产生第二个素材 ID / 第二个文件 */
/* M3：新导入经 asset:stage 流式算出内容哈希；已保存素材是受控 URL。
   两者表示不同但哈希相同，必须精确复用同一素材身份。 */
const reused = C.assetForAudioImport(opened.project, {
  id: 'should_not_be_used', name: 'again.wav', categories: ['voice'], data: url(B1),
  sha256: sha(B1), mime: 'audio/wav', ext: 'wav', bytes: B1.length, duration: 1
});
assert.equal(reused.reused, true, '跨表示同内容精确复用');
assert.equal(reused.asset.id, five.find(x => x.sha256 === sha(B1)).id, '复用已保存素材 ID，不产生第二条');
assert.deepEqual(reused.categories, ['bgm', 'voice'], '用途分类合并');

/* 同表示（两次都是内嵌音频）必须复用：这是 V0.7.5 就有的去重能力，不能退化。 */
const blank = C.blank();
const first = C.assetForAudioImport(blank, { id: 'x1', name: 'a.wav', categories: ['bgm'], data: url(B1), mime: 'audio/wav', ext: 'wav', bytes: B1.length, duration: 1 });
blank.audioAssets = [first.asset];
const twice = C.assetForAudioImport(blank, { id: 'x2', name: 'a.wav', categories: ['voice'], data: url(B1), mime: 'audio/wav', ext: 'wav', bytes: B1.length, duration: 1 });
assert.equal(twice.reused, true, '同一内嵌音频重复导入会复用');
assert.equal(twice.asset.id, first.asset.id, '复用时不产生新素材 ID');
assert.deepEqual(twice.categories, ['bgm', 'voice'], '用途可合并');
const dup = C.clone(opened.project);
dup.audioAssets.push(C.clone(dup.audioAssets[0]));    /* 同 ID 同内容 */
const dupRoot = dir('dedupe');
assert.doesNotThrow(() => store.createProject(dupRoot, dup, root), '重复条目折叠后保存不失败');
assert.equal(JSON.parse(fs.readFileSync(path.join(dupRoot, MAIN_FILE), 'utf8')).audioAssets.length, 5);
console.log('  ok  同内容文件复用资源、重复条目折叠，保存不失败');

/* 4. 损坏 / 越界音频拒绝，原工程不受影响 */
const before = fs.readFileSync(path.join(root, MAIN_FILE), 'utf8');
const broken = C.clone(opened.project);
broken.audioAssets[0].data = 'data:audio/wav;base64,AAAA';
assert.throws(() => store.saveProject(root, broken), /音频|WAV|损坏|格式/);
const tooBig = C.clone(opened.project);
tooBig.audioAssets[0].bytes = 17 * 1024 * 1024;
assert.throws(() => store.saveProject(root, tooBig), /格式错误|超过/);
const imageUrl = C.clone(opened.project);
imageUrl.audioAssets[0].data = 'data:image/png;base64,iVBORw0KGgo=';
assert.throws(() => store.saveProject(root, imageUrl), /音频素材/, '图片 data URL 混入音频在工程校验阶段就被拒绝');
assert.equal(fs.readFileSync(path.join(root, MAIN_FILE), 'utf8'), before, '拒绝后原工程文件未变');
console.log('  ok  损坏 / 超限 / 图片数据混入音频被明确拒绝，原工程不受影响');

/* 5. 音频素材不带图片字段也能通过（图片专用校验未误用） */
const noKind = C.clone(opened.project);
for (const a of noKind.audioAssets) { assert(!('kind' in a)); assert(!('width' in a)); }
assert.doesNotThrow(() => store.validateRuntime(noKind));
assert.throws(() => store.validateRuntime(Object.assign(C.clone(opened.project), { assets: [{ id: 'x', name: 'x', kind: 'bg', data: url(B1) }] })), /图片素材/);
console.log('  ok  音频专用校验与图片校验互不串用');

/* 6. 目录移动 + 另存为：音频随工程走，旧工程不动 */
const moved = dir('moved-project');
fs.cpSync(root, moved, { recursive: true });
const movedProject = store.openProject(moved).project;
assert.equal(movedProject.audioAssets.length, 5);
assert.equal(movedProject.nodes[1].audio.voice.audioId, 'au_5');
const saveAs = dir('save-as');
store.saveAsProject(saveAs, movedProject, moved);
assert.equal(fs.readdirSync(path.join(saveAs, AUDIO_REL)).length, 5);
assert.equal(store.openProject(saveAs).project.audioAssets.length, 5);
console.log('  ok  目录移动与另存为都携带全部音频，旧工程未被改动');

/* 7. 自动保存 / 备份恢复 / 缺失提示 */
store.autoSave(root, opened.project);
assert(store.openProject(root).project.audioAssets.length === 5, '自动保存可读回');
const backupRoot = dir('backup-restore');
fs.cpSync(root, backupRoot, { recursive: true });
const main = path.join(backupRoot, MAIN_FILE);
fs.writeFileSync(main, '{ broken json');
const recovered = store.openProject(backupRoot);
assert(['backup', 'autosave'].includes(recovered.recovered), '从备份或自动保存恢复：' + recovered.recovered);
assert.equal(recovered.project.audioAssets.length, 5, '恢复后音频仍可用');
const missingRoot = dir('missing-audio');
fs.cpSync(root, missingRoot, { recursive: true });
fs.unlinkSync(path.join(missingRoot, AUDIO_REL, sha(B1) + '.wav'));
assert.throws(() => store.openProject(missingRoot), /素材缺失/);
console.log('  ok  自动保存、损坏主文件从备份恢复、音频缺失给出中文提示');

/* 8. 旧无音频工程零回归 */
const legacy = C.blank();
legacy.title = '旧工程';
const oldNode = C.makeNode('say');
Object.assign(oldNode, { id: 'old1', text: '旧台词', paragraphId: legacy.chapters[0].paragraphs[0].id });
legacy.nodes.push(oldNode);
delete legacy.audioAssets;
const legacyRoot = dir('legacy');
store.createProject(legacyRoot, legacy);
const legacyDisk = JSON.parse(fs.readFileSync(path.join(legacyRoot, MAIN_FILE), 'utf8'));
assert.deepEqual(legacyDisk.audioAssets, [], '磁盘写入空数组，字段本身可选');
delete legacyDisk.audioAssets;
fs.writeFileSync(path.join(legacyRoot, MAIN_FILE), JSON.stringify(legacyDisk, null, 2));
const legacyOpen = store.openProject(legacyRoot).project;
assert.deepEqual(legacyOpen.audioAssets, [], '完全无 audioAssets 字段的旧工程也能打开');
assert.equal(C.hasAnyAudio(legacyOpen), false);
assert.deepEqual(C.analyze(legacyOpen).errors, []);
console.log('  ok  旧无音频工程（连字段都没有）打开、检查与画面剧情行为保持一致');

console.log('PASS: V0.5 audio storage - content addressing, reuse, migration, move, backup, legacy parity');
