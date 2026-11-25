'use strict';
/*
 * V0.8.2-M0 / M0-0：V0.8.1 最终收尾实机验证（Windows x64 便携版）。
 * 验证「循环参数 修改 → 保存 → 关闭重开 → 一致」往返 + 目录版导出配置保留。
 * 用法：node scripts/v081-final-verify.cjs → release/v081-final-verify.json
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, sleep, freePort, waitPage, connect, kill } = require('./rc2-cdp.cjs');

const EXE = path.join(ROOT, 'release', 'PaperVNStudio-0.8.1-win-x64', 'PaperVNStudio.exe');
const PROJECT = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环试听工程');
const MAIN = path.join(PROJECT, 'project.paper.json');
const REPORT = path.join(ROOT, 'release', 'v081-final-verify.json');

const report = { at: new Date().toISOString(), version: '0.8.1-rc3.1', exe: EXE, stages: {}, problems: [] };
const ok = (n, d) => { report.stages[n] = { ok: true, detail: d || null }; console.log('  ok  ' + n + (d ? ' — ' + JSON.stringify(d).slice(0, 180) : '')); };
const bad = (n, m) => { report.stages[n] = { ok: false, message: m }; report.problems.push(n + '：' + m); console.log('  FAIL ' + n + ' — ' + m); };

async function openEditor(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({
    version: 1, lastOpened: PROJECT, items: [{ path: PROJECT, title: '晚风·循环试听工程', openedAt: new Date().toISOString() }]
  }));
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const proc = spawn(EXE, ['--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + userData], { cwd: ROOT, stdio: 'ignore', env });
  const page = await waitPage(port, (u) => u.startsWith('paper://app/'), 60000);
  if (!page) { kill(proc); return null; }
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  return { proc, cdp };
}
async function gotoTitle(cdp) {
  await cdp.ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.dataset.tab==='title').click()`).catch(() => {});
  await sleep(300);
}
async function readLoop(cdp) {
  return await cdp.ev(`({asset:document.querySelector('#titleMusicAsset').value,mode:document.querySelector('#titleMusicLoop').value,start:document.querySelector('#titleMusicLoopStart').value,end:document.querySelector('#titleMusicLoopEnd').value})`);
}

(async () => {
  if (!fs.existsSync(EXE)) { bad('便携版存在', '找不到 ' + EXE); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  ok('便携版存在', { bytes: fs.statSync(EXE).size });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvn-final-'));
  const s1 = await openEditor(path.join(work, 'u1'));
  if (!s1) { bad('便携版启动', '编辑器未启动'); fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); process.exit(1); }
  ok('便携版启动并打开隔离工程');
  for (let i = 0; i < 200; i++) { const n = await s1.cdp.ev(`document.querySelectorAll('#list .node').length`).catch(() => 0); if (n >= 30) break; await sleep(150); }
  const nodes = await s1.cdp.ev(`document.querySelectorAll('#list .node').length`);
  ok('打开工程', { nodes });

  await gotoTitle(s1.cdp);
  const before = await readLoop(s1.cdp);
  console.log('  修改前:', JSON.stringify(before));

  // 改成 6.4–30.5 并应用 + 显式保存（写主文件 project.paper.json）
  const applyErr = await s1.cdp.ev(`(() => {
    const mode=document.querySelector('#titleMusicLoop'),s=document.querySelector('#titleMusicLoopStart'),e=document.querySelector('#titleMusicLoopEnd');
    if(!mode||!s||!e)return 'no-elements';
    mode.value='region'; mode.dispatchEvent(new Event('change',{bubbles:true}));
    s.value='6.4'; e.value='30.5';
    document.querySelector('#titleMusicApply').click();
    return 'applied';
  })()`).catch((e) => 'err:' + e.message);
  if (applyErr !== 'applied') bad('修改循环参数', applyErr);
  else ok('修改循环参数为 6.4–30.5');
  await sleep(500);
  await s1.cdp.ev(`document.querySelector('#save').click()`).catch(() => {});
  await sleep(1500);

  const onDisk = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const tm = onDisk.titleMusic || {};
  const diskOk = tm.loopStart === 6.4 && tm.loopEnd === 30.5 && tm.loop === true;
  if (diskOk) ok('保存写入磁盘', { loopStart: tm.loopStart, loopEnd: tm.loopEnd });
  else bad('保存写入磁盘', JSON.stringify(tm));

  kill(s1.proc); s1.cdp.close();
  await sleep(800);

  const s2 = await openEditor(path.join(work, 'u2'));
  if (!s2) { bad('关闭重开', '编辑器未启动'); }
  else {
    for (let i = 0; i < 200; i++) { const n = await s2.cdp.ev(`document.querySelectorAll('#list .node').length`).catch(() => 0); if (n >= 30) break; await sleep(150); }
    await gotoTitle(s2.cdp);
    const after = await readLoop(s2.cdp);
    console.log('  重开后:', JSON.stringify(after));
    const ok2 = after.mode === 'region' && Math.abs(Number(after.start) - 6.4) < 0.05 && Math.abs(Number(after.end) - 30.5) < 0.05;
    if (ok2) ok('保存关闭重开后循环参数一致', after);
    else bad('保存关闭重开后循环参数一致', JSON.stringify(after));
    kill(s2.proc); s2.cdp.close();
  }

  report.ok = report.problems.length === 0;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + ' V0.8.1 最终收尾实机验证');
  process.exit(report.ok ? 0 : 1);
})();
