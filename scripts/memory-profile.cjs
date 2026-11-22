'use strict';
/*
 * V0.7.6-M3 内存与性能报告生成器。
 *
 * 采集由 m3-acceptance.cjs 在真实 Electron 窗口验收全程完成，原始样本写到
 * release/m3-memory-samples.json。本脚本只做汇总：按阶段计算主进程、渲染进程、
 * 所有 Electron 进程总内存的峰值，并明确区分「实测 / 推测 / 未测量」。
 *
 * 用法：node scripts/memory-profile.cjs [samples.json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.resolve(process.argv[2] || path.join(ROOT, 'release', 'm3-memory-samples.json'));
const OUT = path.join(ROOT, 'release', 'memory-profile.json');

const data = JSON.parse(fs.readFileSync(SAMPLES, 'utf8'));
const samples = Array.isArray(data.samples) ? data.samples : [];
const stages = data.stages || {};
const machine = data.machine || {};

const byStage = {};
for (const s of samples) {
  const k = s.stage || 'unlabelled';
  const b = byStage[k] || (byStage[k] = { count: 0, cdpCount: 0, osCount: 0,
    mainPeak: 0, rendererPeak: 0, totalPeak: 0,
    mainMin: Infinity, rendererMin: Infinity, totalMin: Infinity, firstAt: s.at, lastAt: s.at });
  b.count++;
  if (s.source === 'cdp') {
    /* 只有 CDP 样本带主/渲染进程分项；OS 样本的 0 不能混进最小值。 */
    b.cdpCount++;
    b.mainPeak = Math.max(b.mainPeak, s.mainBytes || 0);
    b.rendererPeak = Math.max(b.rendererPeak, s.rendererBytes || 0);
    b.mainMin = Math.min(b.mainMin, s.mainBytes || 0);
    b.rendererMin = Math.min(b.rendererMin, s.rendererBytes || 0);
  } else b.osCount++;
  b.totalPeak = Math.max(b.totalPeak, s.totalBytes || 0);
  b.totalMin = Math.min(b.totalMin, s.totalBytes || 0);
  b.lastAt = s.at;
}
for (const b of Object.values(byStage)) {
  for (const k of ['mainMin', 'rendererMin', 'totalMin']) if (!Number.isFinite(b[k])) b[k] = null;
}
const peak = key => samples.reduce((m, s) => Math.max(m, s[key] || 0), 0);

const timing = {};
for (const [name, st] of Object.entries(stages)) {
  timing[name] = {
    measured: Number.isFinite(st.ms),
    ms: Number.isFinite(st.ms) ? st.ms : null,
    startedAt: st.startedAt || null, finishedAt: st.finishedAt || null,
    ok: st.ok === undefined ? null : st.ok
  };
}
const unmeasured = [
  '单文件 HTML 导出的渲染进程堆峰值（1 GiB 工程按设计走目录版，未执行该导出）',
  '第二台机器 / 不同 GPU 上的内存基线（本机单台实测）',
  'GPU 进程显存占用（app.getAppMetrics 只报告工作集，不含显存）'
];
const report = {
  schema: 1,
  version: '0.7.6-M3',
  generatedAt: new Date().toISOString(),
  source: path.relative(ROOT, SAMPLES),
  method: {
    sampling: 'CDP 定时器每 400ms 调用 app.getAppMetrics()；另用 tasklist 每 600ms 独立采样所有 electron.exe 进程工作集，避免主进程被同步 IO 阻塞时漏掉峰值',
    main: 'app.getAppMetrics() 中 type=Browser 的 workingSetSize 实测（原始单位 KB，已 ×1024 换算为字节）',
    renderer: 'app.getAppMetrics() 中 type=Tab 的 workingSetSize 实测；Electron 把渲染进程标为 Tab 而不是 Renderer',
    total: 'app.getAppMetrics() 所有进程 workingSetSize 之和；tasklist 采样的字节数作为独立对照',
    continuous: true,
    sampleCount: samples.length,
    cdpSampleCount: samples.filter(s => s.source === 'cdp').length,
    osSampleCount: samples.filter(s => s.source === 'tasklist').length
  },
  machine: {
    measured: true, platform: machine.platform || os.platform(), arch: machine.arch || os.arch(),
    cpuModel: machine.cpuModel || os.cpus()[0].model, cpus: machine.cpus || os.cpus().length,
    totalMemBytes: machine.totalMem || os.totalmem(), freeMemBytesAtStart: machine.freeMem || null,
    node: machine.node || process.version, electron: machine.electron || null,
    note: '来自验收进程启动时读取的 os 信息与 Electron 包版本'
  },
  measured: {
    mainPeakBytes: peak('mainBytes'),
    rendererPeakBytes: peak('rendererBytes'),
    allElectronProcessesPeakBytes: peak('totalBytes'),
    maxSingleProcessPeakWorkingSetBytes: peak('peakWorkingSetBytes'),
    byStage,
    timingsMs: timing
  },
  timingsMs: {
    importMs: timing.import && timing.import.ms,
    openProjectMs: timing.openProject && timing.openProject.ms,
    saveMs: timing.save && timing.save.ms,
    reopenMs: timing.reopen && timing.reopen.ms,
    previewStartMs: timing.preview && timing.preview.ms,
    folderExportMs: timing.folderExport && timing.folderExport.ms
  },
  sizes: data.sizes || {},
  assertions: data.assertions || {},
  incidents: data.incidents || [],
  unmeasured,
  notMeasured: unmeasured,
  estimated: [],
  note: '所有数值均来自实际采样；没有根据素材体积推算内存。若某阶段采样点不足，byStage 中该阶段 count 会如实反映。'
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  out: path.relative(ROOT, OUT), samples: samples.length,
  mainPeakMB: +(report.measured.mainPeakBytes / 1048576).toFixed(1),
  rendererPeakMB: +(report.measured.rendererPeakBytes / 1048576).toFixed(1),
  totalPeakMB: +(report.measured.allElectronProcessesPeakBytes / 1048576).toFixed(1),
  stages: Object.keys(byStage)
}, null, 2));
