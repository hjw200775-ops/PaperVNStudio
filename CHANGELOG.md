# 更新日志

## V0.8.2-M1-B — 多轨时间轴编辑交互完善（2026-11-26）

基线 `0720e48`（M1-A），分支 `feature/v0.8.2-timeline`。单节点作用域不变，冻结模块未改
（`audio.js` / `player.js` / `performance.js` 核心调度与求值 / `core.js` 迁移 / V0.7.6 资源存储）。

- **片段拉伸**：左右边缘手柄；右边缘保持 start 只改 duration，左边缘保持 end 改 start+duration；
  实时显示起点/终点/时长；零时长 `◆` 事件无手柄；Esc/无位移/取消不写数据；一次拖动一次撤销。
- **缩放与滚动**：1–4000 px/s、放大/缩小/适应范围/默认、Ctrl+滚轮、锚点时间稳定；
  轨道名列固定、片段区横向滚动、刻度网格与片段同一坐标系；`0s` 刻度完整可读；
  `relayout()` 只改样式不重建片段 DOM。
- **时间吸附**：关闭 / 0.1 / 0.25 / 0.5 / 1 秒；参考网格、片段起止、播放头、0；
  阈值按像素（`8px/pps`）；橙红参考线；Alt 临时关闭；移动与拉伸同一规则；1ms 精度防漂移。
- **多选与批量**：Ctrl/Shift 选择、点空白取消、共同移动保持相对间隔、负时间钳制、一次撤销；
  未选动作不写 `start`、切节点清空、Esc 取消。
- **复制粘贴删除**：Ctrl+C / Ctrl+V（播放头为起点）/ Ctrl+D / Delete；新唯一 ID、保留参数与
  素材引用及动作间隔、不复制素材文件；输入框聚焦时不拦截；删除与撤销一致。
- **轨道组织**：固定轨道顺序 + 按角色拆子轨道并显示角色名、折叠展开、空轨道开关；
  折叠只改显示，不改工程数据与发布行为。
- **交互稳定性**：保护 M1A 拖动状态机，缩放/滚动/切节点/删除/撤销重做均正确取消或恢复；
  document 级监听器只注册 1 次；pointermove 不写工程、不建快照。
- 相对→绝对规则：仅被操作动作写 `start`，未选中相对动作由 `schedule()` 自然跟随。
- 新增 `tests/timeline-interaction.test.cjs` M1B 16 组（合计 28 组）、
  `scripts/v082m1b-ui-verify.cjs`（真实窗口 41 项）、证据 `release/v082m1b-ui-verify.json`、
  截图 `docs/screenshots/v082m1b-*.png`、`docs/V0.8.2_M1B_ACCEPTANCE.md`、`docs/V0.8.2_M2_HANDOFF.md`。
- `npm run check` 全绿、`packaged-smoke` PASS、最终 Windows x64 便携版实机 41 项全绿；
  100 动作节点渲染 1.4ms、监听器 1 个；0.5s/10s/60s/300s+ 时间轴覆盖。
- **V0.8.2-M1B 技术验收通过，产品体验待人工复验**；完成后立即停止，未进入 M2。

## V0.8.2-M1-A — 编辑器内时间轴闭环（2026-11-26）

基线 `ae3f63d`（M0），分支 `feature/v0.8.2-timeline`。只做单节点时间轴最小可用闭环。

