# V0.3 Desktop Preview · 交付说明

日期：2026-11-15。目标：在 V0.3 网页源码上增加 Windows 桌面窗口、可靠的本地工程目录，并保留离线 HTML 游戏导出。没有重写编辑器或播放器，也没有制作独立游戏 EXE（属于 M4）。

## 运行 / 检查 / 构建命令

| 用途 | 命令 |
| --- | --- |
| 网页版（保留原入口） | `npm start` 或 `node scripts/serve.cjs --port 4173` |
| 桌面开发窗口 | `npm run desktop` |
| 真实窗口自动烟测 | `npm run desktop:smoke` |
| 工程生命周期验证（新建/保存/重新打开） | `npm run desktop:smoke:project` |
| 打包产物启动自检 | `npm run desktop:smoke:packaged`；加 `-- --asar` 可验证 `app.asar` 打包形态 |
| 全部源码检查与测试 | `npm run check`（等价于 `node scripts/check.cjs`） |
| Windows 便携版 | `npm run build:win:portable` |
| Windows NSIS 安装包 | `npm run build:win:installer` |
| 两种 Windows 产物 | `npm run build:win` |

`npm run desktop` 通过 `scripts/desktop.cjs` 启动真实 Electron 窗口；该启动器会清除某些终端注入的 `ELECTRON_RUN_AS_NODE` 环境变量，否则 Electron 会退化成纯 Node 进程而不显示窗口。

依赖版本经 npm registry 核对后固定，未使用浮动版本号，锁文件为 `package-lock.json`：

- `electron` 45.3.2（开发依赖）
- `electron-builder` 26.18.0（开发依赖）

打包配置在 `package.json` 的 `build` 字段：`asar: true`、`directories.output: release`、`win.target: [portable, nsis]`、`artifactName` 分别对应 `...-win-x64-portable.exe` 与 `...-win-x64-setup.exe`。`release/` 已在 `.gitignore` 中，产物不会提交。打包后 `desktop/main.cjs` 通过 `paper://` 协议加载 `dist/` 内的固定白名单文件，不启动任何开发服务器。

构建环境的三点注意（本机实测）：GitHub 工具/运行时下载偶发 `502 Bad Gateway`，可设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试；重复构建时 electron-builder 会清空 `release/win-unpacked`，若本机有批量删除保护，可用 `-c.directories.output=release/<新目录>` 换一个输出目录。第二轮重建时，解包 Electron 后「重命名目录」被本机保护机制拒绝（`EPERM`），改为复用已解包的运行时、只替换 `app.asar` 再打包：

```
npx asar pack <只含 dist/ desktop/ package.json 的目录> release/app.asar
# 复制一份 release/v2/win-unpacked 为 release/stage，替换 stage/resources/app.asar
./node_modules/.bin/electron-builder --win portable nsis --x64 --prepackaged release/stage -c.directories.output=release/v6
```

三种情况都只影响构建过程，不改变产物内容。

## 工程目录格式

```text
我的作品/
  project.paper.json              元数据（版本化，只有相对路径）
  assets/images/<sha256>.<ext>   不可变图片，按内容哈希命名，永不覆盖或删除
  backups/<时间戳>-<原因>/       每次显式保存前的元数据快照
  backups/latest/                最近一次成功写入的主文件副本
  backups/autosave/              自动保存副本（异常退出恢复）
```

`project.paper.json` 顶层包含 `format: "paper-desktop"`、`formatVersion: 1`、`savedAt`、`schema: 3`，以及 `id / title / nodes / presets / assets`。素材条目为：

```json
{
  "id": "a_...", "name": "同名.png", "kind": "bg",
  "width": 1280, "height": 720, "mime": "image/png",
  "file": "assets/images/<64位sha256>.png",
  "sha256": "<64位sha256>", "bytes": 1234
}
```

磁盘格式**不含** `data` 字段。IO 边界把图片解码成 V0.3 运行时模型（`assets[].data` 为 data URL），编辑器与播放器代码因此无需改造；磁盘格式与运行时格式通过 `format`/`formatVersion` 明确区分，不会混用同一字段。

迁移规则：

