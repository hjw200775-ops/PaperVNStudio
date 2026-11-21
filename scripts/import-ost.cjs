'use strict';
/*
 * 把 OST 素材包导入纸间工程（V0.7.3）。
 *
 * - 只写工程里的音乐素材库，不改剧情文本、表情与演出。
 * - 磁盘仍是内容寻址：assets/audio/<sha256>.ogg；素材 id 保持稳定，
 *   重新导入同一曲目（完整版）时只换音源，剧情绑定关系不动。
 * - 绑定只写在段落入口节点，后续句子沿用，不逐句重启播放。
 *
 * 用法：
 *   node scripts/import-ost.cjs --package "F:/Wanfeng-Demo/素材交付/Wanfeng_OST_Vol1_Release" \
 *     --project dist/samples/wanfeng-ch01/project.paper.json \
 *     --title-music ost_01_title \
 *     --bind "早餐=ost_02_morning" --bind "上学路=ost_03_school_road"
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = k => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : '';
};
const argsAll = k => argv.reduce((out, a, i) => (a === '--' + k && argv[i + 1] ? out.concat(argv[i + 1]) : out), []);

const pkgDir = path.resolve(arg('package') || 'F:/Wanfeng-Demo/素材交付/Wanfeng_OST_Vol1_Release');
const projectFile = path.resolve(arg('project') || path.join(ROOT, 'dist/samples/wanfeng-ch01/project.paper.json'));
const titleTrack = arg('title-music');
const bindSpecs = argsAll('bind').map(s => {
  const i = s.indexOf('=');
  return i > 0 ? { paragraph: s.slice(0, i), trackId: s.slice(i + 1) } : null;
}).filter(Boolean);

const manifestFile = path.join(pkgDir, 'manifest.json');
if (!fs.existsSync(manifestFile)) throw new Error('找不到 manifest.json：' + manifestFile);
if (!fs.existsSync(projectFile)) throw new Error('找不到工程文件：' + projectFile);

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const projectDir = path.dirname(projectFile);
const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
const audioDir = path.join(projectDir, 'assets', 'audio');
fs.mkdirSync(audioDir, { recursive: true });

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
project.audioAssets = Array.isArray(project.audioAssets) ? project.audioAssets : [];

const report = { imported: [], updated: [], skipped: [], bound: [], warnings: [] };

for (const t of manifest.tracks || []) {
  const rel = t.files && t.files.bgm_loop_ogg;
  if (!rel) { report.warnings.push(t.id + '：manifest 里没有 bgm_loop_ogg'); continue; }
  const src = path.join(pkgDir, rel);
  if (!fs.existsSync(src)) { report.warnings.push(t.id + '：缺少 ' + rel); continue; }

  const buf = fs.readFileSync(src);
  const hash = sha256(buf);
  const ext = 'ogg';
  const fileRel = 'assets/audio/' + hash + '.' + ext;
  const target = path.join(projectDir, fileRel);

  /* 同一内容不重复写盘；不同内容按新哈希落盘，旧文件交给工程的清理逻辑。 */
  if (!fs.existsSync(target)) fs.writeFileSync(target, buf);

  const meta = {
    category: t.category || '',
    moodTags: Array.isArray(t.mood_tags) ? t.mood_tags : [],
    scene: t.scene || '',
    trackId: t.id
  };
  const fields = {
    name: t.name_zh || t.id,
    categories: ['bgm'],
    mime: 'audio/ogg',
    ext,
    duration: typeof t.audio?.duration_sec === 'number' ? t.audio.duration_sec : null,
    file: fileRel,
    sha256: hash,
    bytes: buf.length,
    meta
  };

  const existing = project.audioAssets.find(a => a && a.meta && a.meta.trackId === t.id);
  if (existing) {
    const changed = existing.sha256 !== hash || existing.bytes !== buf.length;
    /* id 保持不变：剧情与标题音乐引用的是它，换完整版不该断绑定。 */
    Object.assign(existing, fields);
    (changed ? report.updated : report.skipped).push({ id: existing.id, trackId: t.id, name: fields.name, bytes: buf.length, changed });
  } else {
    const item = Object.assign({ id: 'audio_' + t.id }, fields);
    project.audioAssets.push(item);
    report.imported.push({ id: item.id, trackId: t.id, name: fields.name, bytes: buf.length });
  }
}

/* 标题音乐：默认循环、音量 80；只写配置，不改已有绑定。 */
if (titleTrack) {
  const a = project.audioAssets.find(x => x && x.meta && x.meta.trackId === titleTrack);
  if (!a) report.warnings.push('标题音乐曲目不存在：' + titleTrack);
  else project.titleMusic = { audioId: a.id, volume: 80, fadeIn: 1.2, loop: true };
}

/* 场景入口绑定：每个段落只改第一句，且只在该句还没有 BGM 指令时写入，
   避免覆盖作者手工调过的音乐，也避免逐句重复设置。 */
for (const spec of bindSpecs) {
  const chapter = (project.chapters || []).find(c => (c.paragraphs || []).some(g => g.title === spec.paragraph));
  if (!chapter) { report.warnings.push('找不到段落：' + spec.paragraph); continue; }
  const paragraph = chapter.paragraphs.find(g => g.title === spec.paragraph);
  const nodes = project.nodes.filter(n => n.paragraphId === paragraph.id);
  if (!nodes.length) { report.warnings.push('段落没有句子：' + spec.paragraph); continue; }
  const entry = nodes[0];
  const a = project.audioAssets.find(x => x && x.meta && x.meta.trackId === spec.trackId);
  if (!a) { report.warnings.push('曲目不存在：' + spec.trackId); continue; }
  if (entry.audio && entry.audio.bgm) {
    report.warnings.push(spec.paragraph + ' 的入口已有音乐指令，未覆盖');
    continue;
  }
  entry.audio = Object.assign({ sfx: [], voice: null }, entry.audio || {}, {
    bgm: { action: 'play', audioId: a.id, volume: 0.8, loop: true, fadeIn: 0.8, fadeOut: 0.8 }
  });
  if (!Array.isArray(entry.audio.sfx)) entry.audio.sfx = [];
  report.bound.push({ paragraph: spec.paragraph, node: entry.id, trackId: spec.trackId, audioId: a.id, inherit: nodes.length - 1 });
}

fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  project: path.relative(ROOT, projectFile),
  library: project.audioAssets.length,
  titleMusic: project.titleMusic || null,
  ...report
}, null, 1));