- 新增 `dist/timeline-panel.js`：正式编辑器内时间轴面板（`TL.toTimeline` 投影，支持并行片段、零时长瞬时事件、无动作空状态），**不保存第二份动作或排程数据**。
- `dist/timeline.js` 增加 `createDragSession()` 纯交互状态机：拖动期间只显示临时预览、不改数据；松手用一次 `edit()` + `TL.setStart()` 写回绝对秒，一次拖动一个撤销步骤；Esc / 无位移 / pointercancel / lostpointercapture / 切换节点一律取消。
- 动作列表与时间轴按动作 ID 双向同步选择和属性；显式 `start` 显示「绝对开始时间」并禁用 `mode/delay`；提供「恢复相对时间」清除 `start`。
- 播放头 scrub 用 `scrubState()` 每次从进入前状态重新求值（不累加、节点隔离），只调 `PF.applyDOM` 改画面，不触发 SFX/Voice、不切换或重启 BGM。
- 松手后按真实 `schedule()` 刷新整条时间轴；后续相对动作跟随，绝不偷偷给其它动作写 `start`。
- **冻结模块未改**：`dist/audio.js`、`dist/player.js`、`dist/performance.js` 核心调度/求值、`dist/core.js` 迁移语义。
- 新增 `tests/timeline-interaction.test.cjs`（12 组）、`scripts/v082m1a-ui-verify.cjs`（真实窗口 37 项）。
- `npm run check` 全绿、packaged-smoke PASS、最终 Windows x64 便携版实机 37 项全绿；证据 `release/v082m1a-ui-verify.json`，截图 5 张。
- 验收记录：`docs/V0.8.2_M1A_ACCEPTANCE.md`。**技术闭环完成，产品体验待人工复验**；闭环通过即停。

## V0.8.2-M0 — 可视化多轨演出时间轴 · 架构基础（2026-11-25）

基线 `79eb401`（V0.8.1-RC3.1），分支 `feature/v0.8.2-timeline`。

### V0.8.1 最终收尾（M0-0）

- 实机验证（Windows x64 便携版）发现并修复：标题音乐循环点 `6.4–30.5` 保存后被
  `toTitleMusic` 的 `numIn(Math.round)` 取整成 `6–31`，丢失乐句匹配所需的小数秒精度。
  改为夹到 [0,86400] 并四舍五入到 1ms；单测覆盖；实机保存关闭重开后一致。
- 用户人工听感验收：**PASS**。D 方案循环交叉淡化仍属实验能力；其他已知限制如实保留。
- 验证产物 `release/v081-final-verify.json`。

### 时间轴架构（M0-1…M0-6）

- 数据模型：动作新增可选 `start`（绝对秒）；`schedule()` 优先读 `start`，旧工程无 `start`
  走 `after/parallel` + `delay`（向后兼容，无需迁移）。
- 新增 `dist/timeline.js`（时间轴数据层：`toTimeline/scrubState/audioSideEffectsAt/setStart/...`）。
- 新增 `tests/timeline.test.cjs`（11 组：映射/顺序并行/偏移/确定性/定位/回退/防重放/终态一致/start 映射/轨道）。
- 技术原型 `release/v082m0/timeline-prototype.html` + 截图。
- 文档 `docs/V0.8.2_TIMELINE_ARCHITECTURE.md`、`docs/V0.8.2_M1_HANDOFF.md`。

## V0.8.1-RC3.1 — 播放可靠性修复与循环试听编辑器（2026-11-25）

基线 `0534551`（V0.8.1-RC3）。本轮不进入 V0.8.2。

### M1 · Voice 播放失败根因（已定位并修复）

上一轮 15 分钟浸泡从第 40 秒起持续出现「播放失败（段落 6 · 第 41 句）」的真实根因：

- 那句是 60s / 10.5MB 的 WAV 配音，起播前被切句打断；浏览器 `HTMLAudioElement.play()`
  以 **AbortError** 拒绝（"interrupted by a call to pause()"）。
- 旧 `classifyError` 不认识 AbortError，落到 `unknown`，记为「播放失败」并**永久挂横幅**。
- 修复：`start()` 把「通道已停止 / 代际过期 / AbortError 打断」判为**合法取消**（`play-cancelled`），
  不再记错误、不再污染状态栏；真正失败（NotSupportedError / 解码失败）照常记 `play-failed` / `decode-failed`。
- 实机复现（`scripts/v081rc3-voice-verify.cjs`）：track_018 起播延迟 186ms、可正常起播；打断后 `cancelled=1`、`failed=0`、无错误。

