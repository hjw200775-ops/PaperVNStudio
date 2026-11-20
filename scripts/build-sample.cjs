'use strict';
/*
 * 生成内置只读示例工程（V0.6.2）。
 *
 *   PAPER_SAMPLE_SOURCE=<原作工程目录> \
 *   PAPER_SAMPLE_TITLE_IMAGE=<家中走廊标题图.png> \
 *   node scripts/build-sample.cjs
 *
 * 只读源工程：先记录 project.paper.json 与全部素材的哈希，生成后再次比对。
 * 输出 dist/samples/wanfeng-ch01/，只包含 project.paper.json、assets/images/ 与 NOTICE.json，
 * 不带 backups、测试报告、截图或英文占位语音。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const createStore = require('../desktop/project-store.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01');
const SAMPLE_ID = 'sample-wanfeng-ch01';
const TITLE_ASSET_ID = 'asset_title_home_corridor';
const TITLE_ASSET_NAME = '标题·家中二楼走廊';

const source = process.env.PAPER_SAMPLE_SOURCE;
const titleImage = process.env.PAPER_SAMPLE_TITLE_IMAGE;
if (!source || !titleImage) {
  console.error('用法：PAPER_SAMPLE_SOURCE=<原作工程目录> PAPER_SAMPLE_TITLE_IMAGE=<标题图.png> node scripts/build-sample.cjs');
  process.exit(2);
}

const store = createStore();
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

function snapshot(dir) {
  const map = {};
  const walk = rel => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = path.join(rel, name);
      const abs = path.join(dir, r);
      if (fs.statSync(abs).isDirectory()) walk(r);
      else map[r] = sha(fs.readFileSync(abs));
    }
  };
  walk('');
  return map;
}

function main() {
  const sourceRoot = path.resolve(source);
  const mainFile = path.join(sourceRoot, 'project.paper.json');
  if (!fs.existsSync(mainFile)) throw new Error('源目录没有 project.paper.json：' + sourceRoot);
  const before = snapshot(sourceRoot);

  /* 直接用主工程文件（不用 autosave），保证示例等于作者手动保存的原作状态。 */
  const disk = JSON.parse(fs.readFileSync(mainFile, 'utf8'));
  store.validateDisk(disk);
  const p = store.diskToRuntime(sourceRoot, disk);

  if (p.nodes.length !== 45) throw new Error('原作节选应为 45 个节点，实际 ' + p.nodes.length);
  if (p.nodes[0].id !== 'home_01' || p.nodes[p.nodes.length - 1].id !== 'demo_end') {
    throw new Error('首尾节点不是 home_01 → demo_end，拒绝生成示例');
  }
  if ((p.characters || []).length !== 2) throw new Error('原作应有两个角色');
  if ((p.audioAssets || []).length) throw new Error('原作不应带测试音频；请确认没有混入英文占位语音');

  const buf = fs.readFileSync(path.resolve(titleImage));
  if (!buf.length || buf.length > store.MAX_IMAGE_BYTES) throw new Error('标题图为空或超过 12MB');
  const size = store.imageSize(buf, 'image/png');
  if (!size) throw new Error('标题图不是可识别的 PNG');
  p.titleBackground = TITLE_ASSET_ID;
  if (!p.assets.some(a => a.id === TITLE_ASSET_ID)) {
    p.assets.push({ id: TITLE_ASSET_ID, name: TITLE_ASSET_NAME, kind: 'bg',
      width: size.width, height: size.height,
      data: 'data:image/png;base64,' + buf.toString('base64') });
  }

  /* 示例拥有稳定身份：两次体验读同一份存档，但不与作者原工程共用存档键。 */
  p.id = SAMPLE_ID;
  /* 发行标识沿用 V0.7.1 已发布的 wanfeng-ch01：通用导出重新打包后，老玩家的存档目录不变。 */
  p.publish = Object.assign({}, p.publish, { releaseId: 'wanfeng-ch01' });

  if (fs.existsSync(OUT)) {
    if (!path.resolve(OUT).startsWith(path.join(ROOT, 'dist', 'samples') + path.sep)) {
      throw new Error('拒绝清理示例目录之外的路径');
    }
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  const created = store.createProject(OUT, p);
  /* 只捆绑必要文件：首次保存会留下 backups/latest 副本，示例不需要它。 */
  fs.rmSync(path.join(OUT, 'backups'), { recursive: true, force: true });

  fs.writeFileSync(path.join(OUT, 'NOTICE.json'), JSON.stringify({
    id: SAMPLE_ID,
    label: '《晚风经过二楼走廊》第一章原作节选',
    author: '黄嘉文',
    scope: '本示例为第一章原作节选，不是完整小说。',
    art: '图片为 AI 辅助生成；具体门窗布局属于本次美术方案，不作为小说已确认的建筑设定。',
    usage: '示例用于纸间体验与创作学习。',
    licensing: '软件代码许可与小说、美术素材许可分开；素材许可未确定前不视为 MIT / CC0，也不表示允许任意再分发。',
    sampleVersion: '0.6.2',
    titleBackground: TITLE_ASSET_ID
  }, null, 2) + '\n');

  const after = snapshot(sourceRoot);
  for (const key of Object.keys(before)) {
    if (after[key] !== before[key]) throw new Error('生成过程改动了源工程文件：' + key);
  }
  const sizes = fs.readdirSync(path.join(OUT, 'assets/images')).reduce((s, f) => s + fs.statSync(path.join(OUT, 'assets', 'images', f)).size, 0);
  console.log('SAMPLE OK ' + OUT);
  console.log('  nodes=' + p.nodes.length + ' characters=' + (p.characters || []).length +
    ' imageAssets=' + p.assets.length + ' titleBackground=' + p.titleBackground);
  console.log('  imageBytes=' + sizes + ' savedAs=' + path.basename(created.root));
  console.log('  sourceUnchanged=true');
}

main();
