'use strict';
/* 播放器交互修复的静态约束（V0.7.2 P0）。
 * 真实鼠标行为由 scripts/player-interaction-acceptance.cjs 在窗口里验；
 * 这里钉住「规则写在哪、有没有波及创作模式、有没有用 pointer-events 一刀切」。 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const player = read('dist/player.js');
const exporter = read('dist/export.js');
const editorCss = read('dist/style.css');
const app = read('dist/app.js');
const gameHtml = read('dist/game-html.js');

/* 1. 播放器 CSS：容器级禁选 + 图片禁拖 + 输入控件例外 */
assert(/const paperPlayerCSS=`[^`]*#titleScreen,#gameRoot,\.overlay,#msg\{-webkit-user-select:none;user-select:none/.test(player),
  '播放器要在容器上禁用文本选择');
assert(/#titleScreen img,#gameRoot img,\.overlay img\{-webkit-user-drag:none/.test(player),
  '展示图片要禁用 -webkit-user-drag');
assert(/#titleScreen input,#gameRoot input,#titleScreen textarea,#gameRoot textarea,\.overlay input,\.overlay textarea,\.overlay select\{-webkit-user-select:text/.test(player),
  '设置面板里的输入控件必须恢复可选中');
assert(!/\{[^}]*pointer-events:none[^}]*\}[^`]*#gameRoot/.test(player.split('const paperPlayerCSS=`')[1].split('`')[0]),
  '不允许用 pointer-events 禁用整个游戏容器（会连带废掉点击推进）');

/* 2. 运行时图片：图层 img 显式不可拖 + dragstart 兜底 */
assert(/im\.draggable=false/.test(player), '播放器创建的图层图片要设 draggable=false');
assert(/addEventListener\('dragstart',e=>\{/.test(player), '播放器要有 dragstart 兜底');
assert(/closest\('#titleScreen,#gameRoot,\.overlay'\)/.test(player), 'dragstart 兜底要限定在游戏容器内');

/* 3. 静态标题图：HTML 里就不可拖 */
assert(/<img id="titleBgImg" alt="" draggable="false">/.test(exporter), '标题背景图要带 draggable="false"');

/* 4. 点击与拖动区分：位移超过阈值不推进 */
assert(/Math\.hypot\(e\.clientX-pressAt\.x,e\.clientY-pressAt\.y\)>8/.test(player),
  '播放器要区分点击与拖动');
assert(/Math\.hypot\(e\.clientX-stagePress\.x,e\.clientY-stagePress\.y\)>8/.test(app),
  '编辑器试玩要保持同样的点击/拖动区分');

/* 5. 编辑器只在试玩时禁选，创作模式不受影响 */
assert(/body\.playing #stage,body\.playing #stage \*\{-webkit-user-select:none;user-select:none\}/.test(editorCss),
  '编辑器禁选必须限定在 body.playing');
assert(!/(^|[^.])\b#stage\s*\{[^}]*-webkit-user-select:none/.test(editorCss.replace(/body\.playing[^{]*\{[^}]*\}/g, '')),
  '不能把禁选规则加到创作模式的舞台上');
assert(/body\.playing #stage img\{-webkit-user-drag:none/.test(editorCss), '试玩时图片也不可拖');
assert(!/#line\s*\{[^}]*pointer-events:none/.test(editorCss), '#line 不能靠 pointer-events 禁选');

/* 6. 五处载体共用同一份播放器，不存在第二条拼接路径 */
assert(/buildPlayerHTML/.test(gameHtml) && /require\('\.\/player\.js'\)/.test(gameHtml),
  'HTML 导出/预览/游戏包必须共用同一份播放器');
assert(!/paperPlayerCSS\s*=\s*`[^`]*user-select/.test(read('dist/style.css')), '编辑器样式里不应复制播放器 CSS');

/* 7. 编辑器 HTML 结构没被改动（选项与对话框仍可交互） */
const editorHtml = read('dist/index.html');
assert(/id="choices"/.test(editorHtml) && /id="dialogue"/.test(editorHtml), '编辑器舞台结构保持不变');

console.log('  ok  播放器在容器上禁选、图片禁拖，输入控件保留可选中');
console.log('  ok  拖拽兜底与点击/拖动阈值同时覆盖播放器与编辑器试玩');
console.log('  ok  禁选只作用于 body.playing，创作模式的选中与拖动不受影响');
