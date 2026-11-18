'use strict';
/* 极简 ZIP 写入器：只做本游戏包需要的事——目录树 + deflate + UTF-8 文件名。
 *
 * 为什么不用 tar.exe / Compress-Archive：Windows 版 bsdtar 会按控制台代码页写文件名
 * 且不置 UTF-8 标志位，中文解压到不同语言系统就是乱码。ZIP 规范里的通用标志位 11
 * 明确表示「文件名是 UTF-8」，这里自己写，保证「晚风经过二楼走廊.exe」在任何 Windows
 * 解压工具里都还原成同一个名字。 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.valueOf()) ? date : new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

function walkFiles(root) {
  const out = [];
  const walk = rel => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? rel + '/' + name : name;
      const abs = path.join(root, r);
      const st = fs.statSync(abs);
      if (st.isDirectory()) { out.push({ rel: r, dir: true, mtime: st.mtime }); walk(r); }
      else out.push({ rel: r, dir: false, mtime: st.mtime, size: st.size, abs });
    }
  };
  walk('');
  return out;
}

/**
 * @param {string} zipPath 输出文件
 * @param {string} rootDir 要打包的目录
 * @param {string} topName ZIP 内的顶层目录名（解压后看到的文件夹名）
 */
function writeZip(zipPath, rootDir, topName) {
  if (!fs.existsSync(rootDir)) throw new Error('要打包的目录不存在：' + rootDir);
  const entries = walkFiles(rootDir);
  const fd = fs.openSync(zipPath, 'w');
  const central = [];
  let offset = 0;
  let rawBytes = 0;
  let packedBytes = 0;

  const put = buf => { fs.writeSync(fd, buf); offset += buf.length; };

  try {
    for (const e of entries) {
      const name = Buffer.from(topName + '/' + e.rel + (e.dir ? '/' : ''), 'utf8');
      const { time, day } = dosTime(e.mtime);
      if (e.dir) {
        central.push({ name, time, day, crc: 0, csize: 0, usize: 0, offset, dir: true });
        put(makeLocalHeader(name, time, day, 0, 0, 0, 0));
        continue;
      }
      const data = fs.readFileSync(e.abs);
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      const useDeflate = deflated.length < data.length;
      const payload = useDeflate ? deflated : data;
      const crc = crc32(data);
      const method = useDeflate ? 8 : 0;
      rawBytes += data.length;
      packedBytes += payload.length;
      central.push({ name, time, day, crc, csize: payload.length, usize: data.length, offset, dir: false, method });
      put(makeLocalHeader(name, time, day, crc, payload.length, data.length, method));
      put(payload);
    }

    const cdStart = offset;
    for (const c of central) {
      put(makeCentralRecord(c, c.name, c.time, c.day, c.method || 0, c.crc, c.csize, c.usize, c.offset, c.dir));
    }
    const cdSize = offset - cdStart;
    put(makeEocd(central.length, cdSize, cdStart));
  } finally {
    fs.closeSync(fd);
  }

  return { entries: central.length, rawBytes, packedBytes, bytes: fs.statSync(zipPath).size };
}

const FLAG_UTF8 = 0x0800;

function makeLocalHeader(name, time, day, crc, csize, usize, method) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);          /* version needed */
  h.writeUInt16LE(FLAG_UTF8, 6);   /* 文件名是 UTF-8 */
  h.writeUInt16LE(method, 8);
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(day, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(csize, 18);
  h.writeUInt32LE(usize, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, name]);
}

function makeCentralRecord(c, name, time, day, method, crc, csize, usize, offset, dir) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(0x031e, 4);      /* made by: unix, zip 3.0 */
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(FLAG_UTF8, 8);
  h.writeUInt16LE(method, 10);
  h.writeUInt16LE(time, 12);
  h.writeUInt16LE(day, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(csize, 20);
  h.writeUInt32LE(usize, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30);          /* extra */
  h.writeUInt16LE(0, 32);          /* comment */
  h.writeUInt16LE(0, 34);          /* disk */
  h.writeUInt16LE(0, 36);          /* internal attr */
  h.writeUInt32LE(dir ? 0x10 : 0x20, 38);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, name]);
}

function makeEocd(count, cdSize, cdOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(0, 20);
  return h;
}

module.exports = { writeZip, crc32 };
