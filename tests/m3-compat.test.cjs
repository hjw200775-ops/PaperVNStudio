'use strict';
/*
 * V0.7.6-M3 兼容性回归（纯 Node 层，配合真实窗口验收脚本共同判定）：
 *   - V0.7.5 及更早的 data URI 旧工程：导入、打开、保存、重开、另存为。
 *   - V0.7.6-M2 的受控 URL 工程：打开、自动保存、恢复、另存为。
 *   - 新建工程、单文件 HTML 200MB 上限引导、目录版导出类型白名单。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const createStore = require('../desktop/project-store.cjs');
const C = require('../dist/core.js')();
const { buildPlayerHTML } = require('../dist/game-html.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-m3-compat-'));
let seq = 0;
const dir = n => path.join(tmp, n + '-' + (++seq));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function crc32(buf) {
  const t = [];
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds) {
  const rate = 8000, frames = seconds * rate, data = Buffer.alloc(frames * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const IMG = png(16, 9), AUD = wav(.25);
const IMG_URL = 'data:image/png;base64,' + IMG.toString('base64');
const AUD_URL = 'data:audio/wav;base64,' + AUD.toString('base64');
const store = createStore();
const { MAIN_FILE, AUTOSAVE_REL } = store.constants;

function oldProject() {
  const p = C.blank(); p.title = 'V0.7.5 旧工程';
  p.assets = [{ id: 'old_img', name: 'bg.png', kind: 'bg', data: IMG_URL, width: 16, height: 9 }];
  p.audioAssets = [{ id: 'old_aud', name: 'voice', categories: ['voice'], data: AUD_URL,
    mime: 'audio/wav', ext: 'wav', bytes: AUD.length, duration: .25 }];
  const n = C.makeNode('say'); n.paragraphId = p.chapters[0].paragraphs[0].id;
  n.text = '旧工程台词'; n.sceneMode = 'own';
  C.appendAssetLayer(n, p.assets[0]);
  n.audio = { voice: { audioId: 'old_aud', volume: 1 } };
  p.nodes.push(n);
  return p;
}

(async () => {
  /* 1. V0.7.5 及更早：单文件 data URI 工程导入到新目录，原文件只读。 */
  const legacyFile = path.join(tmp, 'legacy.paper.json');
  const legacy = oldProject();
  fs.writeFileSync(legacyFile, JSON.stringify(legacy), 'utf8');
  const legacyBefore = fs.readFileSync(legacyFile);
  const importedRoot = dir('legacy-import');
  const imported = store.importLegacy(legacyFile, importedRoot);
  assert(imported.imported);
  assert(fs.readFileSync(legacyFile).equals(legacyBefore), '旧工程源文件未被修改');
  const disk = JSON.parse(fs.readFileSync(path.join(importedRoot, MAIN_FILE), 'utf8'));
  assert.equal(disk.assets[0].sha256, sha(IMG));
  assert.equal(disk.audioAssets[0].sha256, sha(AUD));
  assert(fs.existsSync(path.join(importedRoot, disk.assets[0].file)));
  assert(fs.existsSync(path.join(importedRoot, disk.audioAssets[0].file)));
  const openedLegacy = store.openProject(importedRoot).project;
  assert(/^paper:\/\/app\/asset\//.test(openedLegacy.assets[0].data), '旧工程打开后 URL 化');
  assert.equal(openedLegacy.nodes[0].text, '旧工程台词', '剧本未丢失');
  assert.equal(openedLegacy.audioAssets[0].sha256, sha(AUD), '音频哈希保留');
  const savedLegacy = store.saveProject(importedRoot, openedLegacy);
  assert(savedLegacy.project.title === 'V0.7.5 旧工程');
  const asLegacy = dir('legacy-save-as');
  store.saveAsProject(asLegacy, openedLegacy, importedRoot);
  const asOpened = store.openProject(asLegacy).project;
  assert.equal(asOpened.audioAssets.length, 1, '另存为保留音频');
  assert(fs.existsSync(path.join(asLegacy, asOpened.assets[0].file)), '另存为复制素材');
  console.log('  ok  V0.7.5 及更早旧工程：导入 / 打开 / 保存 / 重开 / 另存为');

  /* 2. V0.7.6-M2 受控 URL 工程：打开、自动保存、恢复、内容哈希去重。 */
  const m2 = dir('m2-project');
  const created = store.createProject(m2, legacy);
  const rt = created.project;
  assert(/^paper:\/\/app\/asset\//.test(rt.assets[0].data));
  rt.title = 'M2 草稿标题';
  store.autoSave(m2, rt);
  const draft = path.join(m2, AUTOSAVE_REL, MAIN_FILE);
  assert(fs.existsSync(draft));
  assert(!fs.readFileSync(path.join(m2, MAIN_FILE), 'utf8').includes('M2 草稿标题'),
    '自动保存不覆盖主工程');
  store.promoteAutosave(m2);
  const recovered = store.openProject(m2).project;
  assert.equal(recovered.title, 'M2 草稿标题', '自动保存可恢复');
  const dedupe = C.assetForImport(recovered, { id: 'new', name: 'bg-again.png', kind: 'bg',
    data: 'paper://app/staging/' + sha(IMG) + '.png', sha256: sha(IMG) });
  assert.equal(dedupe.reused, true, 'M2 工程与 M3 新导入跨表示复用');
  console.log('  ok  V0.7.6-M2 工程：打开 / 自动保存 / 恢复 / 跨表示去重');

  /* 3. 新建工程：空白工程可创建、可打开、可保存。 */
  const fresh = dir('fresh');
  const blank = C.blank(); blank.nodes.push(C.makeNode('say'));
  blank.nodes[0].paragraphId = blank.chapters[0].paragraphs[0].id;
  store.createProject(fresh, blank);
  assert.equal(store.openProject(fresh).project.nodes.length, 1);
  store.saveProject(fresh, store.openProject(fresh).project);
  console.log('  ok  新建工程：创建 / 打开 / 保存');

  /* 4. 单文件 HTML 200MB 限制：源码里的守卫必须无条件执行。 */
  const app = fs.readFileSync(path.join(__dirname, '..', 'dist', 'app.js'), 'utf8');
  const guard = /const SINGLE_HTML_ASSET_LIMIT\s*=\s*200\s*\*\s*1024\s*\*\s*1024/.exec(app);
  assert(guard, '200MB 常量存在');
  const fn = app.slice(app.indexOf('async function exportHTML'), app.indexOf("$('#export').onclick"));
  assert(/const total=projectAssetBytes\(src\)/.test(fn), '体积统计存在');
  assert(fn.indexOf('const total=projectAssetBytes') < fn.indexOf('const urls='),
    '体积检查必须在 URL 分支之前，旧 data URI 工程也不能绕过');
  assert(/超出单文件 HTML 的稳妥范围/.test(fn), '超限提示引导到独立游戏目录 / ZIP');
  /* 小工程仍可正常导出单文件 HTML。用全新副本：createProject 会原地归一运行时工程。 */
  const html = buildPlayerHTML(oldProject());
  assert(typeof html === 'string' && /^<!doctype html>/i.test(html) && html.length > 10000,
    '小工程单文件 HTML 仍可导出');
  console.log('  ok  单文件 HTML：200MB 上限无条件生效，超限引导目录版；小工程正常');

  /* 5. 目录版导出类型白名单：主进程不能再把 folder 静默降级为 zip。 */
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  assert(/\['folder',\s*'portable',\s*'zip'\]\.includes/.test(main), '导出类型白名单包含 folder');
  assert(/type === 'zip' \? '-独立试玩包\.zip'/.test(main), '产物后缀与 builder 一致');
  const index = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.html'), 'utf8');
  assert(/<option value="folder"/.test(index), '界面提供目录版选项');
  console.log('  ok  目录版导出链路：界面 → 主进程 → builder 类型一致');

  /* 6. 所有旧工程的素材在磁盘上仍可解码（CRC / WAV 头）。 */
  const file = path.join(importedRoot, disk.assets[0].file);
  assert(fs.readFileSync(file).equals(IMG), '素材内容逐字节一致');
  const audioFile = fs.readFileSync(path.join(importedRoot, disk.audioAssets[0].file));
  assert.equal(audioFile.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audioFile.toString('ascii', 8, 12), 'WAVE');
  console.log('  ok  兼容后素材未损坏');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS: V0.7.6-M3 compatibility regression');
})().catch(e => { console.error(e); process.exit(1); });