### M2 · 验收系统假阳性修复

- `dist/audio.js` 新增播放事件统计 `playbackStats()`：requested / started / completed /
  cancelled / failed / decodeFailed / fallback；`snapshot()` 暴露 `errors`、`playbackStats`、`dualBgm`。
- 浸泡脚本 `v081rc2-soak-editor.cjs` 新增严格断言：意外播放失败、解码失败、错误横幅、
  播放事件数量关系失衡、精确/流式双 BGM 叠加，任一命中即 FAIL。
- 负向验证 `tests/audio-negative.test.cjs`：缺失素材 / 播放拒绝 / 解码失败必然被发现（FAIL），
  合法取消与正常起播不误报（PASS）。

### M3 · 编辑器内循环试听工具

- 新增 `dist/loop-audition.js`（轻量组件）：波形、播放头、可拖动 A/B 标记、整曲/区间/不循环、
  精确起止时间输入、循环边界试听（终点前 3s 起播回跳起点）、候选区间、应用/重置/取消。
- 运行时新增 `decodeWaveform`（复用 64MiB 缓存，按需生成）与 `loopPreview`
  （与发布游戏一致的 `AudioBufferSourceNode` + `loopStart/loopEnd`，接同一根 bgm 总线）。
- 标题音乐面板加入循环模式与区间输入；对《晚风》标题曲提供 A/B/C/D 候选（非通用默认值）。
  交叉淡化 D 为实验能力，独立试听页可用，编辑器内明确标记。

### M4 · 已修复 Bug 实机复验

- 双 BGM：`enter(rebuild)` 补 `preciseStop(0)`；真实窗口验证 rebuild 后 `dualBgm=false`、
  单实例。错误横幅：进入下一句清除旧错误、新错误仍能显示（单测覆盖）。

### M7 · 构建

- 重新构建 Windows x64 免安装目录版 `release/PaperVNStudio-0.8.1-win-x64/`（400MB / 195 文件 /
  Electron 45.3.2，含 vendor/toolchain 与 loop-audition.js）；`packaged-smoke` 通过。

### 未完成 / 待人工复验

- 人工听感与最终循环点仍由用户决定；技术验收完成而艺术方案待定。
- 完整 900 秒浸泡结果见 `release/audio-soak-15min-rc3.1.json`。

## V0.8.1-RC3 — 独立审查与实际体验修复（2026-11-25）

基线 `c38188a`（V0.8.1-RC2）。本轮不进入 V0.8.2。**结论：技术修复完成，产品体验待人工复验。**

### 审查结论（M0）

上一轮「人工听感」判定为 FAIL。核心问题不是播放器接缝（精确循环接缝 ≤0.06ms 可信），而是：

1. 标题音乐 6–14s 循环区间**没有音乐依据**，14s 卡在强起音附近，旋律被截断、乐句不完整。
2. 既有验收只测「接缝静音 + 理想正弦波」，从未测「旋律是否截断 / 乐句是否完整 / 循环点前后数秒能量与配器是否一致」。
3. 15 分钟浸泡测试自己的数据里从第 40 秒起持续挂着「播放失败（段落 6 · 第 41 句）」直到结束，
   但结论仍写 `ok: true, problems: []`——浸泡脚本只断言 JS 异常与实例数，没有断言音频真的播放成功。

### 修复（M4）

- **错误横幅永久悬挂**：`dist/audio.js` 的 `errors` 只增不减，一句播放失败后「播放失败」横幅挂到会话结束。
  现在 `enter()` 进入新句时清掉解码/缺失/未知错误，只保留「未获播放许可」。
- **返回/读档后双 BGM**：`enter(rebuild)` 只停流式 BGM、不停精确模式 BGM（`preciseBgm`），
  导致精确 BGM 与重建起的流式 BGM 叠加。现在 rebuild 时一并 `preciseStop(0)`。

### 新增（M1/M2/M6）

