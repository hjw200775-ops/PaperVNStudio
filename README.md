# 纸间 PaperVNStudio · V0.3 源码交付包

这是已完成网页体验版的真实源码，不是根据功能描述重新生成的模板。当前分支在保留网页版的基础上实现了 V0.3 Desktop Preview：Electron 桌面窗口、本地工程目录、可靠保存与备份，并保留离线 HTML 游戏导出。独立游戏 EXE 与 AI 动作模型仍属于后续阶段。完整交付说明见 `docs/DESKTOP_PREVIEW.md`。

## 先做这三件事

1. 将压缩包中的文件解压到你已创建的项目文件夹。确认 `package.json`、`dist`、`scripts` 在同一级，避免多套一层目录。
2. 双击 `Start-Web.cmd`，按终端提示打开 `http://127.0.0.1:4173/`。需要本机存在 Node.js；当前源码包不需要 `npm install`。
3. 用本地 AI 工具打开整个文件夹，将 `AI_START_PROMPT.md` 的全文发给它。让 AI 先读文档、检查原版，再开始桌面迁移。

如果你的文件夹为 `D:\Projects\PaperVNStudio`，其直接下级应是 `dist\index.html`、`package.json` 等文件。实际路径以你创建的目录为准。

## 从命令行运行

```powershell
node scripts/serve.cjs
# 或 npm start
```

如端口被占用：

```powershell
node scripts/serve.cjs --port 4174
```

源码检查：

```powershell
node scripts/check.cjs
# 或 npm run check
```

关闭开发服务：在运行窗口按 Ctrl+C。本地服务只监听本机，不会把项目开放到局域网。

## 桌面预览版（Windows）

```powershell
npm install              # 首次需要；依赖版本已固定在 package-lock.json
npm run desktop          # 打开独立桌面窗口（不需要启动上面的网页服务）
npm run desktop:smoke    # 真实 Electron 窗口自动烟测（隐藏窗口，不弹窗）
npm run desktop:smoke:project    # 真实主进程验证「新建 / 保存 / 重新打开」
npm run desktop:smoke:packaged   # 打包 EXE 启动自检（加 -- --asar 验证 app.asar 形态）
npm run check            # 源码检查与全部测试
npm run build:win        # 便携版 + NSIS 安装包，产物在 release/
```

桌面版使用「文件」菜单或页面顶部的按钮新建 / 打开 / 保存 / 另存为工程。工程是一个目录（含 `project.paper.json`、`assets/images/`、`backups/`），图片复制进工程内部，移动整个目录后仍可打开。旧版单文件 `.paper.json` 通过「打开工程 → 旧 .paper.json 文件」导入，原文件不会被修改。「导出试玩」生成的 HTML 依然自包含，不含本机路径。未保存时关闭窗口会提示保存 / 放弃 / 取消。

## 网页里的工程怎样迁过来

线上网址和本地网址的浏览器存储互不相通。请先在原网页点击「保存工程」，下载 `.paper.json`，再在本地页面点击「打开工程」导入。图片、图层、剧情和效果都包含在下载的工程中。不要清理原网页数据后再尝试迁移。

包内没有你在浏览器中上传的素材或草稿；这些不在站点源码里。页面首次启动时可能只有默认文字示例，这是正常现象。

`4173` 与 `4174` 也属于不同来源；改变端口后如看不到原草稿，请导入工程文件。

## 文件结构

| 文件 | 用途 |
| --- | --- |
| `dist/index.html` | 编辑器页面与控件 |
| `dist/style.css` | 工作台样式与响应式布局 |
| `dist/app.js` | 编辑状态、图层操作、导入导出、自动保存与撤销 |
| `dist/core.js` | 工程校验、旧工程迁移、剧情与场景解析 |
| `dist/effects.js` | 效果参数、插值、状态延续与渲染 |
| `dist/player.js` | 导出游戏播放器与样式 |
| `dist/export.js` | 自包含 HTML 导出（编辑器与测试共用） |
| `dist/desktop-bridge.js` | 桌面适配层；网页版加载但不生效 |
| `desktop/main.cjs` | 桌面窗口、菜单、原生对话框与受控 IPC |
| `desktop/preload.cjs` | 固定通道的 contextBridge 接口 |
| `desktop/project-store.cjs` | 工程目录读写、素材哈希、备份与恢复 |
| `tests/` | 核心逻辑、效果、存储、导出与安全回归测试 |
| `scripts/` | 无依赖本地服务、检查入口、桌面启动与窗口烟测 |
| `AI_START_PROMPT.md` | 直接发给本地 AI 的任务说明 |
| `AGENTS.md` | 本仓库开发约定 |
| `docs/DESKTOP_MIGRATION.md` | 桌面迁移路线与工程格式 |
| `docs/DESKTOP_PREVIEW.md` | 本次桌面版交付说明、命令与验证结果 |
| `docs/ACCEPTANCE.md` | 实机验收清单与证据 |
| `docs/KNOWN_LIMITATIONS.md` | 已知限制与未验证内容 |
| `docs/SOURCE_PROVENANCE.json` | 原始源码版本及逐文件校验值 |

## 已有能力

文本录入/TXT 导入、旁白、任意选项与分支汇合；多图片图层、拖动/缩放/排序/锁定/隐藏；场景继承与预设；逐句缩放、移动、透明度、模糊、亮度、对比度、饱和度和旋转；效果恢复策略；撤销重做；工程 JSON 导入导出；离线 HTML 游戏导出。

原始网页脚本保持与 V0.3 基线一致，便于对照调试。部分源码较紧凑，后续可以小步整理，但应先通过测试与实际交互检查。

## 发布说明

本包不含云端部署绑定、源站凭据或原站 Git 历史，已在本机新建独立仓库（基线提交 + `desktop-preview` 分支），未创建远程仓库、未上传代码、未公开素材、未选择开源许可证。发布前由项目所有者确认许可证与素材授权，不要将其他来源的角色图片、字体、语音自动视为可公开分发素材。

Windows 便携版 / 安装包由 `npm run build:win` 生成到忽略目录 `release/`。下载运行时偶发 502 时可设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 重试；重复构建遇到目录清理限制时可用 `-c.directories.output=release/<新目录>` 换输出目录。详见 `docs/DESKTOP_PREVIEW.md`。
