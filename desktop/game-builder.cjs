'use strict';
/*
 * 纸间 · 通用独立游戏构建器（V0.7.2）。
 *
 * 主进程负责「快、要用 Electron API」的部分：校验工程、生成播放器 HTML、归一图标；
 * 复制运行时、rcedit、ZIP、NSIS 这些耗时且会占满事件循环的活交给 game-pack-worker.cjs
 * 子进程。这样界面在构建期间仍然能刷新，取消也能及时生效（取消 = 杀子进程）。
 *
 * 输入一份运行时工程快照，输出：
 *   A. 解压目录版 ZIP
 *   B. 单文件便携 EXE（同一份 runtime + NSIS 自解压）
 *
 * 约束：不依赖开发机 node_modules 或盘符硬编码；运行时取自当前 Electron；先写临时目录，
 * 成功后才落到目标位置；失败/取消不动用户已有的发行产物。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const STAGE_LABELS = {
  check: '检查工程完整性',
  content: '生成播放器内容',
  stage: '准备播放器壳',
  icon: '生成 Windows 图标',
  runtime: '复制 Electron 运行时',
  stamp: '写入产品名、版本与图标',
  zip: '打包 ZIP',
  portable: '打包单文件便携版',
  done: '完成'
};

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

class Cancelled extends Error {
  constructor() { super('已取消'); this.cancelled = true; }
}

function safeFileName(name, fallback = 'game') {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\0]/g, '_')
    .replace(/[\s.]+$/g, '')
    .trim()
    .slice(0, 80);
  return s || fallback;
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

/* data URI → content/assets 下的内容寻址文件，返回 papergame:// 地址。
   同一内容只写一次，避免重复素材把包撑大。 */
function encodedBytes(s) {
  if (typeof s !== 'string') return 0;
  const i = s.indexOf('base64,');
  return i < 0 ? s.length : Math.floor((s.length - i - 7) * 3 / 4);
}

function writeContentAsset(contentDir, sub, data, projectRoot) {
  const raw = String(data || '');
  let buf, ext;
  if (/^paper:\/\/app\/asset\//i.test(raw)) {
    /* 运行时素材就是磁盘文件：按相对路径读，避免重新编码整份素材。 */
    const rel = raw.replace(/^paper:\/\/app\/asset\//i, '');
    if (!projectRoot) throw new Error('缺少工程目录，无法读取素材：' + rel);
    const root = path.resolve(projectRoot);
    const abs = path.resolve(root, ...rel.split('/'));
    if (!abs.startsWith(root + path.sep)) throw new Error('素材路径越界：' + rel);
    buf = fs.readFileSync(abs);
    ext = path.extname(abs).slice(1).toLowerCase();
  } else {
    const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(raw);
    if (!m) throw new Error('素材格式无效：只接受内嵌 data URI 或受控素材地址');
    buf = Buffer.from(m[2], 'base64');
    ext = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
      'audio/wave': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'webm'
    }[m[1].toLowerCase()];
  }
  if (!ext) throw new Error('不支持的素材类型');
  if (!buf.length) throw new Error('素材为空');
  const hash = require('node:crypto').createHash('sha256').update(buf).digest('hex');
  const abs = path.join(contentDir, sub, hash + '.' + ext);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
  return 'papergame://game/' + sub + '/' + hash + '.' + ext;
}

