'use strict';
/* Launch the real Electron window. Some AI/IDE terminals export
 * ELECTRON_RUN_AS_NODE=1, which would silently turn Electron into a Node
 * process; strip it for the child so `npm run desktop` always opens a window. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const root = path.resolve(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = process.argv.slice(2);
const smoke = args[0] === '--smoke';
const project = args[0] === '--smoke-project';
const acceptance = args[0] === '--acceptance';
const target = smoke ? path.join(root, 'scripts/desktop-smoke.cjs')
  : project ? path.join(root, 'scripts/desktop-project-smoke.cjs')
  : acceptance ? path.join(root, 'scripts/wanfeng-acceptance.cjs')
  : root;
const child = spawn(electron, [target, ...(smoke || project || acceptance ? args.slice(1) : args)], { env, stdio: 'inherit' });
child.on('error', err => { console.error('无法启动桌面窗口：' + err.message); process.exit(1); });
child.on('exit', code => process.exit(code == null ? 1 : code));
