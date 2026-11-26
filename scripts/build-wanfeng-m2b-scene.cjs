'use strict';
/*
 * V0.8.2 · M2-B · 构建《晚风》音视频演出测试工程
 * 基于《晚风》隔离副本，在第一个节点写入一段约 14s 的综合演出（显式绝对 start），
 * 包含：背景淡入、BGM 淡入、镜头推进、SFX、Voice、Ducking、BGM 交叉淡化、BGM 淡出。
 * 产物：release/v082m2b-verify/晚风-音视频演出测试工程/（用户双击工程即可打开体验）
 * 不覆盖原始《晚风》工程。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PF = require(path.join(ROOT, 'dist', 'performance.js'))();
const SRC = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
const OUT = path.join(ROOT, 'release', 'v082m2b-verify', '晚风-音视频演出测试工程');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.writeFileSync(b, fs.readFileSync(a));
  }
}

const main = () => {
  const projPath = path.join(SRC, 'project.paper.json');
  const project = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  const mk = (id, type, target, params, duration, start) => {
    const a = PF.make(id, type, target, { params, duration });
    a.start = start;
    return a;
  };
  /* 显式绝对 start：时间轴视图直接按绝对秒排布，after/parallel 退化为旧版遗留字段。 */
  const scene = [
    mk('m2b_bgm', 'audio.bgm.play', '', { audioId: 'bgm_ost_02_morning', volume: 70, fadeIn: 2, loopMode: 'all', loopStart: 0, loopEnd: 0 }, 2, 0),
    mk('m2b_fadein', 'screen.fade', '', { to: 100, color: 'black' }, 0.8, 0),
    mk('m2b_zoom', 'camera.zoom', '', { scale: 125 }, 1.6, 4),
    mk('m2b_sfx', 'audio.sfx.play', '', { audioId: 'sfx_chime', volume: 80, key: 'chime' }, 0.4, 4),
    mk('m2b_voice', 'audio.voice.play', '', { audioId: 'voice_placeholder', volume: 100, duck: true }, 1.2, 6),
    mk('m2b_duck', 'audio.ducking', '', { enabled: true, level: 35, attack: 0.22, release: 0.8 }, 0.3, 6),
    mk('m2b_crossfade', 'audio.bgm.crossfade', '', { audioId: 'bgm_ost_03_school_road', volume: 72, duration: 2.5, curve: 'equalPower', loopMode: 'all', loopStart: 0, loopEnd: 0 }, 2.5, 8),
    mk('m2b_fadeout', 'screen.fade', '', { to: 0, color: 'black' }, 0.8, 12),
    mk('m2b_stop', 'audio.bgm.stop', '', { fadeOut: 2 }, 2, 12)
  ];
  project.nodes[0].performance = { version: 1, actions: scene };
  /* 副本目录干净重建，避免残留旧 assets */
  fs.rmSync(OUT, { recursive: true, force: true });
  copyTree(SRC, OUT);
  fs.writeFileSync(path.join(OUT, 'project.paper.json'), JSON.stringify(project, null, 2));
  const total = PF.totalDuration(scene);
  const audio = scene.filter((a) => a.type.indexOf('audio.') === 0).length;
  console.log('已生成《晚风》音视频演出测试工程：', OUT);
  console.log('综合演出节点：总时长 ' + total.toFixed(2) + 's · ' + scene.length + ' 个动作 · ' + audio + ' 个音频动作');
};

main();