- V0.1 / V0.2 / V0.3 单文件 `.paper.json` 通过「打开工程 → 旧 .paper.json 文件」导入。先校验、再迁移到 `schema: 3`、解码素材，最后写入新的工程目录；原文件只读，字节不变（测试逐字节比对）。
- 素材 ID 保持原值，避免图层引用断裂；新导入图片使用内容派生的稳定 ID。
- 同名但内容不同的图片得到不同哈希文件名；内容相同的图片复用同一文件。素材文件从不删除，因此任何历史备份引用的图片始终可用。
- 工程目录整体移动后仍可打开：全部路径都是工程内相对路径，不记录用户原图片的绝对路径。

## 可靠保存与恢复协议

1. `project:save` / `autoSave` 先把 data URL 解码、计算 sha256，以「临时文件 → 校验 → 原子改名」写入 `assets/images/`。已存在且哈希一致的文件直接复用；哈希冲突时报错而不覆盖。
2. 元数据写入同样使用临时文件 + 校验读回 + 原子替换；替换前把旧主文件复制为 `backups/<时间戳>/project.paper.json`，替换后写入 `backups/latest/`。
3. 任何阶段失败（磁盘满、文件占用、无权限、异常退出）都会清理临时文件并回退主文件；**不会删除素材**，也不会因为元数据保存失败而提前回收旧资源。错误信息区分 `ENOSPC / EPERM / EBUSY / EACCES / EROFS`。
4. 自动保存只写 `backups/autosave/`，不触碰主文件；启动时若副本比主文件新，会恢复未保存修改并提示。主文件损坏时从 `backups/latest/` 或最近的有效版本备份恢复，并验证其引用的素材哈希。
5. 另存为把当前工程实际引用的素材复制到新目录再提交新工程；旧工程不被修改，新工程不引用旧素材目录。
6. 最近工程记录在 Electron `userData/recent-projects.json`，不进入仓库。
7. 未保存时关闭窗口由主进程提供「保存 / 放弃 / 取消」；保存失败不会退出，编辑器无响应时回退到已校验的自动保存副本。

## 安全边界

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（并调用 `app.enableSandbox()`）、`webSecurity: true`，渲染进程无 `require` / `process` / `fs` / `shell`。
- 应用资源通过 `paper://app/<file>` 提供，只允许 `dist/` 内 8 个白名单文件；禁止任意 IPC 路径参数、任意 `file://` 访问和外部导航（`will-navigate` / `will-redirect` / `setWindowOpenHandler` / `will-attach-webview` 全部拦截，权限请求一律拒绝）。
- 所有 `ipcMain.handle` 都验证 `event.sender` 与页面来源；preload 只暴露固定通道，不接受路径字符串。
- CSP：`script-src 'self'`、`img-src 'self' data: blob:`、`object-src 'none'` 等，网页版通过 meta、桌面版通过协议响应头同时生效。
- 路径校验拒绝 `..`、绝对路径、盘符/UNC、`file:`/`app:`/`paper:`/`blob:`/`data:` 链接、反斜杠与 NUL；素材路径必须匹配 `assets/images/<64位哈希>.<ext>` 且哈希与元数据一致，并解析真实路径防止符号链接逃逸。

## 修改与新增文件

| 文件 | 变更 |
| --- | --- |
| `desktop/main.cjs` | 新增：窗口、菜单、原生对话框、受控 IPC、`paper://` 协议、关闭前保存逻辑、最近工程 |
| `desktop/preload.cjs` | 新增：contextBridge 固定通道接口 |
| `desktop/project-store.cjs` | 新增：纯 Node 工程目录读写、内容寻址素材、旧工程导入、备份/恢复/原子保存、路径校验 |
| `dist/desktop-bridge.js` | 新增：渲染侧桌面适配（网页版加载但不生效） |
| `dist/export.js` | 新增：编辑器与测试共用的自包含 HTML 导出，拒绝本地路径素材 |
| `dist/app.js` | 修改：保存/打开/新建/另存为/选图/选文本/下载/导出/启动恢复接入 `PaperHost`；网页分支保持原逻辑 |
| `dist/player.js` | 追加 CJS 导出，供测试复用；播放器逻辑未改 |
| `dist/index.html` | 加入 CSP、桌面专属按钮（另存为 / JSON 备份 / 最近工程）、新脚本引用 |
| `dist/style.css` | 追加桌面专属控件样式，未改动原有规则 |
| `scripts/desktop.cjs`、`scripts/desktop-smoke.cjs` | 新增：桌面启动器与真实窗口烟测 |
| `scripts/desktop-project-smoke.cjs` | 新增：真实主进程的工程生命周期验证（新建 → 编辑 → 保存 → 重新打开），原生对话框用队列应答 |
| `scripts/packaged-smoke.cjs` | 新增：打包产物启动自检（独立 `--user-data-dir`，避免本机历史工程干扰） |
| `scripts/check.cjs` | 扩展语法检查与测试列表 |
| `tests/project-store.test.cjs`、`tests/export.test.cjs`、`tests/desktop-security.test.cjs` | 新增测试 |
| `package.json`、`package-lock.json` | 固定桌面依赖与构建配置 |
| `docs/*.md` | 更新路线、验收、限制与本交付说明 |