- `scripts/v081rc3-audio-analysis.cjs`：真实 Chromium 解码 6 首 OST，分析时长/起音/乐句间隙/曲尾曲首相关度/循环候选，
  产出 `release/audio-loop-audit.json`。
- `scripts/build-loop-abcd.cjs`：生成 A/B/C/D 人工试听页
  `release/wanfeng-v081rc3/晚风·循环方案ABCD试听.html`（自包含、双击即开、支持盲听、每方案 3 个完整循环、
  单独重复循环边界、交叉淡化 20/50/100/200/500ms、试听评价表）。

### 报告

- `docs/V0.8.1_RC3_EXPERIENCE_REPORT.md`：独立审查、缺陷清单、A/B/C/D 候选、修复记录、三层验收标准、
  人工验收操作说明。

### 未完成

- 人工听感未确认（等用户盲听定夺循环方案）。
- 浸泡「播放失败」的根因未定位（合成压测工程，需本机复现）。
- 编辑器内循环试听工具（M3）未内嵌，本轮以独立试听页替代。
- 隔离试玩工程与 Windows 便携版暂缓，等用户选定循环方案后落盘/打包。

## V0.8.1-RC2 — 音频集成与最终验收（2026-11-24）

基线 `33e5ff2`（V0.8.1-RC）。本地提交，未推送。

### 变更

- **标题音乐并入音频引擎（M1）**：删掉播放器里独立的 `<audio>` 与 60ms ticker 回跳，
  改为 `audio.titlePlay/titlePause/titleResume/titleStop/titleSnapshot`。标题曲与剧情 BGM
  **共用同一个音乐槽**（`preciseBgm.owner ∈ {story,title}`），新曲起时旧曲必然淡出销毁——
  双 BGM、返回标题放错曲、重复创建 `AudioContext` 在结构上不成立。暂停记录偏移，恢复从暂停点继续。
- **修复标题循环区间丢失**：`core.toTitleMusic()` 规范化时只复制 4 个字段，`loopStart/loopEnd`
  被丢掉——编辑器里设了 6–14，保存重开变回整曲循环。现在区间随工程保存，`checkTitleMusic` 校验越界。
- **发布资源受控读取（M2）**：目录版 `papergame://` 与编辑器预览 `pvres://` 打开 `connect-src 'self'`
  并允许 fetch，单文件独立游戏打开 `connect-src data:`；协议处理器仍只服务白名单路径，
  没有关 `webSecurity`/`sandbox`，没有通配符，也没有网络能力。目录版实测 `mode=precise`、
  解码缓存 14.5 MB、演出交叉淡化生效、0 条 CSP 报错。
- **解码预算前置与串行化（M3）**：解码前按压缩体积估算（压缩音频 ×24、WAV ×2.2），超预算直接回退；
  同一时刻只解一段；淘汰在解码前做；`audioMemory()` 分别给出缓存、在播缓冲、在途解码、峰值与拒绝/取消次数。
- **编辑器试玩补上音频演出**：此前编辑器试玩只跑画面演出，`audio.*` 动作被完全忽略（试玩静音）。
  现在复用与播放器相同的执行顺序（先按路径落地继承状态，再按 start 挂本句动作）。
- **修复免安装版导不出游戏**：`build-win-dir.cjs` 没复制 `vendor/toolchain`（rcedit / 图标合成），
  用户在「发行 → 目录版」会直接报「缺少 rcedit 构建组件」。已补上（110 → 194 个文件，396.8 MB → 400.0 MB），
  并用最终 EXE 导出《晚风》目录版、启动导出游戏验证音频通过。
- **验收脚本**：`v081rc2-title-audio`（标题音乐真实窗口）、`v081rc2-game-audio`（目录版精确音频）、
  `v081rc2-online-pcm`（AudioWorklet 在线采样）、`v081rc2-large-audio`（1.47 GiB 工程）、
  `v081rc2-soak-editor`（15 分钟浸泡）、`v081rc2-envs`（编辑器 / Windows 版）、`build-title-ab`（A/B 试听页）。

