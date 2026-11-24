'use strict';
/* V0.8.1-RC2 / M6：1.47 GiB 大型工程真实窗口音频回归。
 *
 * 覆盖：打开 → 采样内存 → 音频演出面板真加一条动作 → 撤销/重做 → 保存 →
 *       关闭重开（动作仍在）→ 完整预览（pvres://）播放并测首播延迟 →
 *       导出目录版 → 启动导出游戏验证音频。
 *
 * 判定看真实数值：打开耗时、JS 堆/工作集、audioMemory 缓存、首播延迟、
 * 播放模式与 BGM 时间推进；不看「产物里有没有 audio.js」。
 *
 * 用法：node scripts/v081rc2-large-audio.cjs
 * 产物：release/large-project-audio-acceptance.json
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, ELECTRON, sleep, freePort, waitPage, httpJson, connect, kill } = require('./rc2-cdp.cjs');

const PROJECT = path.join(ROOT, 'release', 'bench-project');
const OUT = path.join(ROOT, 'release', 'v081rc2', 'large', 'game');
const REPORT = path.join(ROOT, 'release', 'large-project-audio-acceptance.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

const report = { at: new Date().toISOString(), version: '0.8.1-rc2', project: PROJECT, ok: true, stages: {}, problems: [], memory: [], artifact: null };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 240) : '')); };
const bad = (n, m, d) => { report.ok = false; report.stages[n] = { ok: false, message: m, ...(d || {}) }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

function projectMeta() {
  const p = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));
  let bytes = 0;
  for (const a of p.assets || []) bytes += a.bytes || 0;
  return { nodes: p.nodes.length, assets: p.assets.length, audio: (p.audioAssets || []).length, assetMB: Math.round(bytes / 1048576) };
}

async function launchEditor(port, userData) {
  const env = Object.assign({}, process.env, { PAPER_VN_TEST_EXPORT_DIR: OUT });
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData],
    { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, (u) => u.startsWith('paper://app/'), 120000);
  if (!page) { kill(proc); throw new Error('编辑器窗口未出现'); }
  return { proc, port, cdp: await connect(page.webSocketDebuggerUrl) };
}

async function sampleMemory(cdp, tag) {
  const raw = await cdp.ev(`window.paperDesktop.metrics()`).catch(() => null);
  const js = await cdp.ev(`(performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null)`).catch(() => null);
  if (!raw || !raw.metrics) return null;
  const total = raw.metrics.reduce((s, m) => s + (m.workingSetSize || 0), 0) * 1024;
  const renderer = raw.metrics.filter((m) => m.type === 'renderer').reduce((s, m) => s + (m.workingSetSize || 0), 0) * 1024;
  const main = raw.metrics.filter((m) => m.type === 'browser').reduce((s, m) => s + (m.workingSetSize || 0), 0) * 1024;
  const row = { tag, at: new Date().toISOString(), totalMB: +(total / 1048576).toFixed(1), rendererMB: +(renderer / 1048576).toFixed(1),
    mainMB: +(main / 1048576).toFixed(1), jsHeapMB: js ? +(js.used / 1048576).toFixed(1) : null, processes: raw.metrics.length };
  report.memory.push(row);
  return row;
}

const PREVIEW_STATE = `(() => { const s = window.paperGameState(); return {
  i: s.i, state: s.state, origin: location.origin,
  perf: s.audioPerf && { mode: s.audioPerf.mode, reason: s.audioPerf.preciseReason,
    bgm: s.audioPerf.bgm && { id: s.audioPerf.bgm.audioId, time: s.audioPerf.bgm.time, loop: s.audioPerf.bgm.loop },
    instances: s.audioPerf.instances, mem: s.audioPerf.audioMemory,
    events: (s.audioPerf.events || []).slice(0, 4) }
}; })()`;

(async () => {
  if (!fs.existsSync(path.join(PROJECT, 'project.paper.json'))) { console.error('缺少大型工程：' + PROJECT); process.exit(2); }
  const meta = projectMeta();
  report.projectMeta = meta;
  ok('大型工程就绪（未去重素材 ≥ 1 GiB）', meta);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-large-'));
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: '大型工程音频验收', openedAt: new Date().toISOString() }]
  }));

  const t0 = Date.now();
  let ed = await launchEditor(await freePort(), userData);
  let cdp = ed.cdp;
  try {
    let metrics = null;
    for (let i = 0; i < 400; i++) {
      metrics = await cdp.ev(`(() => { const M = window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null);
      if (metrics && metrics.nodes >= meta.nodes) break;
      await sleep(150);
    }
    const openMs = Date.now() - t0;
    if (!metrics || metrics.nodes < meta.nodes) throw new Error('工程没有在 60 秒内打开：' + JSON.stringify(metrics));
    ok('打开大型工程', { openMs, nodes: metrics.nodes, assets: metrics.assets, audio: metrics.audio });
    report.openMs = openMs;
    const memOpen = await sampleMemory(cdp, '打开后');
    ok('打开后内存', memOpen);

    /* ---- 音频演出面板：真加一条动作（104 个音频素材的下拉不会卡） ---- */
    const added = await cdp.ev(`(() => {
      const nodes = [...document.querySelectorAll('#list .node')];
      if (nodes.length < 5) return { error: '节点太少：' + nodes.length };
      nodes[3].click();
      const before = (document.getElementById('perfList') || {}).children ? document.getElementById('perfList').children.length : -1;
      const btn = [...document.querySelectorAll('#perfPresets [data-preset-kind="audio"]')][0];
      if (!btn) return { error: '没有音频预设按钮', before };
      btn.click();
      const after = document.getElementById('perfList').children.length;
      const opts = document.querySelectorAll('#perfParams [data-param="audioId"] option').length;
      return { before, after, preset: btn.textContent.trim(), audioOptions: opts,
        count: (document.getElementById('perfCount') || {}).textContent || '' };
    })()`);
    if (added.error || !(added.after > added.before)) bad('音频演出动作添加', JSON.stringify(added));
    else ok('在 1.47 GiB 工程里添加音频动作', added);
    await cdp.shot(path.join(SHOTS, 'v081rc2-large-perf-panel.png'));

    /* ---- 撤销 / 重做 ---- */
    const hist = await cdp.ev(`(() => { const n = () => document.getElementById('perfList').children.length;
      const a = n(); document.getElementById('undo').click(); const b = n();
      document.getElementById('redo').click(); const c = n(); return { added: a, afterUndo: b, afterRedo: c }; })()`);
    if (!(hist.afterUndo === hist.added - 1 && hist.afterRedo === hist.added)) bad('撤销/重做', JSON.stringify(hist));
    else ok('撤销 / 重做音频动作', hist);

    /* ---- 保存 → 关闭 → 重开：动作仍在 ---- */
    await cdp.ev(`document.getElementById('save').click()`);
    await sleep(2500);
    const saved = await cdp.ev(`(document.getElementById('saved') || {}).textContent || ''`);
    ok('保存工程', { saved: String(saved).slice(0, 40) });
    const onDisk = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));
    const audioActs = (onDisk.nodes[3].performance && onDisk.nodes[3].performance.actions || []).filter((a) => String(a.type).indexOf('audio.') === 0);
    if (!audioActs.length) bad('保存后落盘', '磁盘上的第 4 句没有音频动作');
    else ok('音频动作写入工程', { type: audioActs[0].type, audioId: audioActs[0].params && audioActs[0].params.audioId });

    cdp.close(); kill(ed.proc);
    await sleep(1200);

    /* 重开：同一 user-data，确认动作随工程回来 */
    const ed2 = await launchEditor(await freePort(), userData);
    ed = ed2; cdp = ed2.cdp;
    let m2 = null;
    for (let i = 0; i < 400; i++) {
      m2 = await cdp.ev(`(() => { const M = window.__pvnM3; return M ? M.metrics() : null; })()`).catch(() => null);
      if (m2 && m2.nodes >= meta.nodes) break;
      await sleep(150);
    }
    await sleep(1500);
    const reopened = await cdp.ev(`(() => { const nodes = [...document.querySelectorAll('#list .node')];
      if (nodes.length < 4) return { error: '节点太少' };
      nodes[3].click();
      const items = [...document.querySelectorAll('#perfList .perf-item, #perfList li, #perfList > *')];
      return { count: (document.getElementById('perfCount') || {}).textContent || '', items: items.length,
        text: (document.getElementById('perfList') || {}).textContent.slice(0, 80) }; })()`);
    if (!/音频|BGM|音乐/.test(String(reopened.text))) bad('重开后音频动作', JSON.stringify(reopened));
    else ok('关闭重开后音频动作仍在', reopened);

    /* ---- 完整预览：pvres:// 环境下播放并测首播延迟 ---- */
    const tClick = Date.now();
    await cdp.ev(`document.getElementById('fullPreview').click()`);
    let prevPage = null;
    for (let i = 0; i < 120; i++) {
      const list = await httpJson('http://127.0.0.1:' + ed.port + '/json/list').catch(() => []);
      prevPage = (Array.isArray(list) ? list : []).find((x) => x.type === 'page' && /^pvres:\/\//.test(x.url || ''));
      if (prevPage) break;
      await sleep(250);
    }
    if (!prevPage) {
      bad('完整预览窗口', '没有找到 pvres:// 预览窗口');
    } else {
      const pc = await connect(prevPage.webSocketDebuggerUrl);
      await pc.send('Runtime.enable');
      /* 预览窗口先出标题页，BGM 要等解码完才切到 precise：等到模式确定再判定，
         否则会把「还在解码」误判成「回退流式」。 */
      let ps = null;
      for (let i = 0; i < 200; i++) {
        ps = await pc.ev(PREVIEW_STATE).catch(() => null);
        if (ps && ps.perf && ps.perf.mode === 'precise') break;
        await sleep(150);
      }
      if (!ps || !ps.perf) { for (let i = 0; i < 100; i++) { ps = await pc.ev(PREVIEW_STATE).catch(() => null); if (ps && ps.perf) break; await sleep(150); } }
      const previewOpenMs = Date.now() - tClick;
      if (!ps || !ps.perf) bad('完整预览音频', '预览窗口没有音频状态');
      else {
        ok('完整预览窗口（pvres://）', { openMs: previewOpenMs, origin: ps.origin, mode: ps.perf.mode, bgm: ps.perf.bgm, mem: ps.perf.mem });
        if (ps.perf.mode !== 'precise') bad('预览精确模式', '实际 ' + ps.perf.mode + ' / ' + ps.perf.reason);
        const tSeek = Date.now();
        let firstAudioMs = null;
        for (let i = 0; i < 14; i++) {
          const st = await pc.ev(PREVIEW_STATE).catch(() => null);
          if (st && st.i >= 3) break;
          await pc.ev(`document.getElementById('scene').click()`).catch(() => {});
          await sleep(400);
        }
        for (let i = 0; i < 60; i++) {
          const st = await pc.ev(PREVIEW_STATE).catch(() => null);
          if (st && st.perf && st.perf.bgm && st.perf.bgm.time > 0.05) { firstAudioMs = Date.now() - tSeek; break; }
          await sleep(100);
        }
        if (firstAudioMs == null) bad('预览首播延迟', '进入音频句后 6 秒内没有播放');
        else {
          const st = await pc.ev(PREVIEW_STATE);
          ok('预览中音频动作起播', { firstAudioMs, bgm: st.perf.bgm, instances: st.perf.instances });
        }
        const memPrev = await pc.ev(`(() => { const s = window.paperGameState(); return s.audioPerf.audioMemory; })()`).catch(() => null);
        ok('预览音频内存画像', memPrev);
        await pc.shot(path.join(SHOTS, 'v081rc2-large-preview.png'));
      }
      pc.close();
    }

    /* ---- 导出目录版并启动（1.5 GiB 素材的导出耗时） ---- */
    const tExport = Date.now();
    /* 不能用 rmSync 递归删上一次的 1.2 GB 产物：本机 node 注入了 safe-delete 钩子，
       一次性删除上千文件会被拦下。改成重命名让路，旧目录留给人工/脚本清理。 */
    if (fs.existsSync(OUT)) {
      const prev = OUT + '-prev-' + Date.now();
      fs.renameSync(OUT, prev);
      report.previousExport = path.relative(ROOT, prev).split(path.sep).join('/');
    }
    fs.mkdirSync(OUT, { recursive: true });
    await cdp.ev(`(() => { const d = document.getElementById('publishDialog'); if (!d.open) document.getElementById('publish').click(); return true; })()`);
    await sleep(600);
    await cdp.ev(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('pubName', '大型工程音频验收'); set('pubAuthor', '验收脚本'); set('pubVersion', '0.8.1-rc2');
      const t = document.getElementById('pubType'); t.value = 'folder'; t.dispatchEvent(new Event('change', { bubbles: true }));
      return true; })()`);
    await sleep(800);
    const dis = await cdp.ev(`document.getElementById('pubStart').disabled`);
    if (dis) {
      const issues = await cdp.ev(`[...document.querySelectorAll('#pubIssues li')].map(li => li.textContent.trim())`);
      bad('大型工程导出', '导出按钮不可用：' + issues.join('；'));
    } else {
      await cdp.ev(`document.getElementById('pubStart').click()`);
      let res = null;
      const deadline = Date.now() + 20 * 60 * 1000;
      while (Date.now() < deadline) {
        res = await cdp.ev(`(() => { const r = document.getElementById('pubResult');
          return { text: r.textContent || '', progress: (document.getElementById('pubProgressText') || {}).textContent || '',
            running: document.getElementById('pubCancel') && !document.getElementById('pubCancel').disabled }; })()`);
        if (!res.running && /导出完成|导出失败|已取消/.test(res.progress + ' ' + res.text)) break;
        await sleep(1000);
      }
      const exportMs = Date.now() - tExport;
      if (!/导出完成/.test(res.progress)) bad('大型工程导出', res.progress + ' / ' + res.text);
      else {
        const dir = fs.readdirSync(OUT, { withFileTypes: true }).find((e) => e.isDirectory() && !/\.manifest\.json$/.test(e.name));
        const dirPath = dir ? path.join(OUT, dir.name) : '';
        const sizeMB = dirPath ? +((walkSize(dirPath)) / 1048576).toFixed(1) : 0;
        report.artifact = { dir: path.relative(ROOT, dirPath).replace(/\\/g, '/'), exportMs, sizeMB };
        ok('导出目录版（大工程）', report.artifact);

        const exe = dirPath ? findExe(dirPath) : null;
        if (!exe) bad('大型工程导出产物', '没有找到 EXE');
        else {
          const g = await launchExe(exe);
          try {
            let gs = await g.cdp.ev(PREVIEW_STATE).catch(() => null);
            for (let i = 0; i < 80 && !(gs && gs.perf); i++) { await sleep(250); gs = await g.cdp.ev(PREVIEW_STATE).catch(() => null); }
            await sleep(1500);
            gs = await g.cdp.ev(PREVIEW_STATE);
            if (!gs.perf || gs.perf.mode !== 'precise') bad('导出游戏音频', JSON.stringify(gs.perf && { mode: gs.perf.mode, reason: gs.perf.reason }));
            else ok('导出游戏内精确音频', { origin: gs.origin, bgm: gs.perf.bgm, mem: gs.perf.mem, instances: gs.perf.instances });
            /* 推到第 4 句，确认演出里的音频动作在游戏里生效 */
            for (let i = 0; i < 12; i++) {
              const st = await g.cdp.ev(PREVIEW_STATE).catch(() => null);
              if (st && st.i >= 3) break;
              await g.cdp.ev(`document.getElementById('scene').click()`).catch(() => {});
              await sleep(350);
            }
            await sleep(1800);
            const g4 = await g.cdp.ev(PREVIEW_STATE);
            if (!g4.perf || !g4.perf.bgm || !(g4.perf.bgm.time > 0)) bad('导出游戏演出音频', JSON.stringify(g4.perf));
            else ok('导出游戏：演出音频动作生效', { i: g4.i, bgm: g4.perf.bgm, instances: g4.perf.instances });
            await g.cdp.shot(path.join(SHOTS, 'v081rc2-large-game.png'));
          } finally { kill(g.proc); }
        }
      }
    }
    const memEnd = await sampleMemory(cdp, '导出后');
    ok('导出后内存', memEnd);
  } catch (e) {
    bad('大型工程音频回归', String((e && e.message) || e));
  } finally {
    try { cdp.close(); } catch {}
    kill(ed.proc);
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' 1 GiB 大型工程音频回归（M6）');
  if (!report.ok) console.log(report.problems.join('\n'));
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { report.ok = false; report.problems.push(String((e && e.stack) || e)); console.error(e); process.exit(1); });

function walkSize(dir) {
  let sum = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else sum += fs.statSync(f).size; } };
  walk(dir); return sum;
}
function findExe(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findExe(f); if (r) return r; }
    else if (/\.exe$/i.test(e.name) && !/elevate/i.test(e.name)) return f;
  }
  return null;
}
async function launchExe(exe) {
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(exe, ['--remote-debugging-port=' + port, '--remote-allow-origins=*'], { cwd: path.dirname(exe), env, stdio: 'ignore' });
  const page = await waitPage(port, (u) => u.startsWith('papergame://game/'), 120000);
  if (!page) { kill(proc); throw new Error('导出的游戏没有启动'); }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  return { proc, cdp };
}