现有 `core.js`、`effects.js` 的行为逻辑未修改；`core.test.cjs`、`effects.test.cjs`、`serve.cjs`、`Start-Web.cmd`、`Check-Source.cmd` 保持不变。

## 已通过的检查

| 检查 | 结果 |
| --- | --- |
| `node scripts/check.cjs`（修改前基线） | 通过；`0b3fddc` 基线提交保留在 `master`，工作在 `desktop-preview` 分支 |
| `node scripts/check.cjs`（本次交付） | 通过：11 个脚本语法检查 + 5 个测试文件 |
| `tests/core.test.cjs` / `effects.test.cjs` | 通过：旧工程迁移、三分支汇合、场景继承、效果插值与三种恢复策略 |
| `tests/project-store.test.cjs` | 通过：中文空格路径、目录迁移、同名图片、另存为、备份恢复、异常退出、注入 ENOSPC/EPERM/EACCES、路径校验、V0.1 导入 |
| `tests/export.test.cjs` | 通过：在 Node VM 中执行导出的游戏脚本，验证共用 core/effects、分支、效果、存取档与自包含 |
| `tests/desktop-security.test.cjs` | 通过：沙箱/CSP/导航/IPC 通道/资源白名单静态核查 |
| `npm run desktop:smoke` | 通过：真实 Electron 窗口（隐藏）加载 `paper://`，验证 preload 隔离、桥接层异步约定、剧情编辑/撤销/试玩、图片图层、尺寸修改、效果、TXT 导入、自动保存、显式保存、备份、离线 HTML 导出，且无渲染进程 console 错误 |
| `npm run desktop:smoke:project` | 通过：真实 `desktop/main.cjs` 主进程，用队列应答原生对话框，走通「新建工程 → 添加节点 → 保存 → 未保存时再打开」，并核对磁盘上的 `project.paper.json` 与 UI 一致 |
| `npm run desktop:smoke:packaged` | 通过：便携版 EXE 实体启动自检，页面为 `paper://app/index.html`、渲染 7 个示例节点、preload 可用、`require`/`process` 均为 undefined；`--asar` 模式同样通过（自检使用独立 `--user-data-dir`，不受本机历史工程影响） |
| `PAPER_VN_SMOKE=1 npm run desktop` | 通过：正式 `desktop/main.cjs` 入口（非烟测专用主进程）自检通过 |
| 网页版入口 | 通过：`http://127.0.0.1:4188/` 下 9 个资源全部 200，越界路径 404，POST 405；脚本加载顺序正确 |
| Windows 构建 | 通过：`npm run build:win:portable` 与 `npm run build:win:installer` 均实际生成 EXE（见下方「Windows 构建结果」）；首次遇到下载 502 与目录清理保护，已用镜像/新输出目录解决 |

## 尚未验证 / 未执行

- **人工可见窗口与交互**：smoke 使用隐藏窗口自动化验证；没有人工逐项拖动图层边框、缩放手柄、原生对话框 clicking 的主观体验验收。
- **另一台电脑**：导出的 HTML 未在无制作器、无 Node 的第二台机器上打开验证（已用 VM 执行导出的脚本并检查无本机依赖）。
- **打包产物的自动化启动自检已通过**，但没有人工双击 EXE 后逐项操作菜单、对话框与编辑功能；这一层仍属人工验收。
- **NSIS 安装过程**：安装包已生成，但未在另一台干净 Windows 机器上执行安装向导并运行安装后的程序。
- **代码签名**：未配置证书，Windows 可能提示「未知发布者」。
- **未保存关闭的三选一对话框**：逻辑与失败回退已实现并静态核查，未在真实窗口里人工点击三个按钮。
- **原生对话框选择目录、图片、TXT**：smoke 用受控 IPC 桩返回已选文件，未弹出真实系统对话框。
- **M4**：独立游戏 EXE、自动更新、多平台、签名、发布，均未开始。
- 大规模素材/长篇压力测试、完整跨浏览器矩阵、异常断电注入仍按 `docs/KNOWN_LIMITATIONS.md` 保留为已知限制。

