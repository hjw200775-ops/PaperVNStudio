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

## V0.3.1 收尾记录（2026-11-17，Windows 本机）

载荷提交（dist/desktop/tests/package.json 全部内容）：`7134489514624949f52b01132f6f9640dae2c5cd`（在 `ebbdadf` 之上补 MIT 许可证与仓库元数据后重建）

### 已执行的检查

| 检查 | 层级 | 结果 |
| --- | --- | --- |
| `npm run check` | A 自动化 | 通过：14 个脚本语法检查 + 7 个测试文件（新增 `asset-dedupe`、`workspace-hygiene`） |
| `npm run desktop:smoke` | B 可见渲染 | 通过：新增「同图先当背景再当角色 → 两个素材、DOM 三层渲染、落盘 kind 正确」 |
| `npm run desktop:smoke:project` | B 可见渲染 | 通过：新建 → 编辑 → 保存 → 重新打开 |
| `npm run desktop:smoke:packaged` | B 可见渲染 | 通过：最终便携版 EXE 实体，`paper://app/index.html`、7 个示例节点、preload 可用、`require`/`process` 为 undefined |
| `npm run desktop:smoke:packaged -- --asar` | B 可见渲染 | 通过：`app.asar` 打包形态 |
| 7-Zip 抽取 EXE 内 `resources/app.asar` 比对 | 构建证据 | 两个 EXE 内嵌 asar 均为 `82c07781…985d7`，与源码打包结果逐字节一致 |
| 原生对话框 / 三选一 / 安装向导 | C 人工点击 | **未执行** |
| 副机断网打开 | D 副机验收 | **未执行** |

### 根目录残留的处理

源码根目录曾有一份手工试跑留下的空工程：`project.paper.json`（未跟踪）、`assets/images/`（空）、`backups/latest/project.paper.json`（被忽略）。判断依据不是「0 节点」，而是逐项核对：三者从未出现在任何提交里（`git log --all -- ...` 为空）、`assets/` 实际文件数为 0、元数据 `assets/nodes/presets` 全为空数组、备份与主文件字节相同（`43fde512…8dd2`）。

整目录（元数据 + 素材目录 + 备份，保留相对结构）已移动到仓库外：`../_test-archive/2026-11-17-root-smoke-project/`，附 `MANIFEST.md` 记录来源、判断依据与哈希。未删除、未覆盖、未使用 `git clean`。

后续烟测的工程一律建在 `os.tmpdir()`（`pvn-desktop-smoke-*`、`pvn-project-smoke-*`、`pvn-dedupe-*`），最近工程与草稿只写 `userData`；`.gitignore` 没有新增对 `assets/` 或 `*.paper.json` 的忽略，避免以后提交示例工程时被遮蔽，改由 `tests/workspace-hygiene.test.cjs` 在根目录出现工程产物时直接失败。

### 最终产物（V0.3.1 收尾版）

| 产物 | 大小 | SHA-256 |
| --- | --- | --- |
| `release/PaperVNStudio-0.3.1-win-x64-portable.exe` | 110,422,522 字节 | `8b0fe9fe194ba0c1f125f143d4d15e4e7ca5cf7ee30c8cf27c19a6470fa8593e` |
| `release/PaperVNStudio-0.3.1-win-x64-setup.exe` | 121,337,021 字节 | `56c8cb40e28afe45012d86434200c4de4ee940af5ae24f9039e74a6dadf2dca5` |
| `release/app-v11.asar` / `release/stage/resources/app.asar` | 149,065 字节 | `dfd15be8d54aa65ce97672d1c669fb30e33162501d54cdae6765f58c717f59ef` |

修复前的产物（110,421,802 / 121,336,245 字节）与上一轮收尾版（110,422,325 / 121,336,682 字节）均已被替换，`release/v6`、`v7`、`v9`、`v10b` 等早期构建目录仅作过程留痕，**不要用于分发或与本表混用**。公开发布的二进制见 GitHub Release `v0.3.1`，与上表逐字节一致。

### 构建过程备注

本轮 `electron-builder --win --x64` 在解包 Electron 后再次触发本机目录重命名保护（`EPERM`，随后 `safe-delete` 要求批量确认），因此改为复用已解包运行时：`asar pack` 出 `release/app-v10.asar` → 替换 `release/stage/resources/app.asar` → `electron-builder --win portable nsis --x64 --prepackaged release/stage -c.directories.output=release/v10b`。这与上一轮的应急方式一致，只影响构建路径，不影响产物内容；两个 EXE 的内嵌 asar 已用哈希核对。

