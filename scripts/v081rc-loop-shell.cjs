'use strict';
/*
 * V0.8.1-RC · 循环基准的窗口壳（Electron 主进程）。
 * 由 scripts/v081rc-loop-benchmark.cjs 调用：electron v081rc-loop-shell.cjs <page> <out> <modes>
 * 负责切换「前台 / 失焦 / 遮挡 / 最小化 / 恢复」五种窗口状态并逐场景采集。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const PAGE = process.argv[2];
const OUT = process.argv[3];
const MODES = String(process.argv[4] || 'stream').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 920, height: 640, show: true, focusable: true,
    webPreferences: { backgroundThrottling: false } });
  await win.loadFile(PAGE);
  const ev = (expr) => win.webContents.executeJavaScript(expr, true);

  for (let i = 0; i < 100; i++) {
    if (await ev('!!window.__ready').catch(() => false)) break;
    await sleep(150);
  }

  let prep = null, prepError = '';
  try { prep = await ev('window.__prepare()'); } catch (e) { prepError = String((e && e.message) || e); }
  if (prepError) console.log('prepare failed: ' + prepError);

  const results = [];
  let cover = null;
  for (const mode of MODES) {
    const scenarios = [
      { name: '前台聚焦', apply: async () => { try { win.show(); win.focus(); } catch (e) {} await sleep(400); } },
      { name: '失去焦点', apply: async () => { cover = new BrowserWindow({ width: 520, height: 420, show: true, x: 40, y: 40 }); cover.focus(); await sleep(500); } },
      { name: '被遮挡', apply: async () => { if (cover) { cover.setBounds({ x: 0, y: 0, width: 1200, height: 800 }); cover.setAlwaysOnTop(true); cover.focus(); } await sleep(600); } },
      { name: '最小化', apply: async () => { try { win.minimize(); } catch (e) {} await sleep(600); } },
      { name: '恢复前台', apply: async () => { try { win.restore(); win.show(); win.focus(); } catch (e) {} if (cover) { try { cover.close(); } catch (e) {} cover = null; } await sleep(700); } }
    ];
    for (const sc of scenarios) {
      await sc.apply();
      let r = null, err = '';
      try { r = await ev('window.__run({ mode: ' + JSON.stringify(mode) + ', seconds: 5 })'); }
      catch (e) { err = String((e && e.message) || e); }
      results.push(Object.assign({ scenario: sc.name, error: err }, r || {}));
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), prep, prepError, results }, null, 2), 'utf8');
  app.exit(0);
});
