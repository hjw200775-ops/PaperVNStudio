# PaperVNStudio 开发交接（后续开发入口）

> 更新时间：2026-11-27 · 当前基线：`V0.8.2-M3B`（开发阶段，**不是正式 V0.8.2 发布版**）
> Git：`origin/feature/v0.8.2-timeline` @ `4e04af9`，回退节点 `f863ad8`（M3-A）
> 本地 `main` 未改动；远程 `main` / `master` 保持原状。

这份文档给接手本仓库的人看：先读这里，再按需要进入 `docs/V0.8.2_M3B_ACCEPTANCE.md`（技术验收）和 `docs/V0.8.2_M4_HANDOFF.md`（M4 阶段任务）。

---

## 1. 项目是什么

PaperVNStudio（纸间）是**本地运行的视觉小说 / Galgame 创作工具**，Windows x64 优先。
核心能力链是：**建工程 → 导入素材 → 写剧本 → 节点内多轨时间轴排演出 → 试听 → 发行**，
发行载体包括单文件 HTML、目录版游戏、Windows 独立 EXE。

V0.8.2 的主线是「节点内多轨时间轴演出」，M0→M3B 已完成技术闭环；
下一阶段 M4 是**真实作品制作体验**（人工听感 / 跨机器 / 实际创作流程）。

---

## 2. 当前做到哪了（V0.8.2-M3B）

M3B 的目标是证明「最终发布的游戏能正确执行创作者在时间轴里编排的演出」。

| 能力 | 状态 |
|---|---|
| 多轨时间轴编辑：移动 / 拉伸 / 吸附 / 缩放 / 多选 | 完成 |
| 真实音频波形、实时音视频同步预览 | 完成 |
| Voice 暂停续播、BGM 状态恢复、合法交叉淡化与异常双 BGM 区分 | 完成 |
| 时间轴与普通试玩终态一致性 | 完成 |
| 发布产物演出数据完整性（单文件 HTML / 目录版 / EXE） | 实机验证通过 |
| 五种运行环境 A/B/C/D/E 一致性 | 实机验证通过 |
| 剧情交互、分支汇合、阻塞/非阻塞演出、存读档 | 实机验证通过 |
| 发布载体音画同步 | A/C/E 热态 P95 ≤ 50ms |
| 大型工程（约 1.5 GiB）专项 | 14 项通过 |
| `npm run check` | 全绿 |

**关键缺陷修复（不要回退）**：`dist/player.js` 曾把 `!animate||prefersReduced()`（reduced 语义）
传给参数名为 `animate` 的 `runAudioPerformance`，导致正式播放器正常播放时完全不执行一次性
音频演出（SFX / Voice / 交叉淡化 / Ducking），读档时反而重放历史音效。编辑器走独立驱动，
所以之前的编辑器内一致性测试发现不了。已修为 `animate&&!prefersReduced()`，并有契约测试
`tests/player-audio-schedule.test.cjs` 固守。

---

## 3. 证据在哪（可复现）

证据均为**真实窗口实机采集**，不是构建产物静态断言。

| 文件 | 内容 |
|---|---|
| `release/v082m3b-release-verify.json` | 五环境一致性 + 剧情交互主验收：47 PASS / 0 FAIL |
| `release/v082m3b-env-d.json` | 目录版 D 独立 APPDATA 会话补采，与 E 逐字段一致 |
| `release/v082m3b-interaction-extra.json` | 分支两路径汇合、阻塞演出点击跳过、非阻塞跨节点 |
| `release/v082m3b-avsync.json` | A/C/E 冷/热/掉帧音画同步；热态 P95 = 3.5 / 1.1 / 2.6ms |
| `release/v082m3b-large-project.json` | 1.5 GiB 大型工程专项 |
| `release/v082m3b-audio-regression.json` | 共享音频受影响回归；判定无需重跑 900s 浸泡 |
| `release/v082m3b-packaged-verify.json` | 最终便携版 12 步实机验证 |
| `release/v081rc3/voice-verify-result.json` | RC3.1 Voice 严格验收 |
| `docs/screenshots/v082m3b-*.png` | 7 张真实窗口截图 |

**口径提醒**：M3A 的 `10.6ms` 是 JS 派发漂移（`driver.sync.driftMs`），**不是**音频起音与视觉
变化的偏差；M3B 才补上带时间戳的起音事件 + DOM 视觉变化配对。音画同步不含扬声器实际
输出延迟（无系统回环采集），样本每轮 4–5 个，统计置信度有限。

---

## 4. 架构要点（改动前先知道）

- **演出数据**：`node.performance.actions`，字段含 `id / type / target / params / duration /
  delay / mode('after'|'parallel') / start(可选绝对时间) / blocking / enabled`。
  `after` / `parallel` 是 `mode` 的取值，不是独立字段。单一数据源就是它，时间轴只做投影。
