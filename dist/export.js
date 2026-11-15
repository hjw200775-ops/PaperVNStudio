/* Standalone HTML game export. Shared by the editor and by Node tests so the
 * self-contained rule cannot silently differ between desktop and web. */
function buildGameHTML(p, deps) {
  const { player, coreFactory, effectFactory, css, esc } = deps;
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
  const data = JSON.stringify(p).replace(/</g, '\\u003c');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(p.title) + '</title><style>' + css + '</style></head><body><h1 id="title"></h1><div id="scene"><div id="layers"></div><div id="box"><div id="who"></div><div id="text"></div><div id="hint"></div></div><div id="choices"></div></div><nav><button id="back">上一步</button><button id="restart">重新开始</button><button id="save">保存进度</button><button id="load">读取进度</button></nav><div id="msg" role="status"></div><script>(' + player.toString() + ')(' + data + ',' + coreFactory.toString() + ',' + effectFactory.toString() + ');<\/script></body></html>';
  assertSelfContained(html);
  return html;
}

/* Only structural checks: story text may legitimately mention URLs. */
function assertSelfContained(html) {
  if (/<script[^>]+\bsrc=/i.test(html)) throw new Error('导出 HTML 引用了外部脚本');
  if (/<link[^>]+\bhref=/i.test(html)) throw new Error('导出 HTML 引用了外部样式');
  if (/<img[^>]+\bsrc="(?!data:)/i.test(html)) throw new Error('导出 HTML 引用了外部图片');
  if (/https?:\/\/127\.0\.0\.1|https?:\/\/localhost/i.test(html.split('<script>')[0])) {
    throw new Error('导出 HTML 依赖本地开发服务器');
  }
  return true;
}
if (typeof module !== 'undefined') module.exports = { buildGameHTML, assertSelfContained };