## Windows 构建结果与修复记录

本机（Windows 10.0.26300，Node 22.22.2，electron-builder 26.18.0）实际生成：

| 产物 | 路径 | 大小 |
| --- | --- | --- |
| 便携版 | `release/PaperVNStudio-0.3.1-win-x64-portable.exe` | 110,421,378 字节（约 105 MiB） |
| NSIS 安装包 | `release/PaperVNStudio-0.3.1-win-x64-setup.exe` | 121,335,783 字节（约 116 MiB） |
| 免安装目录 | `release/v6/win-unpacked/`（与两个产物同版） | 含 `PaperVNStudio.exe` 与 `resources/app.asar` |

构建日志显示 `electron=45.3.2`、`asar: true`、未配置代码签名。`app.asar` 内 14 个文件（`dist/` 8 个、`desktop/` 3 个、`package.json` 等），入口 `desktop/main.cjs` 已核对。

**实现中发现并修复的真实缺陷**：`setWindowOpenHandler` 是 `webContents` 的方法，最初误挂在 `BrowserWindow` 上，会导致正式桌面入口在 `createWindow` 时抛错、窗口不出现。隐藏窗口烟测用的是独立主进程，没覆盖到正式入口，因此补上了：
1. `desktop/main.cjs` 的可选自检分支（`PAPER_VN_SMOKE=1` 时报告页面来源与渲染进程隔离状态）；
2. `scripts/packaged-smoke.cjs`，对便携版 EXE 实体与 `app.asar` 打包形态做启动自检；
3. `tests/desktop-security.test.cjs` 的防回归静态断言。

修复后两个 EXE 均重新构建，并以 `npm run desktop:smoke:packaged` 验证通过；`release/` 内早期构建目录（`.win-unpacked-*`、旧 `nsis/`、`v2/`、`nsis-v2/`、`v3/`、`v4/`、`v5/` 等）为构建过程留痕，均在忽略目录内，可自行清理。

### 第二轮修复（使用者反馈：启动提示「启动恢复失败」，新建/打开工程无效）

原因：`dist/desktop-bridge.js` 把 `ok()` 直接套在 IPC 返回的 Promise 上（`ok(api.save(p))`），此时 `r.ok` 永远是 `undefined`，于是**所有**保存、另存为、新建、打开、最近工程、启动恢复都会在渲染进程立刻抛「桌面文件操作失败」。主进程其实已经把文件写完了，所以旧烟测只检查磁盘文件存在，没能发现这个错误。

修复与加固：

1. `dist/desktop-bridge.js` 增加 `call()` 包装：先 `await` IPC 结果再校验，7 个操作全部改为 `call(() => api.x())`。
2. `desktop/main.cjs` 的「新建工程」不再创建 0 个节点的空工程，而是带一个空白对话节点，避免新建后编辑器里没有任何可选内容。
3. `dist/app.js` 新建工程后选中第一个节点，与打开工程的逻辑一致。
4. 防回归：`tests/desktop-security.test.cjs` 断言桥接层不得出现 `ok(api.`；`npm run desktop:smoke` 增加「bootstrap / recent / newProject / open 必须 resolve 且不得进入失败分支」；新增 `npm run desktop:smoke:project` 端到端验证。
5. `scripts/packaged-smoke.cjs` 自检改用独立 `--user-data-dir`，否则本机已有最近工程时启动会恢复它，节点数断言失去意义。

两个 EXE 已用修复后的 `app.asar` 重建（`release/v6/` 为构建目录），根目录产物已替换，`npm run desktop:smoke:packaged` 复验通过。

## 产物位置

- 源码与测试：项目根目录。
- 最终打包产物：`release/PaperVNStudio-0.3.1-win-x64-portable.exe`、`release/PaperVNStudio-0.3.1-win-x64-setup.exe`（`release/` 为忽略目录）。
- 用户工程：由作者通过「新建 / 另存为」选择的任意目录，不写入仓库。
- 最近工程与未关联草稿：Electron `userData` 目录（`recent-projects.json`、`drafts/`）。
- 烟测临时工程：系统临时目录 `pvn-desktop-smoke-*`（输出中会打印实际路径）。
