# PaperVNStudio development instructions

## Purpose

中文、面向无编程基础作者的 Galgame 制作器。V0.3 网页源码为行为基线；下一目标为 Windows 桌面预览版。详见 `AI_START_PROMPT.md` 与 `docs/DESKTOP_MIGRATION.md`。

## Scope and workflow

- 在当前源码上渐进改造，不重写一套新原型。
- 首次修改前运行 `node scripts/check.cjs`。变更后执行相关测试。
- 不随意格式化全部紧凑源码；如果整理结构，单独提交并验证行为一致。
- 保留网页预览和独立 HTML 游戏导出。
- 不把桌面封装、安装包构建与真实 Windows 验收混为一谈。
- 完整预览走「会话目录 + pvres://」：渲染进程只传工程对象，主进程把 data URI 落成内容寻址文件，HTML 里资源是 URL。**不要退回把整份 HTML 传进 IPC**——那会让素材量直接变成 HTML 体积。协议 handler 必须校验会话与路径，HTML 要带 CSP。
- 会话目录 `userData/preview-sessions/s-<id>/`：窗口 closed 即删，启动时清一次；不要写进用户工程目录。
- 导出时图片与音频都按引用收（`referencedImageIds` / `referencedAudioIds`），只在产物里排除，不动工程素材。
- 音乐：素材库元数据放在 `audioAssets[].meta`（`category / moodTags / scene / trackId`），磁盘往返要一起保留；`trackId` 是逻辑曲目号，换完整版按它匹配、素材 id 不变，否则会断掉剧情绑定。
- 场景配乐只写段落入口节点，后续句子靠继承；不要逐句写 `bgm: play`，那会每句重启播放。导出用 `referencedAudioIds()` 收包，未引用的曲目留在工程里。
- 标题音乐走独立的 `<audio>` 通道（`p.titleMusic`），不占 `audio.js` 的 BGM 槽位：进入游戏 `pause`、返回标题续播、`pagehide` 释放。不要把它塞进剧情 BGM 状态机。
- 版本号有两套值：作者填的原样进 `manifest.game.version` 与文件名；EXE 版本资源只收四段数字，由 `numericVersion()` 取每段前导数字再补齐（`0.7.2-test → 0.7.2.0`）。**不要用「整段必须是数字」的过滤**——那会把 `2-test` 整段丢掉导致段位左移，`1.2.3-beta` 还会静默变成 `1.2.0.0`。`desktop/game-builder.cjs` 与 `game-pack-worker.cjs` 各有一份，必须同源；worker 是 extraResources，改完要重新打包纸间。
- 点击推进要区分手势：`pointerdown` 记坐标，位移超过 8px 不推进。播放器与编辑器试玩两边规则必须一致，否则拖动会无故跳句。
- 游戏包只带播放器所需的文件、游戏资源与许可说明；不要复用编辑器的 appId / userData，也不要把测试音频、工程文件、开发路径打进包里。ZIP 内中文文件名必须按 UTF-8 写（`scripts/zip-writer.cjs`），否则换语言系统会乱码。
- 检查并保留用户未提交的文件；不覆盖草稿、素材或本地工程。
- 工程模型、资源路径与文件读写分层；运行时恢复逻辑由编辑器和播放器共用。

## Current architecture

- `core.js`: data validation, schema migration, scene and branch resolution.
- `effects.js`: deterministic effect evaluation and browser rendering.
- `app.js`: editor state, user interactions, persistence, undo and exports.
- `player.js`: standalone game runtime, embedded in exported HTML.
- `index.html` + `style.css`: interface.
- `desktop/game-builder.cjs` + `desktop/game-pack-worker.cjs`: 通用游戏导出。重活必须在子进程里做（主进程同步复制/NSIS 会阻塞事件循环，取消 IPC 进不来）。运行时取自当前 Electron，组件取自 `resources/toolchain` 或 `vendor/toolchain`，不写死盘符。
- `desktop/game-shell/`: 通用播放器壳，读 `content/game.json`，按 `releaseId` 隔离存档。
- 玩家端交互规则写在 `dist/player.js` 的 `paperPlayerCSS`（作用于 `#titleScreen` / `#gameRoot` / `.overlay` 这些结构容器，不绑对话框样式），图片靠 `-webkit-user-drag:none` + `draggable=false` 禁拖，另有一条 `dragstart` 兜底。**不要为了禁选去改 `pointer-events`**：`#layers` 靠 `pointer-events:none` 让点击穿透到舞台。编辑器试玩用 `body.playing` 作用域单独禁选，创作模式必须保持可选中、可拖动。
- `game/`: 《晚风》示例包的旧构建入口（V0.7.1 脚本仍在用）。只提供 `wanfeng://` 白名单协议、独立 userData 与窗口安全边界；没有 preload、IPC 与编辑器 UI，不引用 `dist/` 源码。

不要只修改网页加载的 effects 文件而遗漏导出时嵌入的工厂函数。任何模块化调整必须验证自包含 HTML 输出。

## Data and safety

- 原始图片不覆盖；素材导入复制到工程管理目录。
- 写入采用失败可恢复的协议；保存失败不退出，不删除唯一备份。
- 不把用户绝对路径、最近工程、草稿、缓存、凭据或测试素材提交到仓库。
- 桌面渲染进程不直接开放 Node/fs/shell；preload/IPC 只提供受控操作。
- 旧 `.paper.json` 在导入时迁移，不修改原文件。
- 稳定节点/素材/图层 ID；删除资源后明确报告失效引用。

## Communication

直接执行已授权的可逆开发，不反复索取普通实现许可。遇到真正的缺失信息或范围变化再询问。

报告测试与构建结果时区分：逻辑测试、浏览器验证、Windows 运行、安装包构建、另一台电脑验收。没有执行的项目不得标记通过。
