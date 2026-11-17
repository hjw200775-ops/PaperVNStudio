/* 唯一的「工程 → 自包含播放器 HTML」入口。
 * 编辑器导出、完整预览、内置示例体验与测试都走这里，避免几套拼接逻辑各自演化。
 * 浏览器里使用已加载的全局工厂；Node（主进程 / 测试）里按需 require 同一批文件。 */
function buildPlayerHTML(p, esc) {
  const escape = esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  if (typeof paperPlayer === 'function' && typeof buildGameHTML === 'function') {
    return buildGameHTML(p, { player: paperPlayer, coreFactory: createVNCore,
      effectFactory: createPaperEffects, audioFactory: createPaperAudio,
      css: paperPlayerCSS, esc: escape });
  }
  const ex = require('./export.js');
  return ex.buildGameHTML(p, { player: require('./player.js').paperPlayer,
    coreFactory: require('./core.js'), effectFactory: require('./effects.js'),
    audioFactory: require('./audio.js'), css: require('./player.js').paperPlayerCSS, esc: escape });
}
if (typeof module !== 'undefined') module.exports = { buildPlayerHTML };