function createGameBuilder({ repoRoot, execPath, resourcesPath, isPackaged }) {
  const core = require(path.join(repoRoot, 'dist', 'core.js'))();
  const { buildPlayerHTML } = require(path.join(repoRoot, 'dist', 'game-html.js'));

  function toolchain() {
    const candidates = [];
    if (resourcesPath) candidates.push(path.join(resourcesPath, 'toolchain'));
    candidates.push(path.join(repoRoot, 'vendor', 'toolchain'));
    const root = candidates.find(p => fs.existsSync(path.join(p, 'toolchain.json'))) || null;
    const runtime = {
      exe: execPath, dir: path.dirname(execPath),
      version: process.versions.electron, ok: false, note: ''
    };
    runtime.ok = !!(execPath && fs.existsSync(execPath) && fs.existsSync(path.join(runtime.dir, 'resources')));
    runtime.note = runtime.ok ? '' : '当前程序的 Electron 运行时目录不完整，无法导出';
    if (!root) {
      return {
        root: null, runtime,
        rcedit: { ok: false, path: '', note: '缺少构建组件目录' },
        nsis: { ok: false, path: '', note: '缺少构建组件目录' },
        note: '没有找到构建组件（toolchain）。运行 npm run tools:prepare 准备后重新打包纸间。'
      };
    }
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(root, 'toolchain.json'), 'utf8')); } catch { /* 清单损坏按缺失处理 */ }
    const rceditPath = path.join(root, 'rcedit', 'rcedit-x64.exe');
    const makensisPath = path.join(root, 'nsis', 'makensis.exe');
    const rcedit = { ok: fs.existsSync(rceditPath), path: rceditPath, version: (meta.rcedit && meta.rcedit.version) || '', note: '' };
    if (!rcedit.ok) rcedit.note = '缺少 rcedit，无法写入图标与版本信息';
    const nsis = { ok: fs.existsSync(makensisPath), path: makensisPath, version: (meta.nsis && meta.nsis.version) || '', note: '' };
    if (!nsis.ok) nsis.note = '缺少 NSIS，只能导出解压目录版 ZIP';
    return { root, runtime, rcedit, nsis, note: '' };
  }

  /* 512 见方 PNG → 多尺寸 ICO；没有自定义图标时用随包默认图标。 */
  function buildIco(nativeImage, iconDataUrl, workDir) {
    if (!iconDataUrl) {
      const fallback = path.join(repoRoot, 'desktop', 'game-shell', 'default-icon.ico');
      if (!fs.existsSync(fallback)) throw new Error('缺少默认图标：desktop/game-shell/default-icon.ico');
      const target = path.join(workDir, 'icon.ico');
      fs.copyFileSync(fallback, target);
      return { path: target, source: 'default', sizes: readIcoSizes(target) };
    }
    const b64 = String(iconDataUrl).split(',')[1] || '';
    const image = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (image.isEmpty()) throw new Error('游戏图标无法解码，请重新导入 PNG');
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
    const entries = sizes.map(size => ({ size, buf: image.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
    const target = path.join(workDir, 'icon.ico');
    fs.writeFileSync(target, assembleIco(entries));
    return { path: target, source: 'custom', sizes };
  }

  function readIcoSizes(file) {
    const b = fs.readFileSync(file);
    const n = b.readUInt16LE(4);
    const out = [];
    for (let i = 0; i < n; i++) out.push(b.readUInt8(6 + 16 * i) || 256);
    return out;
  }

  function assembleIco(entries) {
    const sorted = entries.slice().sort((a, b) => a.size - b.size);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sorted.length, 4);
    const dirs = [];
    const blobs = [];
    let offset = 6 + 16 * sorted.length;
    for (const { size, buf } of sorted) {
      const d = Buffer.alloc(16);
      d.writeUInt8(size >= 256 ? 0 : size, 0);
      d.writeUInt8(size >= 256 ? 0 : size, 1);
      d.writeUInt16LE(1, 4);
      d.writeUInt16LE(32, 6);
      d.writeUInt32LE(buf.length, 8);
      d.writeUInt32LE(offset, 12);
      dirs.push(d);
      blobs.push(buf);
      offset += buf.length;
    }
    return Buffer.concat([header, ...dirs, ...blobs]);
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

  function resolveSettings(project) {
    const pub = core.toPublish(JSON.parse(JSON.stringify(project))).publish;
    const title = String(pub.gameName || project.title || '未命名的游戏').trim() || '未命名的游戏';
    const author = String(pub.author || '').trim();
    const version = String(pub.version || '1.0.0').trim() || '1.0.0';
    const copyright = String(pub.copyright || '').trim() ||
      ('Copyright © ' + new Date().getFullYear() + ' ' + (author || title));
    const releaseId = core.releaseIdOf(project);
    return {
      title, author, version, copyright, releaseId,
      icon: pub.icon || null,
      window: pub.window,
      fileBase: safeFileName(title, 'game') + '-' + safeFileName(version, '1.0.0') + '-win-x64'
    };
  }

  function assertProject(project) {
    if (!project || typeof project !== 'object') throw new Error('工程快照为空');
    core.validate(project);
    const report = core.analyze(project);
    const issues = (report.issues || []).filter(i => i.level === 'error');
    if (issues.length) throw new Error('工程还有问题：' + issues.map(i => i.text).join('；'));
    if (!project.nodes.length) throw new Error('还没有剧情节点，无法导出');
    return true;
  }

  function noticeText(s) {
    return [
      '《' + s.title + '》', '',
      '作者：' + (s.author || '未署名'),
      '版本：' + s.version,
      s.copyright, '',
      '本游戏由「纸间 PaperVNStudio」导出，播放器外壳以 MIT 许可证发布，完整文本见本目录 LICENSE。',
      '剧情、图片与音频的权利归作者所有；如果你不是作者，请勿再分发。',
      '发行标识：' + s.releaseId + '（存档目录 %APPDATA%\\PaperVNStudio-Game-' + s.releaseId + '）', ''
    ].join('\r\n');
  }

  function playText(s) {
    return [
      '《' + s.title + '》· 怎么玩', '',
      '双击「' + safeFileName(s.title, 'game') + '.exe」开始。',
      '点击画面或按空格推进；Esc 打开游戏内菜单（保存、读取、设置、返回标题）。',
      '断网也能玩：所有图片与音频都内嵌在游戏内容里，窗口不会发起任何网络请求。', '',
      '存档位置：',
      '  %APPDATA%\\PaperVNStudio-Game-' + s.releaseId,
      '  移动游戏目录、换成单文件便携版，存档都还在原处。', '',
      '发行说明：',
      '  本包未附带代码签名证书时，Windows 可能提示「未知发布者」；',
      '  请用同目录 manifest 里的 SHA-256 校验文件完整性。', ''
    ].join('\r\n');
  }

  /**
   * 构建一个游戏包（异步；重活在子进程里）。
   * @param {object} opts {project,type,outDir,overwrite,onProgress,isCancelled}
   * @param {object} deps {nativeImage}
   */
  async function build(opts, deps) {
    const { nativeImage } = deps;
    const project = opts.project;
    const type = ['portable', 'folder'].includes(opts.type) ? opts.type : 'zip';
    const outDir = path.resolve(String(opts.outDir || ''));
    const cancelled = opts.isCancelled || (() => false);
    const startedAt = Date.now();
    const timings = [];
    const progress = (stage, percent, detail) => {
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({
          stage, label: STAGE_LABELS[stage] || stage,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
          detail: detail || '', elapsedMs: Date.now() - startedAt
        });
      }
    };
    const step = (stage, percent, detail) => {
      progress(stage, percent, detail);
      timings.push({ stage, label: STAGE_LABELS[stage], at: Date.now() - startedAt });
      return () => { timings[timings.length - 1].ms = Date.now() - startedAt; };
    };
    const checkCancel = () => { if (cancelled()) throw new Cancelled(); };

    const tc = toolchain();
    if (!tc.runtime.ok) throw new Error(tc.runtime.note || 'Electron 运行时不可用');
    if (!tc.rcedit.ok) throw new Error('缺少 rcedit 构建组件：' + tc.rcedit.note + '（运行 npm run tools:prepare）');
    if (type === 'portable' && !tc.nsis.ok) throw new Error('缺少 NSIS 构建组件：' + tc.nsis.note + '（运行 npm run tools:prepare）');
    if (!outDir) throw new Error('没有选择导出目录');
    fs.mkdirSync(outDir, { recursive: true });

    const settings = resolveSettings(project);
    const suffix = type === 'zip' ? '-独立试玩包.zip' : (type === 'portable' ? '-单文件便携版.exe' : '-独立游戏');
    const targetFile = path.join(outDir, settings.fileBase + suffix);
    if (fs.existsSync(targetFile) && !opts.overwrite) {
      const err = new Error('目标文件已存在：' + targetFile);
      err.code = 'EEXIST_TARGET';
      err.path = targetFile;
      throw err;
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'papervn-export-'));
    const pkgDir = path.join(work, 'payload');
    let done = step('check', 2);
    try {
      assertProject(project);
      done();

      checkCancel();
      done = step('content', 8);
      const contentDir = path.join(pkgDir, 'content');
      fs.mkdirSync(path.join(contentDir, 'assets', 'images'), { recursive: true });
      fs.mkdirSync(path.join(contentDir, 'assets', 'audio'), { recursive: true });
      let html;
      /* 资源分离：素材逐个落到 content/assets，HTML 只留播放器与剧情数据。
         图片/音频用 papergame://game/assets/... 读取，不再拼成巨型 Base64。 */
      const report = {};
      try {
        /* 先按引用裁剪再落盘：未引用的备用素材不进包，工程里仍然保留。 */
        const C = require(path.join(repoRoot, 'dist', 'core.js'))();
        const keepImg = new Set(C.referencedImageIds(project));
        const keepAudio = new Set(C.referencedAudioIds(project));
        const allImages = project.assets || [];
        const allAudio = project.audioAssets || [];
        const usedImages = allImages.filter(a => keepImg.has(a.id));
        const usedAudio = allAudio.filter(a => keepAudio.has(a.id));

        const external = Object.assign({}, project, { title: settings.title });
        external.assets = usedImages.map(a => Object.assign({}, a, {
          data: writeContentAsset(contentDir, 'assets/images', a.data, opts.projectRoot)
        }));
        external.audioAssets = usedAudio.map(a => Object.assign({}, a, {
          data: writeContentAsset(contentDir, 'assets/audio', a.data, opts.projectRoot)
        }));
        html = buildPlayerHTML(external, undefined, report, { mode: 'external' });

        /* 统计按「素材库 → 实际打包 → 排除」记账，供 manifest 与验收对照。 */
        const bytesOf = list => list.reduce((s, a) => s + encodedBytes(a && a.data), 0);
        report.resources = {
          mode: 'external',
          images: { library: allImages.length, included: usedImages.length, excluded: allImages.length - usedImages.length,
            bytes: { library: bytesOf(allImages), included: bytesOf(usedImages), excluded: bytesOf(allImages) - bytesOf(usedImages) } },
          audio: { library: allAudio.length, included: usedAudio.length, excluded: allAudio.length - usedAudio.length,
            bytes: { library: bytesOf(allAudio), included: bytesOf(usedAudio), excluded: bytesOf(allAudio) - bytesOf(usedAudio) } },
          dataBytes: Buffer.byteLength(html, 'utf8')
        };
      } catch (e) {
        throw new Error('生成播放器内容失败：' + e.message);
      }
      if (!html || !html.length) throw new Error('游戏内容为空');
      /* 64MB 只约束「播放器 + 剧情数据」，素材不再进 HTML，不会因为美术量撞墙。 */
      if (html.length > MAX_CONTENT_BYTES) {
        throw new Error('播放器页面仍然过大（' + mb(html.length) + '），请检查剧情数据是否异常');
      }
      const audioReport = report;

      checkCancel();
      done = step('stage', 14);
      fs.writeFileSync(path.join(contentDir, 'index.html'), html, 'utf8');
      fs.writeFileSync(path.join(contentDir, 'game.json'), JSON.stringify({
        title: settings.title,
        appId: 'cn.papervnstudio.game.' + settings.releaseId,
        releaseId: settings.releaseId,
        window: settings.window,
        format: 'papervn-game-folder',
        formatVersion: 1
      }, null, 2) + '\n', 'utf8');
      fs.copyFileSync(path.join(repoRoot, 'desktop', 'game-shell', 'main.cjs'), path.join(pkgDir, 'main.cjs'));
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: 'papervn-game-' + settings.releaseId,
        productName: settings.title,
        version: numericVersion(settings.version).split('.').slice(0, 3).join('.'),
        description: settings.title + ' · 纸间导出的独立游戏',
        author: settings.author || settings.title,
        license: 'MIT',
        main: 'main.cjs'
      }, null, 2) + '\n', 'utf8');
      const licenseSrc = path.join(repoRoot, 'LICENSE');
      if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(pkgDir, 'LICENSE'));
      fs.writeFileSync(path.join(pkgDir, 'NOTICE-作者与许可.txt'), noticeText(settings), 'utf8');
      fs.writeFileSync(path.join(pkgDir, '试玩说明.txt'), playText(settings), 'utf8');
      done();

      checkCancel();
      done = step('icon', 20);
      const icon = buildIco(nativeImage, settings.icon && settings.icon.data, work);
      done('图标 ' + icon.sizes.length + ' 档 · ' + (icon.source === 'default' ? '默认' : '自定义'));

      checkCancel();
      progress('runtime', 22, '启动构建进程');
      const job = {
        workDir: work, pkgDir, runtimeSrc: tc.runtime.dir,
        iconPath: icon.path, exeName: safeFileName(settings.title, 'game') + '.exe',
        settings: {
          title: settings.title, author: settings.author, version: settings.version,
          copyright: settings.copyright, releaseId: settings.releaseId, fileBase: settings.fileBase
        },
        type, outPath: targetFile, startedAt,
        toolchain: { rcedit: tc.rcedit.path, nsis: tc.nsis.path }
      };
      const jobFile = path.join(work, 'job.json');
      fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');
      const workerResult = await runWorker(jobFile, { cancelled, progress });
      timings.push(...(workerResult.stages || []));

      const bytes = workerResult.bytes;
      const manifest = {
        format: 'papervn-game-package',
        formatVersion: 4,
        /* 产物形态：folder（目录）/ zip / portable，资源都是分离存放的。 */
        exportMode: type,
        game: {
          title: settings.title, author: settings.author || '', version: settings.version,
          copyright: settings.copyright, releaseId: settings.releaseId,
          projectId: project.id, nodes: project.nodes.length,
          images: project.assets.length, audio: (project.audioAssets || []).length,
          window: settings.window
        },
        /* 作者填的版本原值写在 game.version；EXE 版本资源里实际写入的四段数字单独记一份，
           两者不一致时各自为准（例如 0.7.2-test → 0.7.2.0）。 */
        exeVersion: numericVersion(settings.version),
        platform: 'win32-x64',
        type,
        entry: { exe: job.exeName, relativeTo: settings.fileBase },
        artifact: { file: path.basename(workerResult.artifact), bytes, sizeLabel: mb(bytes),
          sha256: workerResult.sha256 || null, kind: type === 'folder' ? 'directory' : 'file' },
        /* 导出报告：哪些 BGM 进了包、哪些留在工程素材库。 */
        audio: audioReport.audio || null,
        signature: workerResult.signature,
        icon: { source: icon.source, sizes: icon.sizes, bytes: fs.statSync(icon.path).size },
        toolchain: {
          electron: tc.runtime.version,
          rcedit: tc.rcedit.version || 'bundled',
          nsis: type === 'portable' ? (tc.nsis.version || 'bundled') : null
        },
        stages: timings,
        builtAt: new Date().toISOString(),
        builtOn: os.platform() + '-' + os.arch()
      };
      /* 目录版没有扩展名可替换，清单放在同级目录旁。 */
      const manifestPath = type === 'folder'
        ? path.join(path.dirname(workerResult.artifact), path.basename(workerResult.artifact) + '.manifest.json')
        : workerResult.artifact.replace(/\.(zip|exe)$/i, '.manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      progress('done', 100, '完成');
      return {
        ok: true, type, artifact: workerResult.artifact, manifestPath, exeName: job.exeName,
        bytes, sha256: workerResult.sha256, stages: timings,
        signature: workerResult.signature, icon: manifest.icon, toolchain: manifest.toolchain
      };
    } finally {
      /* 临时目录可能有几百 MB、上万个文件：异步删除，不阻塞返回（否则取消要等十几秒才回到界面）。 */
      cleanupAsync(work);
    }
  }

  /* 子进程负责复制运行时、rcedit、ZIP/NSIS：主进程保持响应，取消能立刻生效。 */
  function runWorker(jobFile, { cancelled, progress }) {
    return new Promise((resolve, reject) => {
      /* 打包后 asar 里的 .cjs 不能作为 Node 入口运行：worker 必须放在 asar 外，
       * 通过 extraResources 复制到 resources/worker。开发时用仓库里的文件。 */
      const candidates = [];
      if (resourcesPath) candidates.push(path.join(resourcesPath, 'worker', 'game-pack-worker.cjs'));
      candidates.push(path.join(repoRoot, 'desktop', 'game-pack-worker.cjs'));
      const worker = candidates.find(p => fs.existsSync(p));
      if (!worker) { reject(new Error('缺少构建进程：resources/worker/game-pack-worker.cjs')); return; }
      const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
      const child = spawn(process.execPath, [worker, jobFile], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      let result = null;
      let killed = false;
      const timer = setInterval(() => {
        if (cancelled() && !killed) {
          killed = true;
          try { child.kill(); } catch { /* ignore */ }
          killTree(child.pid);
        }
      }, 200);
      child.stdout.on('data', chunk => {
        out += chunk.toString('utf8');
        let idx;
        while ((idx = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, idx).trim();
          out = out.slice(idx + 1);
          if (line.startsWith('PROGRESS ')) {
            try {
              const p = JSON.parse(line.slice(9));
              progress(p.stage, p.percent, p.detail || '');
            } catch { /* 忽略坏行 */ }
          } else if (line.startsWith('RESULT ')) {
            try { result = JSON.parse(line.slice(7)); } catch { /* 交给退出码 */ }
          }
        }
        if (out.length > 1024 * 1024) out = out.slice(-4096);
      });
      child.stderr.on('data', chunk => { err = (err + chunk.toString('utf8')).slice(-4000); });
      child.on('error', e => { clearInterval(timer); reject(new Error('构建进程启动失败：' + e.message)); });
      child.on('exit', code => {
        clearInterval(timer);
        if (killed || cancelled()) { reject(new Cancelled()); return; }
        if (result && result.ok) { resolve(result); return; }
        if (result && result.message) { reject(new Error(result.message)); return; }
        reject(new Error('构建进程异常退出（' + code + '）：' + (err.trim() || '没有更多信息')));
      });
    });
  }

  /* 子进程被杀后文件句柄可能还没释放：异步重试删除，不阻塞调用方。 */
  function cleanupAsync(dir) {
    let attempts = 0;
    const run = () => {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {
        attempts += 1;
        if (attempts < 5) setTimeout(run, 800);
      });
    };
    run();
  }

  function killTree(pid) {
    if (!pid) return;
    try {
      const { spawnSync } = require('node:child_process');
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  return { toolchain, build, safeFileName, numericVersion, readPeSignature, resolveSettings };
}

module.exports = createGameBuilder;
module.exports.STAGE_LABELS = STAGE_LABELS;
