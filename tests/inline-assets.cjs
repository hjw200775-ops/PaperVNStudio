'use strict';
/* V0.7.6 起运行时素材是 paperasset:// 地址：单文件 HTML 导出前要读回 data URI。
 * 测试里用它把「打开自磁盘的工程」还原成自包含工程。 */
const fs = require('node:fs');
const path = require('node:path');

const isUrl = v => /^paper:\/\/app\/asset\//i.test(String(v || ''));

function inlineAssets(project, root) {
  const conv = a => {
    if (!isUrl(a.data)) return a;
    const rel = a.file || String(a.data).replace(/^paper:\/\/app\/asset\//i, '');
    const buf = fs.readFileSync(path.join(root, ...rel.split('/')));
    const mime = a.mime || (/\.(ogg|mp3|wav|m4a|flac)$/i.test(rel) ? 'audio/ogg' : 'image/png');
    return Object.assign({}, a, { data: 'data:' + mime + ';base64,' + buf.toString('base64') });
  };
  return Object.assign({}, project, {
    assets: (project.assets || []).map(conv),
    audioAssets: (project.audioAssets || []).map(conv)
  });
}

module.exports = { inlineAssets, isUrl };
