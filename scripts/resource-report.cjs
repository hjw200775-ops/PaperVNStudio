'use strict';
/*
 * 资源引用清单：把「素材库全部 / 实际引用 / 未引用」按数量与字节算清楚。
 * 读磁盘工程（不加载 data URI），用于体积对比与导出前预检。
 *
 * 用法：node scripts/resource-report.cjs --project "F:/pvn-large-project"
 */
const fs = require('node:fs');
const path = require('node:path');

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PROJECT = path.resolve(arg('project', 'dist/samples/wanfeng-ch01'));

const disk = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));

/* 与 core.referencedImageIds / referencedAudioIds 同口径，但不依赖运行时 data URI。 */
const imageIds = new Set();
if (disk.titleBackground) imageIds.add(disk.titleBackground);
for (const n of disk.nodes || []) {
  for (const l of n.layers || []) if (l && l.asset) imageIds.add(l.asset);
}
for (const c of disk.characters || []) {
  for (const e of c.expressions || []) if (e && e.assetId) imageIds.add(e.assetId);
}

const audioIds = new Set();
for (const n of disk.nodes || []) {
  const a = n.audio;
  if (!a) continue;
  if (a.bgm && a.bgm.action === 'play' && a.bgm.audioId) audioIds.add(a.bgm.audioId);
  for (const s of a.sfx || []) if (s && s.audioId) audioIds.add(s.audioId);
  if (a.voice && a.voice.audioId) audioIds.add(a.voice.audioId);
}
if (disk.titleMusic && disk.titleMusic.audioId) audioIds.add(disk.titleMusic.audioId);

const sizeOf = rel => {
  try { return fs.statSync(path.join(PROJECT, rel)).size; } catch { return 0; }
};

const images = (disk.assets || []).map(a => ({ id: a.id, name: a.name, bytes: sizeOf(a.file), used: imageIds.has(a.id) }));
const audios = (disk.audioAssets || []).map(a => ({ id: a.id, name: a.name, bytes: sizeOf(a.file), used: audioIds.has(a.id) }));

const sum = list => list.reduce((s, x) => s + x.bytes, 0);
const used = list => list.filter(x => x.used);
const unused = list => list.filter(x => !x.used);

const report = {
  project: PROJECT,
  nodes: (disk.nodes || []).length,
  images: {
    library: { count: images.length, bytes: sum(images) },
    included: { count: used(images).length, bytes: sum(used(images)) },
    excluded: { count: unused(images).length, bytes: sum(unused(images)) }
  },
  audio: {
    library: { count: audios.length, bytes: sum(audios) },
    included: { count: used(audios).length, bytes: sum(used(audios)) },
    excluded: { count: unused(audios).length, bytes: sum(unused(audios)) }
  },
  excludedNames: { images: unused(images).map(a => a.name), audio: unused(audios).map(a => a.name) }
};
report.total = {
  libraryBytes: report.images.library.bytes + report.audio.library.bytes,
  includedBytes: report.images.included.bytes + report.audio.included.bytes
};
report.ratio = report.total.libraryBytes
  ? +(report.total.includedBytes / report.total.libraryBytes).toFixed(3)
  : 0;

console.log(JSON.stringify(report, null, 1));
