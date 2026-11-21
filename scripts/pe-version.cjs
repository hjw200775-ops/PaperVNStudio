'use strict';
/* 直接读 PE 的版本资源，不依赖 signtool / PowerShell。
 * 用于验收断言「EXE 文件属性里的版本 == manifest.exeVersion」。 */
const fs = require('node:fs');

function rvaToOffset(buf, sections, rva) {
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      return s.rawPointer + (rva - s.virtualAddress);
    }
  }
  return 0;
}

function readSections(buf, tableOffset, count) {
  const sections = [];
  for (let i = 0; i < count; i++) {
    const o = tableOffset + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(o + 8),
      virtualAddress: buf.readUInt32LE(o + 12),
      rawSize: buf.readUInt32LE(o + 16),
      rawPointer: buf.readUInt32LE(o + 20)
    });
  }
  return sections;
}

/* 资源目录是一棵三层的树：类型 → 名称 → 语言 → 数据项。 */
function dirEntries(buf, offset) {
  const named = buf.readUInt16LE(offset + 12);
  const ids = buf.readUInt16LE(offset + 14);
  const list = [];
  for (let i = 0; i < named + ids; i++) {
    const e = offset + 16 + i * 8;
    list.push({ id: buf.readUInt32LE(e), target: buf.readUInt32LE(e + 4) });
  }
  return list;
}

function pickId(buf, offset, wanted) {
  return dirEntries(buf, offset).find(x => (x.id & 0x80000000) === 0 && x.id === wanted);
}

function versionOf(ms, ls) {
  return ((ms >>> 16) & 0xffff) + '.' + (ms & 0xffff) + '.' + ((ls >>> 16) & 0xffff) + '.' + (ls & 0xffff);
}

function readPeVersion(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null;
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null;

  const coff = peOff + 4;
  const sectionCount = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) return null;

  const dirOffset = opt + (magic === 0x20b ? 112 : 96);
  const resRva = buf.readUInt32LE(dirOffset + 2 * 8);
  if (!resRva) return null;

  const sections = readSections(buf, opt + optSize, sectionCount);
  const root = rvaToOffset(buf, sections, resRva);
  if (!root) return null;

  /* 目录树里每个子目录的偏移都相对资源基址（root），不是相对父目录。 */
  const type = pickId(buf, root, 16); // RT_VERSION
  if (!type || !(type.target & 0x80000000)) return null;
  const name = pickId(buf, root + (type.target & 0x7fffffff), 1);
  if (!name || !(name.target & 0x80000000)) return null;

  const nameDir = root + (name.target & 0x7fffffff);
  const langs = dirEntries(buf, nameDir);
  if (!langs.length) return null;

  /* 多数链接器会在名称目录下再放一层语言目录；lld 生成的资源可能把语言
   * 直接写成数据项。两种布局都接受，只看目标偏移的高位。 */
  let leaf = langs[0].target;
  if (leaf & 0x80000000) {
    const langDir = root + (leaf & 0x7fffffff);
    const lang = dirEntries(buf, langDir)[0];
    if (!lang) return null;
    leaf = lang.target;
  }
  const dataEntry = root + (leaf & 0x7fffffff);
  const dataRva = buf.readUInt32LE(dataEntry);
  const dataSize = buf.readUInt32LE(dataEntry + 4);
  const dataOff = rvaToOffset(buf, sections, dataRva);
  if (!dataOff || !dataSize) return null;

  /* VS_FIXEDFILEINFO 的签名是 0xFEEF04BD，允许前后有对齐填充。 */
  const end = Math.min(buf.length, dataOff + dataSize);
  let fixed = -1;
  for (let i = dataOff; i + 52 <= end; i += 4) {
    if (buf.readUInt32LE(i) === 0xfeef04bd) { fixed = i; break; }
  }
  if (fixed < 0) return null;

  return {
    fileVersion: versionOf(buf.readUInt32LE(fixed + 8), buf.readUInt32LE(fixed + 12)),
    productVersion: versionOf(buf.readUInt32LE(fixed + 16), buf.readUInt32LE(fixed + 20)),
    fixedOffset: fixed
  };
}

module.exports = { readPeVersion };
