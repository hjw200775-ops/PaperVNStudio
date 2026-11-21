'use strict';
/* 交互验收用：把一个导出的自包含 HTML 当作独立页面打开。
 * 只做「加载 + 保持窗口存活」，不注入任何东西，保证测的是真实导出页面。 */
const { app, BrowserWindow } = require('electron');

const FILE = process.argv[2];
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 840, useContentSize: true, show: false,
    backgroundColor: '#17261f',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(FILE);
});
