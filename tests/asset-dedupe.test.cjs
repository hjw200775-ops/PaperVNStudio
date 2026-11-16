'use strict';
/* 素材去重四问（真实代码路径：core 的导入/图层函数 + project-store 落盘）：
 *   1. 同图、同用途重复导入：复用素材，新增独立图层。
 *   2. 同图分别作为背景和角色：两种用途都保留，不因按图片数据查重而误用 kind。
 *   3. 同名不同图：互不覆盖。
 *   4. 同 ID 不同内容：明确报错，且不损坏已有工程。
 * 另外确认两个复用同一素材的图层，位置/大小/效果互不影响，并且能原样存盘再打开。
 * 所有目录都建在 os.tmpdir() 下，不写源码树。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();
const F = require('../dist/effects.js')();

const store = createStore();
const { MAIN_FILE } = store.constants;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-dedupe-'));
let seq = 0;
const dir = name => path.join(tmp, name + '-' + (++seq));

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

const IMG_WIDE = png(16, 9, 0x112233);           // 背景用的横图
const IMG_TALL = png(3, 8, 0x445566);            // 角色用的竖图
const IMG_OTHER = png(4, 4, 0x778899);           // 与 IMG_WIDE 同名但内容不同

function scene() {
  const p = C.blank();
  const node = C.makeNode();
  node.sceneMode = 'own';
  node.name = '旁白';
  node.text = '测试台词';
  p.nodes = [node];
  return { p, node };
}
/* 模拟 app.js 的导入链路：查重 → 需要时入表 → 追加图层。 */
function importImage(p, node, { id, name, kind, data }) {
  const picked = C.assetForImport(p, { id, name, kind, data });
  if (picked.reused) {
    assert(p.assets.includes(picked.asset), '复用的素材必须已经在素材表里');
  } else {
    assert(!p.assets.some(a => a.id === picked.asset.id), '新素材 id 不能撞上已有素材');
    p.assets.push(picked.asset);
  }
  const layer = C.appendAssetLayer(node, picked.asset);
  return { asset: picked.asset, layer, reused: picked.reused };
}

/* ---------- 1. 同图同用途重复导入 ---------- */
{
  const { p, node } = scene();
  const first = importImage(p, node, { id: 'a_bg_1', name: '走廊.png', kind: 'bg', data: url(IMG_WIDE) });
  const second = importImage(p, node, { id: 'a_bg_2', name: '走廊.png', kind: 'bg', data: url(IMG_WIDE) });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true, '同图同用途应复用已有素材');
  assert.equal(second.asset.id, 'a_bg_1', '复用后仍指向第一次导入的素材');
  assert.equal(p.assets.length, 1, '素材表只保留一份');
  assert.equal(node.layers.length, 2, '两次导入应得到两个独立图层');
  assert.notEqual(first.layer.id, second.layer.id, '图层 id 必须互不相同');
  assert.equal(first.layer.asset, second.layer.asset, '两个图层引用同一素材');
  assert.equal(node.layers[0].id, first.layer.id, '两个背景层按导入顺序叠放');
  assert(C.validate(p));
  console.log('  ok  同图同类型重复导入：复用素材 + 新增独立图层');
}

/* ---------- 2. 同图分别作为背景和角色 ---------- */
{
  const { p, node } = scene();
  const asChar = importImage(p, node, { id: 'a_char', name: '场景.png', kind: 'char', data: url(IMG_WIDE) });
  const asBg = importImage(p, node, { id: 'a_bg', name: '场景.png', kind: 'bg', data: url(IMG_WIDE) });
  assert.equal(asBg.reused, false, '同一张图换个用途不能复用（否则 kind 会用错）');
  assert.equal(p.assets.length, 2);
  assert.deepEqual(p.assets.map(a => a.kind).sort(), ['bg', 'char']);
  assert.notEqual(asBg.asset.id, asChar.asset.id, '不同用途的素材 id 必须不同');
  assert.equal(asChar.layer.kind, 'char');
  assert.equal(asBg.layer.kind, 'bg');
  assert.equal(asChar.layer.asset, 'a_char');
  assert.equal(asBg.layer.asset, 'a_bg');
  assert.equal(node.layers[0].id, asBg.layer.id, '背景层排在角色层之前');
  /* 两种用途的默认几何本来就不同，kind 被复用错时会立刻变形 */
  assert.equal(asBg.layer.w, 100, '背景铺满宽度');
  assert(asChar.layer.w < 100 && asChar.layer.y > 0, '角色按比例收窄并站在底部');
  assert.notEqual(asChar.layer.y, asBg.layer.y);
  assert(C.validate(p));
  console.log('  ok  同图不同用途：背景/角色各自成为独立素材，kind 不被误用');
}