### 实测

- **在线 PCM（AudioWorklet，真实窗口）**：正弦 1s 区间 × 30 次边界，最长静音 **0.021 ms**，
  相邻样本最大跳变 0.0173（= 220 Hz/48 kHz 的理论上限）；《晚风》OST 2s 区间 × 13 次，0.06 ms；
  失焦 13 次、最小化 13 次、恢复后 9 次，均为 0.021 ms 且音频时钟连续推进。
- **标题音乐**：`mode=precise`、区间 6–14、循环次数由音频时钟递增；开始游戏后音乐槽交给剧情、
  返回标题恢复且始终只有 1 个实例；连续进出 5 次缓存条目不变；音量调到 35% 时输出 RMS 下降（0.46×）。
- **1.47 GiB 工程**：打开 682 ms、576 节点 / 104 个音频素材；面板加音频动作时素材下拉 105 项；
  撤销/重做、保存、关闭重开均正确；完整预览 `pvres://` 精确播放；导出 1.2 GB 用时 11.9 s；
  导出游戏内 `papergame://` 精确播放且演出音频动作生效。
- **Windows x64**：`release/PaperVNStudio-0.8.1-win-x64/`（399,984,535 B / 194 文件，Electron 45.3.2），
  免安装目录版；编辑器试玩精确播放 + 交叉淡化通过；从该 EXE 导出目录版并启动，导出游戏内 `precise` 通过。

### 未完成

- **人工听感未确认**：技术验收通过，音质与音乐衔接仍需用户主观判断。
- **操作系统回环输出未采集**：只有离线渲染 PCM 与在线音频图 PCM 两种证据。
- 浏览器后台标签页场景不适用（Electron 单窗口，最小化时 `document.hidden` 仍为 false）。

## V0.8.1-RC — 音频循环稳定性与发布验证（2026-11-24）

基线 `4516825`（V0.8.1），回退点 `43ceec4`（V0.8.0-RC）。本地提交，未推送。

### 新增

- **精确循环模式（M2）**：`dist/audio.js` 增加第二套播放模式 `precise`——`AudioBufferSourceNode` +
  `loopStart/loopEnd`，边界由音频线程处理，不再依赖 rAF / 定时器。淡变、交叉淡化、Ducking
  全部改为 `AudioParam` 曲线（`linearRampToValueAtTime` / `setValueCurveAtTime`），与帧率无关。
- **解码缓存与内存预算**：默认 64 MiB，按 `length × channels × 4` 估算；LRU 淘汰，正在播的不淘汰；
  `cacheStats()` 暴露 `entries/bytes/budget/ids`。
- **异步竞态防护**：每个解码请求带 `loadSeq`，过期结果标记 `stale` 并**丢弃**（不回退成流式，
  避免旧请求把新音乐盖掉）。
- **自动选择与透明回退**：`modePref = stream | precise | auto`；无 `AudioContext`、超预算、解码失败
  都会回退流式，并在快照里给出 `mode / preciseReason / graphError / cache / graph`。
- **可注入上下文**：`audioContext` 支持 `OfflineAudioContext`，同一套图可做确定性离线验收。
- 新增 `tests/audio-precise.test.cjs`（7 组）、`scripts/v081rc-loop-offline.cjs`（50 次 PCM 循环验收）、
  `docs/V0.8.1_RC_ACCEPTANCE_REPORT.md`。

### 修复

- **精确源未接入终态落地**：`applyAudioState()` 只走流式 `channel()`，跳过/快进后仍是定时器循环；
  改为优先 `bgmCrossfade()`（精确），解码期间旧流式通道继续播，完成后接管。
- **过期请求被当成播放**：`stale` 结果原先会回退成流式并真的播出来，等于旧请求盖掉新音乐；
  改为直接丢弃。
