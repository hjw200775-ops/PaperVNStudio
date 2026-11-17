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
  const audioAssets = Array.isArray(p.audioAssets) ? p.audioAssets : [];
  for (const a of audioAssets) {
    if (!a || typeof a.data !== 'string' || !/^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/i.test(a.data)) {
      throw new Error('导出失败：音频素材「' + (a && a.name || '未命名') + '」不是内嵌音频，请重新打开工程后再导出');
    }
    if ('file' in a || 'sha256' in a || 'path' in a || 'src' in a) {
      throw new Error('导出失败：音频素材含本地文件路径，拒绝生成依赖本机的游戏');
    }
  }
  const data = JSON.stringify(p).replace(/</g, '\\u003c');
  /* 没有音频工厂时传 null：旧无音频工程不创建播放任务，含音频工程则必须提供。 */
  const audioArg = typeof audioFactory === 'function' ? '(' + audioFactory.toString() + ')' : 'null';
  if (audioAssets.length && audioArg === 'null') throw new Error('导出失败：缺少音频运行层');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(p.title) + '</title><style>' + css + '</style></head><body><h1 id="title"></h1><div id="scene"><div id="layers"></div><div id="box"><div id="who"></div><div id="text"></div><div id="hint"></div></div><div id="choices"></div></div><nav><button id="back">上一步</button><button id="restart">重新开始</button><button id="save">保存进度</button><button id="load">读取进度</button></nav><section id="audioPanel"><div class="audio-head"><button id="enableSound">点击开始 / 启用声音</button><span id="audioStatus">音频待启用</span></div><div id="audioMixers"><label>总音量 <input id="volMaster" type="range" min="0" max="100" value="100"><span id="volMasterVal">100%</span></label><label>音乐 <input id="volBgm" type="range" min="0" max="100" value="80"><span id="volBgmVal">80%</span></label><label>音效 <input id="volSfx" type="range" min="0" max="100" value="100"><span id="volSfxVal">100%</span></label><label>语音 <input id="volVoice" type="range" min="0" max="100" value="100"><span id="volVoiceVal">100%</span></label><label class="mute-label"><input id="muteAll" type="checkbox">静音</label></div></section><div id="msg" role="status"></div><script>(' + player.toString() + ')(' + data + ',' + coreFactory.toString() + ',' + effectFactory.toString() + ',' + audioArg + ');<\/script></body></html>';
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
