# V0.3 Desktop Preview 迁移说明

## 原则

目前导出的是网页项目源码，不是已有桌面工程。实施以复用前端、数据模型与效果播放器为准：新增桌面窗口及文件存储适配层，不先做 V0.4 功能，也不为桌面版重写播放逻辑。

桌面框架选用 Electron；依赖版本、协议处理与打包方式按 npm registry 与官方文档核对后固定（`electron` 45.3.2、`electron-builder` 26.18.0，见 `package-lock.json`）。本次已实现 M0—M3 的主要范围，验证边界见 `docs/ACCEPTANCE.md` 与 `docs/DESKTOP_PREVIEW.md`。

## 实际目录（已建立）

```text
project root/
  desktop/
    main.cjs             # 窗口、菜单、原生对话框、受控 IPC、paper:// 协议
    preload.cjs          # contextBridge 固定通道
    project-store.cjs    # 纯 Node 工程目录读写（可脱离 Electron 测试）
  adapters/              # 以 dist/desktop-bridge.js 实现，未另建目录
  dist/                  # 当前网页编辑器 + export.js + desktop-bridge.js
  scripts/               # 网页服务、检查、桌面启动器、真实窗口烟测
  tests/                 # 原有逻辑测试 + 存储/导出/安全测试
  docs/                  # 路线、验收、限制、交付说明
  release/               # 忽略的打包产物
```

## 用户工程目录（已实现）

```text
我的作品/
  project.paper.json              # format: paper-desktop / formatVersion: 1 / schema: 3
  assets/images/<sha256>.png      # 内容寻址、不可变，永不覆盖或删除
  backups/<时间戳>-<原因>/        # 每次显式保存前的元数据快照
  backups/latest/                 # 最近一次成功写入的主文件副本
  backups/autosave/               # 自动保存副本，异常退出时恢复
```

磁盘格式与运行时格式明确分离：磁盘素材使用 `file` / `sha256` / `bytes` / `mime` 相对路径字段，运行时模型仍是 V0.3 的 `assets[].data` data URL。IO 边界负责解析与重建，因此首轮没有连带改造渲染代码。旧网页 schema 1/2/3 的单文件 `.paper.json` 在导入时校验、迁移、解码，再写入新目录；原文件保持只读。

图片通过 `paper://` 受控协议白名单加载应用自身资源；工程图片在读取时解码为 data URL 交给渲染进程。blob URL 不作为永久工程内容，也不写入离线导出。导出 HTML 由 `dist/export.js` 统一构造，最终内嵌 data URL 素材与同一个 `core.js` / `effects.js` 工厂函数。

备份元数据只引用内容寻址素材，而素材文件从不删除，因此任何历史备份都能解析到对应图片。`backups/latest` 提供最近一次成功保存的完整副本，主文件损坏时优先恢复它。首版仍不自动回收未使用素材。

## 现有函数改造入口（已完成）

| 区域 | 当前实现 | 桌面实现 |
| --- | --- | --- |
| `initialize` / `persist` | IndexedDB 单草稿 | `PaperHost.bootstrap` 启动恢复 + `autoSave` 写 `backups/autosave/`；网页版保留原方式 |
| `pick` / `upload` | 浏览器选图，转 data URL | 原生对话框由主进程读取并校验，preload 返回受控文件对象；素材 ID 内容派生 |
| `loadProject` | 校验、解码、迁移旧 JSON | 保留旧导入能力；桌面目录工程在 IO 边界解析为兼容运行时模型 |
| `download` / `#save` | Blob 下载完整 JSON | `#save` 走受控安全保存；`#saveAs` / `#exportJson` 另行提供；导出文件用原生保存对话框 |
| `#export` | 嵌入数据和工厂函数输出 HTML | 改由 `buildGameHTML` 统一生成，拒绝本地路径素材；仍为自包含 HTML |
| `snapshot` / `restore` | 内存撤销、素材数组引用 | 保持逻辑语义；撤销后触发自动保存 |
| `core.scene` | 脚本/真实路径场景解析 | 未改动分支继承语义 |
| `effects.before/frame/animate` | 确定性效果状态 | 未改动；编辑器与导出播放器继续共用 |

## 里程碑与范围

- M0：跑通原版和测试，建立源码基线 —— 完成（`0b3fddc` 基线提交，工作在 `desktop-preview` 分支）。
- M1：独立窗口，无需开发服务器的打包运行入口 —— 完成（真实 Electron 窗口烟测、正式入口自检、便携版 EXE 实体启动自检均通过，页面来源为 `paper://`）。
- M2：工程目录、旧 JSON 导入、新建/打开/保存/另存为/备份/恢复 —— 完成（测试覆盖中文空格路径、目录迁移、同名图片、注入保存失败、异常退出）。
- M3：保留 HTML 导出，提供 Windows 制作器构建流程与产物 —— 完成（自包含导出测试与窗口实机导出通过；便携版与 NSIS 安装包均已实际生成到 `release/` 并通过启动自检）。
- M4（后续）：独立游戏 EXE、多平台、自动更新和发布流程 —— 未开始。

暂缓：BGM、TTS、好感度、完整时间轴、AI 单图动作生成、云同步、协作编辑。

## Git 与公开发布

源码已初始化为本地独立 Git 项目（基线提交 + `desktop-preview` 分支），未创建远程仓库、未上传代码、未公开素材、未选择开源许可证。最近工程与未关联草稿保存在 Electron `userData` 目录，不进入仓库。远程仓库、许可证与公开素材由用户明确决定，不把「代码能运行」当作「可以公开任何素材」。