- **`applyAudioState({bgm:null})` 没停精确源**：只停了元素通道，精确源仍在响。

### 实测

- 离线渲染 50 次（正弦 30 + OST 区域 10 + OST 整曲 10）：循环边界 ±40 ms 内最长静音
  **正弦 0.02 ms / OST 0 ms**，P95 远超 20 ms 指标；相邻样本最大跳变 0.0281（正弦理论极限 0.029）。
- 单文件 HTML 实测进入 `precise`：缓存 1 条 / 15.9 MB / 64 MB，播放器层 11 项全过、0 异常。
- Windows x64 重建：396,813,135 bytes，packaged-smoke 通过（仅启动验证）。

### 未完成

- 1 GiB 大型工程音频回归、15 分钟浸泡、五种运行环境全量音频验收均未做；
- 标题音乐仍是流式 + ticker（越界 41–70 ms），未接入精确模式；
- 目录版游戏 CSP `connect-src 'none'` 会阻止精确模式解码，未放开复测；
- 人工试听未做，标记「技术验收通过、听感待确认」。

## V0.8.1 — 音频演出引擎（2026-11-24）

基线 `43ceec4`（V0.8.0-RC）。本地提交，未推送。

### 新增

- **统一音频引擎（M1）**：`dist/audio.js` 在既有 `HTMLAudioElement` 运行层上做加法，不重写播放器。
  新增 `mixVolume()`：最终音量 = Master × 用户分类音量 × 剧情总线音量 × 播放音量 × Ducking；
  用户偏好（`prefs`）与剧情音量（`showVolume`）是两条独立链路，剧情再大声也改不了玩家设置。
- **交叉淡化（M2）**：`bgmCrossfade()` 新旧两个通道并存，支持 `linear` 与 `equalPower`（sin/cos，功率不塌）；
  新曲立刻开始播、旧曲淡出后才销毁；同一首 BGM 的切换请求不新建实例，只调音量与循环。
- **循环区间**：`loopSpec` 三态（不循环 / 整曲 / `[start, end]`），到 `loopEnd` 回跳 `loopStart`，
  记录跳回次数与接缝越界毫秒；标题音乐也支持 `loopStart/loopEnd`（`checkTitleMusic` 校验区间）。
- **Ducking（M3）**：`duckPush/duckPop` 计数持有，连续语音不抖；`level/attack/release` 可配；
  语音替换时先停止旧通道再重新持有，不累积。
- **11 种音频动作（M4）**：`audio.bgm.play/stop/crossfade/volume/loop`、`audio.sfx.play/stop`、
  `audio.voice.play/stop`、`audio.bus.volume`、`audio.ducking`。参数逐项校验，旧工程 `performance: null` 照常可用。
- **可计算终态与副作用的分离**：BGM / 总线 / Ducking 写进 `stateAt()` 的 `audio` 目标状态，
  跳过与快进用 `applyAudioState()` 一次性落地（同一首不重启）；SFX / Voice 是纯副作用，
  不进终态，跳过与读档一律不补播。
- **编辑面板（M5）**：新增 7 个音频预设与音频参数控件（素材、音量、淡入淡出、过渡、循环、曲线、总线、压低），
  以及「♪ 试听这条动作的音频素材」。
- **样板与验收**：《晚风》音频演出版（40 句 / 8 个音频动作 / 5 段素材 / 36.2 MB 单文件），
  引擎层与播放器层两个真实运行时验收脚本，报告见 `release/audio-performance-benchmark.json`、
  `release/v081-audio-window-html.json`。

### 修复

- **导出的音频裁剪漏掉演出引用**：`core.referencedAudioIds()` 只统计逐句音频指令，
  演出里 `audio.*` 用到的 BGM / 音效会被裁掉，运行时表现为「素材缺失」。已把音频动作计入引用表。
