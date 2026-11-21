/* Standalone HTML game export. Shared by the editor and by Node tests so the
 * self-contained rule cannot silently differ between desktop and web.
 * V0.5: audio is inlined as data:audio/... like images; the SAME audio factory
 * is embedded so the exported player uses identical volume/fade/lifecycle code. */
function buildGameHTML(p, deps) {
  const { player, coreFactory, effectFactory, audioFactory, css, esc } = deps;
  if (!p || !Array.isArray(p.nodes) || !Array.isArray(p.assets)) throw new Error('工程数据无效，无法导出');
  if (p.format || p.formatVersion) throw new Error('导出失败：请先以运行时工程打开，磁盘相对路径不能直接导出');
  for (const a of p.assets) {
    if (!a || typeof a.data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(a.data)) {
      throw new Error('导出失败：素材「' + (a && a.name || '未命名') + '」不是内嵌图片，请重新打开工程后再导出');
    }
    if ('file' in a || 'sha256' in a || 'path' in a || 'src' in a) {
      throw new Error('导出失败：素材含本地文件路径，拒绝生成依赖本机的游戏');
    }
  }
  const allAudio = Array.isArray(p.audioAssets) ? p.audioAssets : [];
  /* 只把剧情/标题界面真正引用到的音源放进包体；素材库其余曲目留在工程里。
     coreFactory 不可用时退回全量（宁可包大，也不让声音丢失）。 */
  const core = typeof coreFactory === 'function' ? coreFactory() : null;
  let audioAssets = allAudio;
  if (core && typeof core.referencedAudioIds === 'function') {
    const keep = new Set(core.referencedAudioIds(p));
    audioAssets = allAudio.filter(a => keep.has(a.id));
  }
  if (deps.report) {
    const kept = new Set(audioAssets.map(a => a.id));
    deps.report.audio = {
      included: audioAssets.map(a => ({ id: a.id, name: a.name, bytes: a.bytes })),
      excluded: allAudio.filter(a => !kept.has(a.id)).map(a => ({ id: a.id, name: a.name, bytes: a.bytes })),
      library: allAudio.length
    };
  }
  for (const a of audioAssets) {
    if (!a || typeof a.data !== 'string' || !/^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/i.test(a.data)) {
      throw new Error('导出失败：音频素材「' + (a && a.name || '未命名') + '」不是内嵌音频，请重新打开工程后再导出');
    }
    if ('file' in a || 'sha256' in a || 'path' in a || 'src' in a) {
      throw new Error('导出失败：音频素材含本地文件路径，拒绝生成依赖本机的游戏');
    }
  }
  /* 播放器只拿到被引用的音源：包体小，也避免把未使用的曲目泄漏出去。 */
  const gameProject = audioAssets.length === allAudio.length ? p : Object.assign({}, p, { audioAssets });
  const data = JSON.stringify(gameProject).replace(/</g, '\\u003c');
  /* 没有音频工厂时传 null：旧无音频工程不创建播放任务，含音频工程则必须提供。 */
  const audioArg = typeof audioFactory === 'function' ? '(' + audioFactory.toString() + ')' : 'null';
  if (audioAssets.length && audioArg === 'null') throw new Error('导出失败：缺少音频运行层');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(p.title) + '</title><style>' + css + '</style></head><body><section id="titleScreen"><div id="titleBg" hidden><img id="titleBgImg" alt="" draggable="false"></div><div class="title-card"><p class="title-eyebrow">PAPER / STORY</p><h1 id="title"></h1><p id="titleEmpty" class="title-note" hidden>这个作品还没有可播放的剧情。请回到编辑器添加至少一句台词。</p><p id="titleBgNote" class="title-note" hidden></p><div class="title-actions"><button id="startGame" class="primary">开始游戏</button><button id="continueGame">继续游戏</button><button id="titleSettings">设置</button></div><p id="titleNote" class="title-note"></p></div></section><main id="gameRoot" hidden><div id="scene" tabindex="0"><div id="layers"></div><div id="box"><div id="who"></div><div id="text"></div><div id="hint"></div></div><div id="choices"></div></div><nav id="playBar"><button id="back">上一步</button><button id="restart">重新开始</button><button id="menuBtn">菜单</button></nav></main><div id="menuOverlay" class="overlay" hidden><div class="panel menu-panel" role="dialog" aria-modal="true" aria-label="游戏菜单"><h2>游戏菜单</h2><div class="menu-actions"><button id="menuResume" class="primary">返回游戏</button><button id="save">保存进度</button><button id="load">读取进度</button><button id="menuSettings">设置</button><button id="menuTitle">返回标题</button></div><p id="menuNote" class="note"></p></div></div><div id="settingsOverlay" class="overlay" hidden><div class="panel settings-panel" role="dialog" aria-modal="true" aria-label="设置"><h2>设置</h2><div id="audioPanel"><div class="audio-head"><button id="enableSound">启用声音</button><span id="audioStatus"></span></div><div id="audioMixers"><label>总音量 <span id="volMasterVal">100%</span><input id="volMaster" type="range" min="0" max="100" value="100"></label><label>音乐 <span id="volBgmVal">80%</span><input id="volBgm" type="range" min="0" max="100" value="80"></label><label>音效 <span id="volSfxVal">100%</span><input id="volSfx" type="range" min="0" max="100" value="100"></label><label>语音 <span id="volVoiceVal">100%</span><input id="volVoice" type="range" min="0" max="100" value="100"></label><label class="mute-label"><input id="muteAll" type="checkbox">静音</label></div></div><p id="noAudioNote" class="note" hidden>本作品没有音频，音量设置不适用。</p><p id="settingsNote" class="note"></p><button id="setBack" class="primary">返回</button></div></div><div id="confirmOverlay" class="overlay" hidden><div class="panel" role="dialog" aria-modal="true" aria-label="重新开始"><h2>重新开始？</h2><p class="note">会重置本次游玩进度，但不会删除已有存档。</p><div class="menu-actions"><button id="confirmRestart" class="primary">重新开始</button><button id="cancelRestart">取消</button></div></div></div><div id="msg" role="status"></div><script>(' + player.toString() + ')(' + data + ',' + coreFactory.toString() + ',' + effectFactory.toString() + ',' + audioArg + ');<\/script></body></html>';
  assertSelfContained(html);
  if (audioAssets.length && !/data:audio\//.test(html)) throw new Error('导出失败：音频没有内嵌进 HTML');
  return html;
}

/* 导出前给作者看的体积估算：音频按 base64 膨胀约 4/3。 */
function audioExportSize(p) {
  const list = Array.isArray(p && p.audioAssets) ? p.audioAssets : [];
  const bytes = list.reduce((s, a) => s + (Number(a && a.bytes) || 0), 0);
  const embedded = list.reduce((s, a) => s + (typeof (a && a.data) === 'string' ? a.data.length : 0), 0);
  return { count: list.length, bytes, embedded, approxHtmlBytes: embedded + 64 * 1024,
    label: (embedded / 1024 / 1024).toFixed(1) + ' MB' };
}

/* Only structural checks: story text may legitimately mention URLs. */
function assertSelfContained(html) {
  if (/<script[^>]+\bsrc=/i.test(html)) throw new Error('导出 HTML 引用了外部脚本');
  if (/<link[^>]+\bhref=/i.test(html)) throw new Error('导出 HTML 引用了外部样式');
  if (/<img[^>]+\bsrc="(?!data:)/i.test(html)) throw new Error('导出 HTML 引用了外部图片');
  if (/<(?:audio|source|video)[^>]+\bsrc="(?!data:)/i.test(html)) throw new Error('导出 HTML 引用了外部音频');
  const structural = html.split('<script>')[0];
  if (/https?:\/\/127\.0\.0\.1|https?:\/\/localhost/i.test(structural)) {
    throw new Error('导出 HTML 依赖本地开发服务器');
  }
  if (/\b(?:src|href)\s*=\s*["'](?:paper:\/\/|blob:|file:\/\/|https?:\/\/)/i.test(structural)) {
    throw new Error('导出 HTML 含本机协议或远程地址');
  }
  if (/[A-Za-z]:\\[^\s"'<>]/.test(structural)) throw new Error('导出 HTML 含本机绝对路径');
  return true;
}
if (typeof module !== 'undefined') module.exports = { buildGameHTML, assertSelfContained, audioExportSize };
