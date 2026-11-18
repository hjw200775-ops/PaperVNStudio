'use strict';
/* 读取 ZIP 中央目录，只为了「包里到底有什么」这一类审计。
 * 不用 tar -t：Windows 版 bsdtar 把文件名按控制台代码页输出，中文会变成乱码，
 * 用它来判断清单会得到假失败。这里按 ZIP 规范直接解析，UTF-8 标志位优先。 */
const fs = require('node:fs');

function listZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const maxBack = Math.min(buf.length, 66 * 1024);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录结尾）：' + zipPath);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('暂不支持 ZIP64 清单：' + zipPath);

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录记录损坏（第 ' + (n + 1) + ' 条）');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const utf8 = (flags & 0x0800) !== 0;
    let name;
    try { name = nameBytes.toString(utf8 ? 'utf8' : 'utf8'); } catch { name = nameBytes.toString('latin1'); }
    entries.push({ name: name.replace(/\\/g, '/'), size, compressed, method,
      localOffset: buf.readUInt32LE(p + 42), flags,
      directory: name.endsWith('/'), utf8Flag: utf8 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (cdSize && p - cdOffset !== cdSize) throw new Error('中央目录长度与声明不一致');
  return entries;
}

module.exports = { listZipEntries };
