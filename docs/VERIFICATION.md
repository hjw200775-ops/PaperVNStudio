# 本次导出检查记录

日期：2026-11-15。

- 原始网页 6 个文件与原测试 2 个文件逐字节核对：一致。
- JavaScript 语法检查：通过。
- 核心逻辑与效果测试：通过。
- 新增本地服务启动、页面与脚本资源响应：通过。
- 本地服务 HEAD、非 GET 请求限制、越界路径拒绝、404：通过。
- ZIP 完整性及文件路径：通过。

检查在 Linux 执行环境完成；Windows CMD 双击启动、桌面窗口、原生工程保存和安装包尚未实机验证。此前网页交互验证不替代这些项目。

## 桌面迁移验证记录（2026-11-15，Windows 本机）

- 基线 `node scripts/check.cjs`：通过；初始化本地 Git，基线提交 `0b3fddc`，工作在 `desktop-preview` 分支。
- 交付版 `npm run check`：通过（11 个脚本语法检查 + 5 个测试文件）。
- `npm run desktop:smoke`：真实 Electron 窗口（隐藏）通过 —— `paper://` 白名单加载、preload 隔离、剧情编辑/撤销/试玩、原生选图 → 图层、宽高修改、效果添加、TXT 导入、自动保存副本、显式保存、重新打开校验、last-good 备份、离线 HTML 导出自包含；渲染进程无 console 错误。
- 网页版入口：`http://127.0.0.1:4188/` 下 9 个资源全部 200，越界路径 404，非 GET 405。
- 依赖核对：npm registry 查得 `electron` 45.3.2 / `electron-builder` 26.18.0，固定版本并生成 `package-lock.json`。
- Windows 打包：便携版 `release/PaperVNStudio-0.3.1-win-x64-portable.exe`（110,420,778 字节）与 NSIS 安装包 `release/PaperVNStudio-0.3.1-win-x64-setup.exe`（121,335,236 字节）均已实际生成；`app.asar` 14 个文件、入口 `desktop/main.cjs` 已核对。构建中遇到 GitHub 下载 502（用 `ELECTRON_MIRROR` 镜像解决）与重复构建清理目录被批量删除保护拦截（用 `-c.directories.output=release/<新目录>` 解决）。
- 打包产物启动自检：`npm run desktop:smoke:packaged` 对便携版 EXE 实体通过（页面 `paper://app/index.html`、7 个节点、preload 可用、渲染进程无 `require`/`process`）；`-- --asar` 与 `PAPER_VN_SMOKE=1 npm run desktop` 同样通过。
- 修复记录：开发过程中发现 `setWindowOpenHandler` 误挂在 `BrowserWindow` 上，会导致正式窗口创建失败；修复后重建两个 EXE 并通过上述自检，另加静态防回归断言。
- 未执行：人工可见窗口交互、原生对话框点击、未保存关闭三选一、NSIS 安装向导与安装后运行、另一台电脑断网打开导出 HTML、代码签名。