- **发布序列化**：三种载体共用 `dist/export.js::buildGameHTML()`，整份工程一次
  `JSON.stringify` 内联进 `<script>`；生产链路**不**调用会重建 params 的 `PF.normalize()`。
  素材引用扫描 `core.referencedAudioIds()` / `referencedImageIds()` 已覆盖演出动作，
  「仅在演出里用到的 BGM / 背景」不会被裁剪。
- **协议与资源**：`paper://` 服务编辑器，`pvres://` 服务完整预览，`papergame://` 服务
  目录版 / EXE，单文件 HTML 用纯 `data:` URI、不依赖自定义协议。CSP / sandbox /
  webSecurity 未因兼容放宽。
- **播放运行时**：`dist/player.js`、`dist/audio.js`、`dist/performance.js` 等工厂函数
  经 `toString()` 内联进产物；`timeline*.js` 是纯编辑器 UI，不在发布产物里。
  `game/` 与 `build-game-package.cjs` 是 V0.7 遗留示例包链路，不是通用发行链路。
- **版本来源**：软件版本唯一来源是 `package.json` 的 `version` / `versionLabel`，
  `tests/version-consistency.test.cjs` 强制界面 / 窗口标题 / 构建清单同步。
  **绝不能**跟着改 `schema`、`formatVersion`、`node.performance.version`、
  `sampleVersion`、作品 `publish.version`、`game/package.json.version`。

---

## 5. 怎么跑

```bash
npm install
npm run check                       # 全部静态检查与单测（新增测试已接入）

# 重建 Windows x64 便携版
node scripts/build-win-dir.cjs

# 实机验收（PVN_DEV=1 用源码 Electron；不带则用最终便携版）
PVN_PHASE=all node scripts/v082m3b-release-verify.cjs
node scripts/v082m3b-avsync.cjs
node scripts/v082m3b-large-project.cjs
node scripts/v082m3b-packaged-verify.cjs
node scripts/v082m3b-interaction-extra.cjs
node scripts/v082m3b-env-d.cjs
node scripts/v082m3b-audio-regression.cjs
node scripts/packaged-smoke.cjs release/PaperVNStudio-0.8.2-M3B-win-x64/PaperVNStudio.exe
```

验收用《晚风》**隔离副本** `release/v082m3b/晚风-M3B发布验收副本/`，不要覆盖原始工程与素材。
Electron 实机脚本依赖 `scripts/rc2-cdp.cjs` 的 CDP 工具集；关闭沙箱 / 放宽权限不是解决问题的办法。

---

## 6. 下一步：M4（真实作品制作体验）

按顺序做：

1. 用真实作品从零走完整流程：建工程 → 导入素材 → 写剧本 → 排时间轴 → 试听 → 发行 → 交给别人玩。
2. 人工听感与艺术方案确认：循环点、交叉淡化曲线、Ducking 强度、镜头与角色走位。
3. 第二台机器 / 不同 GPU / 不同声卡人工验收；安装向导与「未知发布者」提示。
4. 有条件时补扬声器 / 声卡回环采集，量化系统输出延迟。
5. 真实作品长时播放体验；**若改动音频引擎或缓存策略必须重跑 ≥900s 浸泡**。

详细任务与边界见 `docs/V0.8.2_M4_HANDOFF.md`。

---

## 7. 已知限制 / 不要顺手改

- `core.analyze()` 与 `project-store.inspectReferences()` **不校验** `node.performance.actions`
  里的素材引用。删除「只在演出里用到的素材」不会在「检查剧情」里报错；导出链路本身不丢
  素材，这是提示缺口。改动涉及核心校验语义，需专项评估。
- 发布播放器没有自动播放 / 快进的独立 UI 按钮，按钮级行为标为 NOT_RUN；等价行为已实测通过。
- 单文件 HTML 默认全量内嵌图片（14 秒测试工程约 38 MB），目录版 / ZIP 才裁剪。
- 跨节点时间轴、音频裁剪 / 变速、视频 / Live2D 不在 V0.8.2 范围。
- 代码签名、多平台、自动更新、正式发版流程尚未做。

## 8. Git 协作约定

- 当前进度推送在 `origin/feature/v0.8.2-timeline`；`main` / `master` 未动，回退节点 `f863ad8` 保留。
- 继续在功能分支做最小增量提交；合并到 `main` 与正式发版需单独确认，不要顺手做。
- 动手前先核对实际 Git 基线与构建配置，复用既有脚本，不重复已通过且未受影响的测试。
- 发现核心调度 / 音频时钟 / 复杂竞态缺陷时，先记录复现步骤、实际证据与影响范围，
  根因未明确前不反复试错。
