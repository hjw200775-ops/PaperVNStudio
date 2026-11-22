# 更新日志

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
