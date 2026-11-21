'use strict';
/* V0.6.2 标题背景与内置示例：
   数据校验、存储往返（保存 / 重开 / 另存）、导出结构、模板完整性与复制契约。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const createVNCore = require('../dist/core.js');
const createStore = require('../desktop/project-store.cjs');
const { buildPlayerHTML } = require('../dist/game-html.js');

const C = createVNCore();
const store = createStore();
const root = path.resolve(__dirname, '..');
const SAMPLE = path.join(root, 'dist', 'samples', 'wanfeng-ch01');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-titlebg-' + name + '-'));

function project() {
  const p = C.blank();
  p.title = '标题背景测试';
  p.assets = [{ id: 'bg1', name: '客厅', kind: 'bg', width: 1, height: 1, data: 'data:image/png;base64,' + PNG }];
  p.titleBackground = 'bg1';
  const pid = p.chapters[0].paragraphs[0].id;
  p.nodes = [
    Object.assign(C.makeNode('say'), { id: 'a', text: '第一句', paragraphId: pid, sceneMode: 'own',
      layers: [{ id: 'L1', asset: 'bg1', name: '客厅', kind: 'bg', x: 0, y: 0, w: 100, h: 100,
        fit: 'cover', opacity: 100, hidden: false, locked: false, motion: 'none' }] }),
    Object.assign(C.makeNode('end'), { id: 'b', text: '结束', paragraphId: pid })
  ];
  return p;
}

/* 1. 迁移：缺字段补空串，已有值原样保留，旧 schema 也能升级 */
{
  const old = project();
  delete old.titleBackground;
  assert.equal(C.migrate(C.clone(old)).titleBackground, '', '缺字段补成默认空串');
  const kept = project();
  assert.equal(C.migrate(kept).titleBackground, 'bg1', '已有配置不被迁移覆盖');

  const v4 = C.clone(project());
  v4.schema = 4;
  delete v4.titleBackground;
  assert.equal(C.migrate(v4).schema, 5);
  assert.equal(C.migrate(v4).titleBackground, '', 'schema 4 工程升级后仍是默认标题页');
  console.log('  ok  迁移：旧工程补默认值，已有标题背景保留');
}

/* 2. 校验与引用检查：类型错误拒绝，缺素材报错但不阻止打开 */
{
  const bad = project();
  bad.titleBackground = 42;
  assert.throws(() => C.validate(bad), /标题背景格式错误/);

  const missing = project();
  missing.titleBackground = 'gone';
  assert.equal(C.validate(missing), true, '缺素材不阻止校验（否则工程打不开）');
  const report = C.analyze(missing);
  assert(report.issues.some(i => i.kind === 'title'), '引用检查报告标题背景缺失');
  assert.equal(C.analyze(project()).issues.filter(i => i.kind === 'title').length, 0, '正常配置不报错');
  console.log('  ok  校验与检查：类型错误拒绝，缺素材明确报错');
}

/* 3. 存储往返：保存 → 重开 → 另存为 都保留标题背景 */
{
  const dir = tmp('store');
  const created = store.createProject(dir, project());
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'project.paper.json'), 'utf8'));
  assert.equal(disk.titleBackground, 'bg1', '磁盘元数据包含标题背景');

  const reopened = store.openProject(dir);
  assert.equal(reopened.recovered, null);
  assert.equal(reopened.project.titleBackground, 'bg1', '重开后保留');

  const again = tmp('saveas');
  store.saveAsProject(again, reopened.project);
  const third = store.openProject(again);
  assert.equal(third.project.titleBackground, 'bg1', '另存为后保留');

  const broken = Object.assign({}, disk, { titleBackground: 7 });
  assert.throws(() => store.validateDisk(broken), /标题背景/);
  assert.equal(store.validateDisk(Object.assign({}, disk, { titleBackground: undefined })).schema, 5,
    '旧工程没有该字段仍可打开');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(again, { recursive: true, force: true });
  console.log('  ok  存储：保存、重开、另存为都保留标题背景；旧工程缺字段可读');
}

/* 4. 导出：标题背景随 HTML 内嵌，不出现本机路径 */
{
  const html = buildPlayerHTML(project());
  assert(html.includes('id="titleBg"'), '导出骨架包含标题背景容器');
  assert(html.includes('id="titleBgImg"'), '标题图由程序渲染');
  assert(html.includes('data:image/png;base64,' + PNG), '素材内嵌');
  assert(!html.includes('paper://') && !/[A-Za-z]:\\/.test(html.split('<script>')[0]), '无本机路径或协议');
  console.log('  ok  导出：标题背景内嵌、无本机依赖');
}

