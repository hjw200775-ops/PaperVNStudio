'use strict';
/*
 * 游戏打包工作进程（V0.7.2）。
 *
 * 主进程只做「快、会用 Electron API」的部分（生成 HTML、图标缩放），把复制运行时、
 * rcedit、ZIP、NSIS 这些耗时且会占满事件循环的活交给这个子进程：
 *   - 主进程不再被阻塞，界面能刷新，取消 IPC 能及时送达；
 *   - 取消 = 杀掉子进程 + 删临时目录，目标位置在最后一步之前都不会被碰。
 *
 * 这个文件用纯 Node 跑（ELECTRON_RUN_AS_NODE=1），不 require electron。
 * 约定：
 *   argv[2] = job.json 路径
 *   stdout 每行 "PROGRESS {json}" / 最后一行 "RESULT {json}"
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeZip } = require('./zip-writer.cjs');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

const STAGE_LABELS = {
  runtime: '复制 Electron 运行时',
  stamp: '写入产品名、版本与图标',
  zip: '打包 ZIP',
  portable: '打包单文件便携版'
};

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push({ rel: path.relative(base, abs).replace(/\\/g, '/'), abs, bytes: st.size });
  }
  return out;
}

function copyTree(srcDir, destDir, { skip = [], onFile } = {}) {
  const skipped = new Set(skip.map(s => s.replace(/\\/g, '/')));
  const copy = rel => {
    const abs = path.join(srcDir, rel);
    for (const name of fs.readdirSync(abs)) {
      const childRel = rel ? rel + '/' + name : name;
      if (skipped.has(childRel)) continue;
      const from = path.join(srcDir, childRel);
      const to = path.join(destDir, childRel);
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        copy(childRel);
      } else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        /* 每 8MB 报告一次进度：子进程里阻塞没关系，主进程照常响应取消。 */
        if (onFile) onFile(st.size);
      }
    }
  };
  copy('');
}

function numericVersion(v) {
  /* EXE 的版本资源只接受四段数字。版本号可能带预发布后缀（0.7.2-test），
     取每段的前导数字并保留段位：0.7.2-test → 0.7.2.0，1.2.3-beta.1 → 1.2.3.1，2 → 2.0.0.0。
     旧实现用整段匹配，会把 "2-test" 整段丢掉、导致段位左移（0.7.2-test → 0.7.0.0）。 */
  const parts = String(v || '').trim().split('.')
    .map(x => (x.match(/^\d+/) || [''])[0])
    .filter(x => x !== '').slice(0, 4).map(Number);
  if (!parts.length) return '1.0.0.0';
  while (parts.length < 4) parts.push(0);
  return parts.join('.');
}

function readPeSignature(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    fs.readSync(fd, dos, 0, 64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) return { isPe: false, signed: false };
    const peOff = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(26);
    fs.readSync(fd, pe, 0, 26, peOff);
    if (pe.readUInt32LE(0) !== 0x00004550) return { isPe: false, signed: false };
    const magic = pe.readUInt16LE(24);
    const dirStart = peOff + 24 + (magic === 0x20b ? 112 : 96);
    const dir = Buffer.alloc(8);
    fs.readSync(fd, dir, 0, 8, dirStart + 4 * 8);
    const size = dir.readUInt32LE(4);
    return { isPe: true, signed: size > 0, certBytes: size };
  } finally {
    fs.closeSync(fd);
  }
}

function report(stage, percent, detail) {
  process.stdout.write('PROGRESS ' + JSON.stringify({
    stage, label: STAGE_LABELS[stage] || stage, percent, detail: detail || ''
  }) + '\n');
}

