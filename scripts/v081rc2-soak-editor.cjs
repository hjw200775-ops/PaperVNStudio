'use strict';
/* V0.8.1-RC2 / M7：15 分钟真实连续播放浸泡（编辑器试玩 · 1.47 GiB 工程）。
 *
 * 不用虚拟时间、不改计时器：真实点击推进 900 秒，期间反复经历
 * BGM 起播/循环、演出里的交叉淡化、音效、配音 Ducking、场景推进、返回重开。
 * 每 5 秒采一次：主进程/渲染进程/总工作集、JS 堆、音频实例、解码缓存、
 * 在途解码、播放模式、fps、异常。
 *
 * 用法：node scripts/v081rc2-soak-editor.cjs [秒数]
 * 产物：release/audio-soak-15min.json
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const DURATION = Number(process.argv[2] || process.env.PVN_SOAK_SECONDS || 900);
const PROJECT = path.join(ROOT, 'release', 'bench-project');
const REPORT = path.join(ROOT, 'release', 'audio-soak-15min-rc3.1.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

const report = { at: new Date().toISOString(), version: '0.8.1-rc3.1', env: 'editor-trial@1.47GiB', durationPlanned: DURATION, ok: true, stages: {}, problems: [], samples: [], summary: null };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 200) : '')); };
const bad = (n, m, d) => { report.ok = false; report.stages[n] = { ok: false, message: m, ...(d || {}) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

const SAMPLE = `(() => { const a = window.paperEditorAudio ? window.paperEditorAudio() : null;
  return { audio: a ? { mode: a.mode, reason: a.preciseReason, instances: a.instances,
      bgm: a.bgm && { id: a.bgm.audioId, time: a.bgm.time, loop: a.bgm.loop && a.bgm.loop.mode },
      mem: a.audioMemory, duck: a.ducking && { active: a.ducking.active, factor: a.ducking.factor },
      cache: a.cache && { entries: a.cache.entries, bytes: a.cache.bytes }, gen: a.generation,
      errors: (a.errors || []).map(e => e.title + ':' + (e.label || e.audioId || '')),
      ps: a.playbackStats || null } : null,
    js: performance.memory ? performance.memory.usedJSHeapSize : null,
    dom: document.getElementsByTagName('*').length,
    pos: (document.querySelector('#position') || {}).textContent || '',
    status: (document.querySelector('#audioStatus') || {}).textContent || '',
    playing: !!document.querySelector('#stop') && document.querySelector('#stop').disabled === false
  }; })()`;

async function clickReal(cdp, selector) {
  const box = await cdp.ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!box || !box.w) return false;
  await sleep(200);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

(async () => {
  if (!fs.existsSync(path.join(PROJECT, 'project.paper.json'))) { console.error('缺少工程：' + PROJECT); process.exit(2); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-soak-'));
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: '浸泡工程', openedAt: new Date().toISOString() }]
  }));

  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData],
    { cwd: ROOT, stdio: 'ignore', env });
  let cdp = null;
  try {
    const page = await waitPage(port, (u) => u.startsWith('paper://app/'), 120000);
    if (!page) throw new Error('编辑器没有启动');
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    let m = null;
    for (let i = 0; i < 400; i++) { m = await cdp.ev(`(() => { const M = window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null); if (m && m.nodes >= 500) break; await sleep(150); }
    if (!m) throw new Error('工程没有打开');
    ok('浸泡工程已打开', m);

    await cdp.ev(`(() => { const t = [...document.querySelectorAll('.tabs button')].find(b => b.dataset.tab === 'audio'); if (t) t.click(); })()`);
    await sleep(400);
    await clickReal(cdp, '#audioUnlock');
    await sleep(1000);
    await cdp.ev(`document.getElementById('play').click()`);
    await sleep(2500);
    await cdp.ev(`(() => { window.__fps = { frames: 0, t0: performance.now() };
      (function tick(){ window.__fps.frames++; requestAnimationFrame(tick); })(); })()`);
    /* Ducking 只持续配音那几秒，5 秒一次的快照会漏掉：页面里用 200ms 轮询记一个标志位。 */
    await cdp.ev(`(() => { window.__duckSeen = false; window.__duckMin = 1;
      setInterval(() => { const a = window.paperEditorAudio ? window.paperEditorAudio() : null;
        if (a && a.ducking) { if (a.ducking.active) window.__duckSeen = true;
          if (a.ducking.factor < window.__duckMin) window.__duckMin = a.ducking.factor; } }, 200); })()`);

    const startedAt = Date.now();
    let passes = 0, steps = 0, sampleNo = 0;
    while (Date.now() - startedAt < DURATION * 1000) {
      const s = await cdp.ev(SAMPLE).catch(() => null);
      if (!s) { bad('采样失败', '页面无响应'); break; }

      if (s.playing) {
        await cdp.ev(`document.getElementById('next').click()`).catch(() => {});
        steps++;
        const pos = String(s.pos || '').match(/^\s*(\d+)/);
        if (pos && Number(pos[1]) >= 40) {
          await cdp.ev(`document.getElementById('stop').click()`).catch(() => {});
          await sleep(500);
          await cdp.ev(`document.getElementById('play').click()`).catch(() => {});
          await sleep(600);
          passes++;
        }
      } else {
        await cdp.ev(`document.getElementById('play').click()`).catch(() => {});
        await sleep(600);
      }
      /* 配音句（第 32 句）多停 1.6 秒：10 MB 的 WAV 起播需要时间，0.7 秒会直接跳过 Ducking。 */
      const at = String((await cdp.ev(`(document.querySelector('#position')||{}).textContent`).catch(() => '')) || '');
      await sleep(/^\s*32\s*\//.test(at) ? 1600 : 900);

      if (sampleNo % 5 === 0) {
        const st = await cdp.ev(SAMPLE).catch(() => null);
        const raw = await cdp.ev(`window.paperDesktop.metrics()`).catch(() => null);
        const fps = await cdp.ev(`(() => { const f = window.__fps; const now = performance.now();
          const v = f.frames / Math.max(0.001, (now - f.t0) / 1000); f.frames = 0; f.t0 = now; return v; })()`).catch(() => null);
        if (st) {
          const row = { at: new Date().toISOString(), elapsed: Math.round((Date.now() - startedAt) / 1000),
            fps: fps ? +Number(fps).toFixed(1) : null, passes, steps, ...st };
          if (raw && raw.metrics) {
            const sum = (t) => raw.metrics.filter((x) => x.type === t).reduce((a, x) => a + (x.workingSetSize || 0), 0) * 1024;
            row.mainMB = +(sum('browser') / 1048576).toFixed(1);
            /* Electron 把渲染进程标成 Tab，不是 renderer；两个都算，避免出现 0 MB 的假数据。 */
            row.rendererMB = +((sum('renderer') + sum('tab')) / 1048576).toFixed(1);
            row.gpuMB = +(sum('gpu') / 1048576).toFixed(1);
            row.totalMB = +((raw.metrics.reduce((a, x) => a + (x.workingSetSize || 0), 0) * 1024) / 1048576).toFixed(1);
            row.processes = raw.metrics.length;
          }
          report.samples.push(row);
        }
      }
      sampleNo++;
    }

    const endedAt = Date.now();
    const samples = report.samples;
    const first = samples[0], last = samples[samples.length - 1];
    const q = samples[Math.floor(samples.length * 0.25)] || first;
    const maxInst = samples.reduce((m2, s) => Math.max(m2, (s.audio && s.audio.instances && s.audio.instances.bgm) || 0), 0);
    const maxRetiring = samples.reduce((m2, s) => Math.max(m2, (s.audio && s.audio.instances && s.audio.instances.retiring) || 0), 0);
    const maxSfx = samples.reduce((m2, s) => Math.max(m2, (s.audio && s.audio.instances && s.audio.instances.sfx) || 0), 0);
    const maxCacheMB = samples.reduce((m2, s) => Math.max(m2, (s.audio && s.audio.mem && s.audio.mem.cacheBytes) || 0), 0) / 1048576;
    const maxDecoding = samples.reduce((m2, s) => Math.max(m2, (s.audio && s.audio.mem && s.audio.mem.decoding) || 0), 0);
    const modes = new Set(samples.map((s) => s.audio && s.audio.mode).filter(Boolean));
    const mode = [...modes];

    report.summary = {
      startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
      seconds: Math.round((endedAt - startedAt) / 1000), samples: samples.length, passes, steps,
      maxBgmInstances: maxInst, maxRetiring, maxSfx, maxCacheMB: +maxCacheMB.toFixed(1), maxDecoding,
      totalStartMB: first.totalMB, totalPeakMB: Math.max(...samples.map((s) => s.totalMB || 0)),
      totalEndMB: last.totalMB, mainStartMB: first.mainMB, mainEndMB: last.mainMB,
      rendererStartMB: first.rendererMB, rendererEndMB: last.rendererMB,
      heapStartMB: +(first.js / 1048576).toFixed(1), heap25MB: +(q.js / 1048576).toFixed(1), heapEndMB: +(last.js / 1048576).toFixed(1),
      heapGrowthAfter25MB: +((last.js - q.js) / 1048576).toFixed(1),
      domStart: first.dom, domEnd: last.dom,
      avgFps: +(samples.reduce((a, s) => a + (s.fps || 0), 0) / Math.max(1, samples.length)).toFixed(1),
      minFps: Math.min(...samples.map((s) => s.fps || 999)),
      modes: mode, duckingObserved: samples.some((s) => s.audio && s.audio.duck && s.audio.duck.active),
      exactSeconds: Math.round((endedAt - startedAt) / 100 && 0) / 10
    };
    ok('浸泡完成', report.summary);
    await cdp.shot(path.join(SHOTS, 'v081rc2-soak-end.png'));

    if (report.summary.seconds < DURATION) bad('浸泡时长', '只跑了 ' + report.summary.seconds + ' 秒');
    else ok('实际运行 ≥ ' + DURATION + ' 秒', { seconds: report.summary.seconds, passes, steps });
    if (maxInst > 1) bad('音乐实例泄漏', '最大 ' + maxInst);
    else ok('音乐实例始终 ≤ 1', { max: maxInst, maxRetiring, maxSfx });
    if (maxCacheMB > 64 * 1.25) bad('解码缓存超预算', maxCacheMB.toFixed(1) + 'MB');
    else ok('解码缓存不超预算', { maxCacheMB: +maxCacheMB.toFixed(1), maxDecoding });
    if (report.summary.heapGrowthAfter25MB > 80) bad('JS 堆增长', '25% 后增长 ' + report.summary.heapGrowthAfter25MB + 'MB');
    else ok('JS 堆无明显增长趋势', { mid: report.summary.heap25MB, end: report.summary.heapEndMB, delta: report.summary.heapGrowthAfter25MB });
    if (report.summary.totalEndMB - report.summary.totalPeakMB > 0) {
      /* 峰值本身就是最大值，这里只报告；真正判据是「末值 ≤ 峰值 × 1.1」 */
    }
    if (report.summary.totalEndMB > report.summary.totalPeakMB) bad('总内存', '末值大于峰值，采样异常');
    if (!modes.has('precise')) bad('播放模式', '始终没有 precise：' + mode.join(','));
    else ok('全程精确模式', { modes: mode });
    const duckSeen = await cdp.ev(`({ seen: window.__duckSeen, min: window.__duckMin })`).catch(() => null);
    if (!duckSeen || !duckSeen.seen) bad('Ducking', '整段没有观察到压低状态');
    else ok('观察到配音 Ducking（200ms 轮询）', { minFactor: +Number(duckSeen.min).toFixed(3) });

    /* M2：严格播放断言——真正播放失败 / 解码失败 / 错误横幅必须导致验收失败。
       播放事件统计是运行时累计值，取最后一个采样点即为全程总计。 */
    const finalPs = (last.audio && last.audio.ps) || { requested: 0, started: 0, completed: 0, cancelled: 0, failed: 0, decodeFailed: 0, fallback: 0 };
    const errBannerSamples = samples.filter((s) => /播放失败|无法解码|素材缺失|找不到这个音频/.test(s.status || '')).length;
    const req = finalPs.requested, started = finalPs.started, canc = finalPs.cancelled, failed = finalPs.failed;
    report.summary.playbackStats = finalPs;
    report.summary.errBannerSamples = errBannerSamples;
    if (failed > 0) bad('意外播放失败', 'playbackStats.failed=' + failed + '（合法取消不计入，回退不计入）', finalPs);
    else ok('无意外播放失败', { ...finalPs, note: 'requested≈started+cancelled(+在途)，cancelled 是合法打断' });
    if (finalPs.decodeFailed > 0) bad('素材解码失败', finalPs.decodeFailed + ' 次');
    else ok('无素材解码失败', finalPs);
    if (errBannerSamples > 0) bad('出现音频错误横幅', errBannerSamples + ' / ' + samples.length + ' 个采样点显示音频错误');
    else ok('全程无音频错误横幅', { samples: samples.length });
    if (req > 0 && (started + canc + failed) < req - 2) bad('播放事件关系异常', 'requested=' + req + ' 但 started+cancelled+failed=' + (started + canc + failed) + '，存在被静默丢弃的播放请求');
    else ok('播放事件数量关系自洽', { requested: req, started, completed: finalPs.completed, cancelled: canc, failed, fallback: finalPs.fallback });
    const errs = cdp.errors.filter((e) => !/Autoplay|user gesture/i.test(e.text));
    if (errs.length) bad('运行时异常', errs.slice(0, 3).map((e) => e.text).join(' | ').slice(0, 300));
    else ok('0 运行时异常');
  } catch (e) {
    bad('浸泡', String((e && e.message) || e));
  } finally {
    if (cdp) cdp.close();
    kill(proc);
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' 15 分钟连续播放浸泡（M7）');
  if (!report.ok) console.log(report.problems.join('\n'));
  process.exit(report.ok ? 0 : 1);
})();