- **读档后没有 BGM**：`draw()` 的顺序让 `enterAudio(rebuild)` 的 `stopBgm` 把演出刚起的音乐掐掉；
  改为「逐句音频先落地、演出音频后接管」。同时补上「从 trail 重建出的继承音频状态」——
  中途继续时先按重建状态恢复 BGM，再挂本句动作。
- **面板初始化与参数输入**：音频参数里的复选（压低开关）与文本（音效 key）原先会走数字分支，已分别处理。

### 实测

- 引擎层（真实 Chromium 解码）：首次播放 100–246 ms；线性淡入 15 点单调 0→0.80；
  等功率交叉 12 点 0→0.79、峰值 0.80、过渡期 `retiring=1`、结束后 0；
  Ducking 0.80→0.28→0.80；100 次切换后 `instances={bgm:1,retiring:0}`、音量 0.80 不漂移；0 异常。
- 播放器层（单文件 HTML）：标题循环 28 秒 3 个完整循环（越界均 34 ms）；开始游戏 325 ms 可闻；
  第 14 句换曲终态正确；快进后 `sfx=0/voice=0/bgm=1`；读档恢复夜晚 BGM 与区间循环。
- 循环接缝：本机验收窗口无前台合成器，rAF 不触发、定时器被节流到 ~1 s，
  实测平均 330 ms / 最大 984 ms——**如实记录，不宣称采样级无缝**。

### 未完成

- 未做人工试听（技术验收通过，听感待确认）；
- 目录版游戏 / Windows 版本的音频实机、1 GiB 大型工程音频回归均未跑；
- Windows 可运行版本仍是 V0.8.0-RC 的构建，需重新打包才能包含本轮改动。

## V0.8.0-RC — 目录版游戏实机验收（2026-11-24）

补齐 V0.8.0 遗留的硬性缺口：**目录版游戏导出 → 启动独立 EXE → 实际播放舞台演出**。
基线 `42ca01c`，本地提交，未推送。

### 新增

- `scripts/v080-rc-game-verify.cjs`（`npm run perf:game`）：真实编辑器窗口导出目录版 →
  启动导出的 `晚风演出验收.exe` → 用 CDP 读舞台真实状态，19 项断言。
- 《晚风》演出样板加入**剧情分支**（第二章末尾两选一，两条路各 1 句后汇合到第三章），
  样板由 37 句 / 54 动作变为 **40 句 / 58 动作 / 154 秒**，便于验证分支下的存档与终态一致性。

### 实测（19 项全过，0 条运行时异常）

- 导出产物：`晚风演出验收-0.8.0-rc-win-x64-独立游戏/晚风演出验收.exe`（250,135,040 bytes），
  播放器页 209,382 bytes、单 `<script>`、14 处 `papergame://game/` 资源引用。
- 演出在 EXE 里真的在跑：镜头 scale 1.006 → 1.018；林澈淡入 opacity 0.334 → 点击结算 1.000 且不跳句；
  林悠侧面进入 `dx −37.47%` → `0.00%`；交叉淡化过渡层 opacity 0.255；夜景双人 + 镜头 1.10。
- 分支、存档、读档：两条选项都进入对应句子并汇合；第 34 句存档 → 返回标题 → 继续，位移/缩放/背景哈希全部还原。
- 三处终态一致：编辑器试玩 / 单文件 HTML / 独立游戏在同一句归一化后逐项相等（`c_you dx 6.00 · scale 1.04`）。

### 说明

- 导出走项目内的 `game-builder`（复制当前 Electron 运行时 + rcedit），不经过 electron-builder，
  因此不受本机 safe-delete 钩子影响。
- 仍未验证：1 GiB 级工程带演出的目录版导出；游戏目录版的代码签名。

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
- **《晚风》演出样板（M6）**：`scripts/build-wanfeng-v08.cjs` 在隔离副本上生成三场景 40 句 / 58 动作 /（含一个分支）
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
- 《晚风》演出样板：40 句 / 58 动作 / 预计 154 秒；单文件试玩 29.6 MB（单 `<script>`，含演出运行时）；
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