/* 5. 内置示例完整性（不是只看目录名） */
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
{
  const main = path.join(SAMPLE, 'project.paper.json');
  assert(fs.existsSync(main), '内置示例存在');
  const disk = JSON.parse(fs.readFileSync(main, 'utf8'));
  store.validateDisk(disk);
  const p = store.diskToRuntime(SAMPLE, disk);

  assert.equal(disk.id, 'sample-wanfeng-ch01', '示例使用稳定身份');
  assert.equal(p.nodes.length, 45, '原作节选 45 个节点');
  assert.equal(p.nodes[0].id, 'home_01', '首节点 home_01');
  assert.equal(p.nodes[p.nodes.length - 1].id, 'demo_end', '结尾 demo_end');
  assert.equal(p.nodes[p.nodes.length - 1].type, 'end');

  const names = (p.characters || []).map(c => c.name).sort().join(',');
  assert.equal(names, '林悠,林澈', '两个角色齐全：' + names);
  for (const c of p.characters) assert.equal(c.expressions.length, 2, c.name + ' 有两个表情');

  const kinds = p.assets.reduce((m, a) => (m[a.kind] = (m[a.kind] || 0) + 1, m), {});
  assert.equal(kinds.bg, 4, '3 张正文背景 + 1 张标题背景');
  assert.equal(kinds.char, 4, '4 张人物素材');
  assert.equal(p.titleBackground, 'asset_title_home_corridor', '示例标题背景是家中走廊');

  /* 正文学校背景仍然存在，标题图没有替换它 */
  const home = p.nodes.find(n => n.id === 'home_01');
  assert.equal(home.layers[0].asset, 'bg_home', '早餐场景不变');
  const school = p.nodes.find(n => n.id === 'school_01');
  assert(school.layers.some(l => l.asset === 'bg_school'), '校园走廊仍是正文场景');

  const road = p.nodes.find(n => n.id === 'road_17');
  const roadScene = C.scene(p, 'road_17');
  assert(roadScene.some(l => l.id === 'linyou' && ['you_neutral', 'you_annoyed'].includes(l.asset)),
    'road_17 画面仍有林悠图层');
  assert(road.effects.some(e => e.type === 'scale' && e.layer === 'linyou' && e.to === 120), 'road_17 保留人物特写');
  assert(road.effects.some(e => e.type === 'blur' && e.layer === 'background'), 'road_17 保留背景虚化');

  assert.equal((p.chapters || []).length, 1, '保留一个章节');
  assert.equal(p.chapters[0].paragraphs.length, 3, '保留三个段落');
  /* V0.7.3：示例带六首正式 OST，但不得混入早期测试用的占位语音。 */
  assert.equal((p.audioAssets || []).length, 6, '示例素材库为六首正式 BGM');
  assert(p.audioAssets.every(a => a.meta && /^ost_0[1-6]_/.test(a.meta.trackId)),
    '只含 OST 曲目，没有混入英文占位语音或测试音频');
  assert(!fs.existsSync(path.join(SAMPLE, 'backups')), '不捆绑 backups');
  const audioDir = path.join(SAMPLE, 'assets', 'audio');
  assert(fs.existsSync(audioDir), '正式 BGM 随示例分发');
  assert.equal(fs.readdirSync(audioDir).filter(f => /\.ogg$/.test(f)).length, 6, '六首 OGG 齐全');

  for (const a of disk.assets) {
    const file = path.join(SAMPLE, a.file);
    assert(fs.existsSync(file), '素材文件存在：' + a.file);
    assert.equal(sha(fs.readFileSync(file)), a.sha256, '素材哈希与元数据一致：' + a.file);
  }
  const notice = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'NOTICE.json'), 'utf8'));
  for (const key of ['author', 'scope', 'art', 'usage', 'licensing']) assert(notice[key], '素材说明包含 ' + key);
  assert.equal(notice.author, '黄嘉文');
  console.log('  ok  内置示例：45 节点、角色表情、7 张原作素材 + 家中走廊标题图、road_17 演出完整');
}

/* 6. 复制契约：新 ID、内部引用有效、独立存档身份 */
{
  const target = tmp('copy');
  const { project: template } = (() => {
    const disk = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'project.paper.json'), 'utf8'));
    return { project: store.diskToRuntime(SAMPLE, disk) };
  })();
  const copy = JSON.parse(JSON.stringify(template));
  copy.id = C.id();
  store.createProject(target, copy);
  const reopened = store.openProject(target);
  assert.notEqual(reopened.project.id, template.id, '副本使用新的工程 ID');
  assert.equal(reopened.project.id, copy.id);
  assert.equal(reopened.project.nodes.length, template.nodes.length, '节点全部保留');
  assert.equal(reopened.project.titleBackground, 'asset_title_home_corridor', '副本保留标题背景');
  const ids = new Set(reopened.project.assets.map(a => a.id));
  const used = reopened.project.nodes.flatMap(n => n.layers.map(l => l.asset));
  assert(used.every(id => ids.has(id)), '图层引用仍然有效');
  assert.equal('paper-game-' + reopened.project.id === 'paper-game-' + template.id, false, '存档键不同');
  assert.deepEqual(C.analyze(reopened.project).errors, [], '副本没有结构性错误');
  fs.rmSync(target, { recursive: true, force: true });
  console.log('  ok  复制：新工程 ID、引用有效、与示例存档互不串用');
}

console.log('PASS: V0.6.2 title background + bundled sample');
