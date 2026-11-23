# 更新日志

## V0.8.0 — 舞台演出系统（2026-11-23）

基线 `1e10d96`（V0.7.6）。本轮完成 M1–M6 与性能回归，本地提交，未推送。

### 新增

- **统一演出数据模型（M1）**：`performance = { version, actions[] }` 挂在剧情节点上，14 种声明式动作
  （角色出现 / 离场 / 移动 / 缩放 / 透明度 / 表情 / 上下浮动，背景切换 6 种转场，镜头平移 / 缩放，
  全屏渐暗 / 闪白 / 震动，等待）。字段含唯一 ID、语义目标、参数、时长、延迟、缓动、阻塞、顺序/并行、启用位。
  严格 Schema 校验：动作上限 200、ID 唯一、时长 0–30 秒、参数逐项范围；非法值与 `NaN` 在入口拒绝。
  **不提供任何「执行脚本」动作**，工程里写不进 JavaScript。schema 升到 6，旧工程自动补 `performance: null`。
- **演出运行时（M2）**：`dist/performance.js` 单文件、零依赖；纯函数 `stateAt(before, actions, t, ctx)`，
  `t = ∞` 即终态；单一 rAF 驱动全部动作，不为每个动作开定时器；语义目标 `char:<id>` / `bg` 解析到当前舞台图层，
  换立绘、换章节仍指向正确对象；演出写内层 `.pf-frame`，与既有逐图层效果（外层 `.visual-layer`）并存不覆盖；
  背景转场含交叉淡化 / 黑屏 / 白屏 / 左右滑动，带 ghost 合成层避免空白帧；镜头与覆盖层只作用于舞台，
  对话框保持在最上层。
- **演出编辑界面（M3）**：编辑器右侧新增「舞台演出」面板——7 个预设（角色淡入登场、侧面进入、向前靠近、
  退场，场景淡入淡出，回忆闪白，轻微震动）、动作类型与目标选择、参数表单、时长 / 延迟 / 缓动 / 顺序并行 /
  阻塞、上移下移 / 复制 / 删除、单动作预览 / 整段预览 / 应用终态。预设只生成标准动作。
- **剧情状态同步（M4）**：阻塞动作播完才放行；演出中点击先结算动画再放行；换句 / 退出试玩 / 切章先取消旧动画；
  读档 / 后退 / 重开沿 trail 重放得到同一状态；跳过与正常播完必然同一终态；快进立即应用终态。
- **发布一致性（M5）**：编辑器试玩、完整预览（`pvres://`）、单文件 HTML、独立游戏共用同一个
  `performance.js`；`buildGameHTML` 的第 5 个工厂参数内联演出运行时。
- **《晚风》演出样板（M6）**：`scripts/build-wanfeng-v08.cjs` 在隔离副本上生成三场景 37 句 / 54 动作 /
  约 2 分 23 秒的连续演出，产出 before（原始）/ after（优化）双工程、单文件试玩版、真实窗口三场景截图，
  并前后比对新版《晚风》原件指纹（73 个文件一致，未改动原件）。
- 新增测试 `tests/performance.test.cjs`（数据模型 / 调度 / 状态 / 分支 / 重开 / 换章 / 取消）、
  真实窗口验收 `scripts/performance-window-smoke.cjs`（7 阶段）、性能回归
  `scripts/performance-benchmark.cjs`、录屏 `scripts/record-wanfeng-v08.cjs`。
- 新增文档 `docs/V0.8.0_STAGE_PERFORMANCE.md`（架构与数据模型）、`docs/STAGE_PERFORMANCE_GUIDE.md`（编辑器教程）、
  `docs/V0.8.0_ACCEPTANCE_REPORT.md`（验收报告）。

### 修复

- **试玩时演出取错节点**：`perfList()` 取的是「列表里选中的句子」而不是「正在播放的句子」，导致推进到下一句后
  舞台仍在重放上一句的演出，背景 / 表情 / 镜头都不更新。改为取 `active()`；编辑时不试玩，两者本就是同一节点。
- `player.js` 的演出控制器在换句时未取消，可能出现旧动画继续改写新句图层；改为 `draw()` 开头统一 `cancel()`。
- 演出面板的初始化顺序导致 `Cannot access 'perfList' before initialization`（TDZ）：`render()` 在模块初始化
  阶段就会调用面板渲染，而 `perfList` 当时是用 `const` 箭头函数定义的。改为函数声明并把运行态提升到顶层。
- `perfBlocking` / `perfSkip` 原先定义在 `syncPerfStage` 内部，`next()` / `go()` 取不到；改为顶层函数声明。
- 进入试玩时角色「一开始就是不透明」：`syncPerfStage` 把 `reduced` 传成 `!playbackAnimate`，进句时直接跳终态；
  改为恒定 `reduced: false`，只有系统「减少动态效果」才走终态分支。
- 导出漏图：`referencedImageIds()` 未统计演出里 `background.change` 引用的素材，只在演出中出现的背景会缺失；
  已计入引用表。
- 桌面受控协议白名单缺少 `/performance.js`，安全测试直接拦下；已加入 `ALLOWED`。

### 实测

- `npm run check` 全绿（24 个测试文件 + 全部源码语法检查），其中 `tests/performance.test.cjs` 覆盖
  顺序/并行/阻塞、跳过与重放一致、100 次重复不漂移、7 个预设、非法参数、分支/重开/换章/取消。
- 真实 Electron 窗口 7 阶段验收全过：面板渲染（3 条动作 / 7 个预设）、阻塞点击语义（0.146 → 1.0 不跳句）、
  第二句背景交叉淡化 + 表情切换 + 镜头 1.10、编辑器与完整预览终态一致、读档重建、全屏渐暗不遮对话框。