function stampExe(job, exePath) {
  const args = [
    exePath,
    '--set-icon', job.iconPath,
    '--set-version-string', 'ProductName', job.settings.title,
    '--set-version-string', 'FileDescription', job.settings.title,
    '--set-version-string', 'CompanyName', job.settings.author || job.settings.title,
    '--set-version-string', 'LegalCopyright', job.settings.copyright,
    '--set-version-string', 'LegalTrademarks', job.settings.title,
    '--set-version-string', 'OriginalFilename', job.exeName,
    '--set-version-string', 'InternalName', job.settings.releaseId,
    '--set-product-version', numericVersion(job.settings.version),
    '--set-file-version', numericVersion(job.settings.version)
  ];
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync(job.toolchain.rcedit, args, { encoding: 'utf8', windowsHide: true });
    if (!r.error && r.status === 0) return;
    last = r.error ? r.error.message : ((r.stderr || r.stdout || '').trim() || ('rcedit 退出码 ' + r.status));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  }
  throw new Error('写入版本信息失败：' + last);
}

function nsisQuote(s) {
  return String(s).replace(/"/g, '$\\"');
}

function makePortable(job, runtimeRoot, exePath, outExe) {
  const scriptPath = path.join(path.dirname(outExe), 'portable.nsi');
  const exeRel = path.relative(runtimeRoot, exePath).replace(/\//g, '\\');
  const s = job.settings;
  const script = [
    'Unicode true',
    '!include "FileFunc.nsh"',
    'Name "' + nsisQuote(s.title) + '"',
    'OutFile "' + nsisQuote(outExe) + '"',
    'Icon "' + nsisQuote(job.iconPath) + '"',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    'SetCompressor /SOLID lzma',
    'VIProductVersion "' + numericVersion(s.version) + '"',
    'VIAddVersionKey /LANG=2052 "ProductName" "' + nsisQuote(s.title) + '"',
    'VIAddVersionKey /LANG=2052 "FileDescription" "' + nsisQuote(s.title) + '"',
    'VIAddVersionKey /LANG=2052 "CompanyName" "' + nsisQuote(s.author || s.title) + '"',
    'VIAddVersionKey /LANG=2052 "LegalCopyright" "' + nsisQuote(s.copyright) + '"',
    'InstallDir "$TEMP\\PaperVN-' + s.releaseId + '"',
    'Section "Game"',
    '  SetOutPath "$INSTDIR"',
    '  File /r "' + nsisQuote(path.join(runtimeRoot, '*.*')) + '"',
    /* 把便携版收到的参数原样转给游戏（例如调试参数或将来支持的 --fullscreen）。 */
    '  ${GetParameters} $R0',
    '  ExecWait \'"$INSTDIR\\' + exeRel + '" $R0\'',
    '  SetOutPath "$TEMP"',
    '  RMDir /r "$INSTDIR"',
    'SectionEnd'
  ].join('\r\n') + '\r\n';
  /* NSIS 3 需要带 BOM 的 UTF-8 才认中文。 */
  fs.writeFileSync(scriptPath, '\uFEFF' + script, 'utf8');
  const r = spawnSync(job.toolchain.nsis, ['/V2', scriptPath], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error('NSIS 启动失败：' + r.error.message);
  if (r.status !== 0) {
    throw new Error('NSIS 打包失败：' + ((r.stdout || r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ')));
  }
  if (!fs.existsSync(outExe)) throw new Error('NSIS 没有产出单文件 EXE');
}

/* 目录版产物：整体搬到目标位置。同盘 rename 最快，跨盘退回复制再删。 */
function moveTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch {
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function treeBytes(dir) {
  let total = 0, files = 0;
  for (const n of fs.readdirSync(dir)) {
    const abs = path.join(dir, n);
    const st = fs.statSync(abs);
    if (st.isDirectory()) { const sub = treeBytes(abs); total += sub.bytes; files += sub.files; }
    else { total += st.size; files += 1; }
  }
  return { bytes: total, files };
}

function moveIntoPlace(tmpFile, finalFile) {
  try {
    fs.rmSync(finalFile, { force: true });
    fs.renameSync(tmpFile, finalFile);
  } catch {
    fs.copyFileSync(tmpFile, finalFile);
    fs.rmSync(tmpFile, { force: true });
  }
}

function run(job) {
  const timings = [];
  const stage = (name, percent, detail) => {
    report(name, percent, detail);
    timings.push({ stage: name, label: STAGE_LABELS[name], at: Date.now() - job.startedAt });
    return detail;
  };
  const done = ms => { timings[timings.length - 1].ms = ms; };

  let t0 = Date.now();
  stage('runtime', 22);
  const runtimeRoot = path.join(job.workDir, 'runtime', 'game');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const skip = [
    'resources/app', 'resources/app.asar', 'resources/app.asar.unpacked',
    'resources/toolchain', 'resources/default_app.asar', 'resources/elevate.exe', '__pycache__'
  ];
  const all = walk(job.runtimeSrc).filter(f => !skip.some(s => f.rel === s || f.rel.startsWith(s + '/')));
  const totalBytes = all.reduce((sum, f) => sum + f.bytes, 0) || 1;
  let copied = 0;
  let lastPct = -100;
  copyTree(job.runtimeSrc, runtimeRoot, {
    skip,
    onFile: size => {
      copied += size;
      const pct = 22 + 40 * Math.min(1, copied / totalBytes);
      if (pct - lastPct >= 2) { lastPct = pct; report('runtime', pct, '复制运行时 ' + mb(copied) + ' / ' + mb(totalBytes)); }
    }
  });
  copyTree(job.pkgDir, path.join(runtimeRoot, 'resources', 'app'));
  const sourceExe = fs.readdirSync(runtimeRoot).find(n => /\.exe$/i.test(n) && n.toLowerCase() !== 'elevate.exe');
  if (!sourceExe) throw new Error('运行时目录里没有可用的 EXE');
  const asciiExe = path.join(runtimeRoot, 'game-launcher.exe');
  fs.renameSync(path.join(runtimeRoot, sourceExe), asciiExe);
  done(Date.now() - t0);

  t0 = Date.now();
  stage('stamp', 68);
  /* rcedit 读不了非 ASCII 路径：先用 ASCII 名写入，再改成产品名。 */
  stampExe(job, asciiExe);
  const exePath = path.join(runtimeRoot, job.exeName);
  if (job.exeName !== 'game-launcher.exe') fs.renameSync(asciiExe, exePath);
  done(Date.now() - t0);

  let artifact;
  if (job.type === 'folder') {
    t0 = Date.now();
    stage('folder', 76);
    moveTree(runtimeRoot, job.outPath);
    done(Date.now() - t0);
    artifact = job.outPath;
  } else if (job.type === 'zip') {
    t0 = Date.now();
    stage('zip', 76);
    const tmpZip = path.join(job.workDir, 'out.zip');
    const info = writeZip(tmpZip, runtimeRoot, job.settings.fileBase);
    moveIntoPlace(tmpZip, job.outPath);
    report('zip', 96, 'ZIP ' + mb(info.bytes));
    done(Date.now() - t0);
    artifact = job.outPath;
  } else {
    t0 = Date.now();
    stage('portable', 76);
    const tmpExe = path.join(job.workDir, 'portable.exe');
    makePortable(job, runtimeRoot, exePath, tmpExe);
    moveIntoPlace(tmpExe, job.outPath);
    done(Date.now() - t0);
    artifact = job.outPath;
  }

  const isDir = fs.statSync(artifact).isDirectory();
  const bytes = isDir ? treeBytes(artifact).bytes : fs.statSync(artifact).size;
  /* 目录版：产物是文件夹，PE 探测指向里面的 EXE。 */
  const peTarget = isDir ? path.join(artifact, job.exeName) : (job.type === 'zip' ? exePath : artifact);
  const probe = readPeSignature(peTarget);
  return {
    ok: true,
    artifact,
    bytes,
    /* 目录版没有单文件哈希：清单里记目录名与体积，逐文件哈希由 manifest 的资源表负责。 */
    sha256: isDir ? null : sha256(fs.readFileSync(artifact)),
    exeName: job.exeName,
    stages: timings,
    signature: {
      signed: probe.signed, certBytes: probe.certBytes || 0,
      note: probe.signed ? 'EXE 内含 Authenticode 签名' : '未配置代码签名证书，构建未签名'
    }
  };
}

function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error('缺少 job 文件');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  try {
    const result = run(job);
    process.stdout.write('RESULT ' + JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write('RESULT ' + JSON.stringify({ ok: false, message: e.message }) + '\n');
    process.exit(1);
  }
}

main();
