# PaperVNStudio development instructions

## Purpose

中文、面向无编程基础作者的 Galgame 制作器。V0.3 网页源码为行为基线；下一目标为 Windows 桌面预览版。详见 `AI_START_PROMPT.md` 与 `docs/DESKTOP_MIGRATION.md`。

## Scope and workflow

- 在当前源码上渐进改造，不重写一套新原型。
- 首次修改前运行 `node scripts/check.cjs`。变更后执行相关测试。
- 不随意格式化全部紧凑源码；如果整理结构，单独提交并验证行为一致。
- 保留网页预览和独立 HTML 游戏导出。
- 不把桌面封装、安装包构建与真实 Windows 验收混为一谈。
- 检查并保留用户未提交的文件；不覆盖草稿、素材或本地工程。
- 工程模型、资源路径与文件读写分层；运行时恢复逻辑由编辑器和播放器共用。

## Current architecture

- `core.js`: data validation, schema migration, scene and branch resolution.
- `effects.js`: deterministic effect evaluation and browser rendering.
- `app.js`: editor state, user interactions, persistence, undo and exports.
- `player.js`: standalone game runtime, embedded in exported HTML.
- `index.html` + `style.css`: interface.

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