/* ---------- 3. 同名不同图 + 4. 同 ID 不同内容 ---------- */
{
  const { p, node } = scene();
  p.title = '素材去重 · 落盘';
  const a = importImage(p, node, { id: 'a_same_name_1', name: '立绘.png', kind: 'char', data: url(IMG_TALL) });
  const b = importImage(p, node, { id: 'a_same_name_2', name: '立绘.png', kind: 'char', data: url(IMG_OTHER) });
  assert.equal(p.assets.length, 2, '同名不同图必须各自入表');
  assert.notEqual(a.asset.id, b.asset.id);

  /* 两个图层复用素材 a，但位置/大小/效果彼此独立 */
  const shared = importImage(p, node, { id: 'a_same_name_1', name: '立绘.png', kind: 'char', data: url(IMG_TALL) });
  assert.equal(shared.reused, true);
  const [l1, l2, l3] = node.layers;
  Object.assign(l1, { x: 4, y: 12, w: 30, h: 60, opacity: 90, fit: 'contain' });
  Object.assign(l2, { x: 62, y: 20, w: 24, h: 48, opacity: 70, fit: 'cover' });
  assert.equal(l3.x, (100 - l3.w) / 2, '第三个图层保持默认水平居中');
  assert.notEqual(l1.x, l3.x);
  assert.notEqual(l1.w, l3.w);
  node.effects = [F.make('fx-1', l1.id, 'scale')];
  assert.equal(l3.asset, l1.asset, 'l1 与 l3 确实共用同一素材');
  assert(C.validate(p));
  assert.deepEqual(F.validate(node.effects), undefined);
  assert(!node.effects.some(e => e.layer === l3.id), '效果只挂在 l1 上');

  const root = dir('同名 与 共享');
  store.createProject(root, p);

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, MAIN_FILE), 'utf8'));
  assert.equal(onDisk.assets.length, 2, '同名不同图各一份，共享素材不重复入表');
  const files = fs.readdirSync(path.join(root, 'assets/images')).filter(x => !x.includes('.tmp-'));
  assert.equal(files.length, 2, '同名不同图落成两个不同的内容寻址文件');
  const sharedEntry = onDisk.assets.find(a2 => a2.id === 'a_same_name_1');
  const otherEntry = onDisk.assets.find(a2 => a2.id === 'a_same_name_2');
  assert.notEqual(sharedEntry.file, otherEntry.file, '同名不同图不能互相覆盖');
  assert.notEqual(sharedEntry.sha256, otherEntry.sha256);
  console.log('  ok  同名不同图：两个独立文件，互不覆盖');

  /* 复用同一素材的两个图层，存盘再打开后仍各自独立 */
  const reopened = store.openProject(root).project;
  const reread = reopened.nodes[0].layers;
  assert.deepEqual(reread, node.layers, '图层几何/层级逐字段回读一致');
  assert.equal(reread[0].x, 4);
  assert.equal(reread[2].x, (100 - reread[2].w) / 2);
  assert.equal(reopened.nodes[0].effects.length, 1);
  assert.equal(reopened.nodes[0].effects[0].layer, l1.id);
  console.log('  ok  共用素材的两个图层：位置/大小/效果独立且可原样存盘回读');

  /* 同 ID 不同内容：明确报错，且不动已有工程 */
  const before = fs.readFileSync(path.join(root, MAIN_FILE));
  const imagesBefore = fs.readdirSync(path.join(root, 'assets/images')).sort();
  const backupsBefore = fs.existsSync(path.join(root, 'backups'))
    ? fs.readdirSync(path.join(root, 'backups')).sort()
    : [];
  const conflict = JSON.parse(JSON.stringify(p));
  conflict.assets.push({ id: 'a_same_name_1', name: '伪造.png', kind: 'char', data: url(IMG_WIDE) });
  assert.throws(() => store.saveProject(root, conflict), /素材 ID 重复且内容不同/,
    '同 ID 不同内容必须明确报错，不能静默覆盖');
  assert(fs.readFileSync(path.join(root, MAIN_FILE)).equals(before), '报错后主工程文件字节不变');
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets/images')).sort(), imagesBefore, '报错后素材目录不变');
  assert.deepEqual(
    fs.existsSync(path.join(root, 'backups')) ? fs.readdirSync(path.join(root, 'backups')).sort() : [],
    backupsBefore, '报错后不产生新备份，旧备份也没被清掉');
  const after = store.openProject(root);
  assert.equal(after.recovered, null, '失败保存不应让工程进入备份恢复态');
  assert.equal(after.project.assets.length, 2, '工程仍能正常打开，素材数量不变');
  console.log('  ok  同 ID 不同内容：明确报错且不损坏已有工程');

  /* 同 ID 同内容（重复条目）落盘时折叠成一份，而不是报错 */
  const duplicated = JSON.parse(JSON.stringify(p));
  duplicated.assets.push({ ...duplicated.assets[0] });
  const saved = store.saveProject(root, duplicated);
  assert.equal(saved.project.assets.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, MAIN_FILE), 'utf8')).assets.length, 2);
  console.log('  ok  同 ID 同内容：落盘时折叠为一条，不误报冲突');

  /* 同 ID、同图、不同用途：不能静默合并，否则会丢掉图层的用途 */
  const kindClash = JSON.parse(JSON.stringify(p));
  kindClash.assets.push({ ...kindClash.assets[0], kind: kindClash.assets[0].kind === 'bg' ? 'char' : 'bg' });
  const beforeKind = fs.readFileSync(path.join(root, MAIN_FILE));
  assert.throws(() => store.saveProject(root, kindClash), /素材 ID 重复且用途不同/,
    '同 ID 不同用途必须报错，不能把两种用途合并成一条');
  assert(fs.readFileSync(path.join(root, MAIN_FILE)).equals(beforeKind), '报错后主工程文件字节不变');
  assert.equal(store.openProject(root).project.assets.length, 2, '工程仍可正常打开');
  console.log('  ok  同 ID 不同用途：明确报错，不静默丢失 kind');
}

console.log('\nAsset de-duplication checks passed.');