- 1 GiB 工程（1,577,977,792 bytes / 100 图 / 576 节点 / 12 章）：打开 573 ms；演出期间 528 帧 / 5.3 s
  （fps 99，最差帧 59 ms）；峰值内存 629 MB；连续播放 10 句后内存 -17 MB（GC 后回落），无单调增长。
- 《晚风》演出样板：37 句 / 54 动作 / 预计 143 秒；单文件试玩 29.6 MB（单 `<script>`，含演出运行时）；
  录屏 `docs/media/v080-wanfeng-play.webm`（128 秒 / 14.1 MB / VP9）。

## V0.7.6-M3 — 素材流式导入与 1 GiB 工程验收（2026-11-23）

基线 `1ba3fd3`（V0.7.6-M2）。本轮完成 M3 并宣布 V0.7.6 完成；本地提交，未推送。

### 新增

- **素材导入即落盘**：新增 `desktop/asset-staging.cjs` 与 `asset:stage` IPC。主进程流式读取 + 分块 SHA-256，落到 `userData/asset-staging/<sha256>.<ext>`；渲染进程只拿到 `paper://app/staging/…` 受控 URL、哈希、大小、MIME 与尺寸/时长，不再接收 Base64。
- **批量导入**：支持单文件与批量，进度/取消/逐条错误提示；`asset:stageProgress` 驱动界面进度条。覆盖背景、角色立绘与表情、标题背景、CG、BGM、SFX、Voice 全部入口。
- **跨表示精确去重**：统一以 SHA-256 为内容标识，已落盘素材、暂存素材、旧工程 data URI 可互相比对；`tests/audio-store.test.cjs` 的跨表示断言恢复为 `reused === true`。
- **暂存生命周期**：当前工程 + 撤销栈 + 重做栈共同保护暂存文件，`asset:gc` 只清理无引用且过期的文件；取消、失败中断、关闭不保存、异常退出重启、另存为均不产生悬空资源地址。
- **验收取证**：新增 `app:metrics` 受限指标通道、`__pvnM3` 桌面验收钩子、1 GiB 生成脚本、真实窗口 12 步验收、内存采样报告、Alpha 隔离副本验收。
- 新增文档 `docs/V0.7.6_ACCEPTANCE_REPORT.md`，重写 `docs/V0.7.6_RESOURCE_ARCHITECTURE.md`，更新 `KNOWN_LIMITATIONS.md`。

### 修复

- 测试夹具 CRC32 表的偶数分支误写为 `c>>>0`（应为 `c>>>1`），导致生成的 PNG 在浏览器无法解码；修正 3 处生成/验收脚本并重新生成 1 GiB 工程（Python 逐块复核 CRC/IHDR/WAV 头）。属测试夹具问题，非产品协议缺陷。
- `game:export` 只识别 `portable`，界面选择「独立游戏目录」被静默降级为 ZIP 包；改为 `folder/portable/zip` 白名单，产物后缀与 `game-builder` 一致。
- 单文件 HTML 的 200 MB 守卫只在素材是受控 URL 时生效，纯 data URI 旧工程会绕过并可能拼出超大字符串；改为无条件检查。
- Electron `ProcessMetric.type` 中渲染进程为 `Tab`（非 `Renderer`）、`workingSetSize` 单位为 KB；采样脚本据此换算，修正早期报告中主/渲染进程数值为 0 的问题。

### 更正

- 三个《晚风》Alpha 工程并非缺失，实际位于 C: 工作区 `wanfeng_alpha/projects/`（V0.7.4 只搜 F/Z 盘导致误报）。已用隔离副本完成 3/3 兼容性验收，原始作品未改动。

### 实测

- 1,576,200,076 bytes 去重素材（100 张可解码 PNG + 104 段 PCM WAV / 204 个不同哈希 / 12 章 576 节点），真实 Electron 窗口完成导入→编辑→播放→撤销→保存→重开→预览→目录版导出→启动导出游戏，14 阶段全通过、0 问题。
- 峰值内存：主进程 514.8 MB、渲染进程 324.5 MB、全部 Electron 进程 1,118 MB（214 个采样点覆盖 12 阶段）。
- `npm run check` 全绿；新增 `asset-staging` / `asset-lifecycle` / `m3-compat` 三个测试。

详见 [docs/V0.7.6_ACCEPTANCE_REPORT.md](docs/V0.7.6_ACCEPTANCE_REPORT.md)。

---

## V0.7.6-M2 — 运行时资源 URL 化（`1ba3fd3`）

- 打开工程不再把素材读成 Base64，改为 `paper://app/asset/…` 受控 URL；示例工程运行时 JSON 从约 21 MB 降到 34 KB。
- `C.migrate` 对 schema 5 原地归一，避免大工程 `Invalid string length`。
- 保存/另存为新增 `sourceRoot`，修复另存为丢失 URL 素材的真 bug。
- 导入落盘与 1 GiB 验收留待 M3。

## V0.7.5 — 大型游戏资源分离（`d0582cf`）

- 独立游戏发布改为目录版 / ZIP：轻量 HTML + `papergame://` 按需读取资源，解除 64 MB 自包含 HTML 限制。
- 按引用裁剪素材、manifest、`formatVersion: 4`。

## V0.7.4 — 大型工程完整预览（`6ac5f0d`）

- `pvres://` 会话目录 + 按需读取，预览页面只保留播放器与引用，关闭窗口即释放会话资源。
- 资源引用分析与导出体积统计。

## V0.7.3 / V0.7.2 / V0.7 — 音乐素材库、通用游戏导出与交互修复

详见 `docs/` 下对应版本文档与 git 提交历史。
