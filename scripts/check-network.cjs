'use strict';
/*
 * 本机网络体检：判断「连不上 GitHub」到底卡在哪一层。
 *
 *   node scripts/check-network.cjs        （或 npm run net:check）
 *
 * 1. 探测 github.com / api / codeload / objects / raw / npm 各自是否可达；
 * 2. 对比 github.com 的 DNS 结果与几个已知边缘 IP，指出是不是「解析到了不通的地址」；
 * 3. 检查 hosts 是否已经固定了 github.com，并给出可直接复制的修复行。
 *
 * 只做探测和打印，不修改 hosts、系统代理或 git 配置。
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;

const TIMEOUT_MS = 8000;
const HOSTS = path.join(process.env.windir || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
/* GitHub 边缘 IP 候选；国内常见可用的几个，顺序即优先级。 */
const EDGE_IPS = ['20.27.177.113', '140.82.112.3', '140.82.113.3', '140.82.114.3'];

const TARGETS = [
  { host: 'github.com', url: 'https://github.com/', note: '网页、git 克隆/推送' },
  { host: 'api.github.com', url: 'https://api.github.com/', note: 'API' },
  { host: 'codeload.github.com', url: 'https://codeload.github.com/', note: '仓库压缩包' },
  { host: 'objects.githubusercontent.com', url: 'https://objects.githubusercontent.com/', note: 'Release 资产下载' },
  { host: 'raw.githubusercontent.com', url: 'https://raw.githubusercontent.com/', note: '原始文件（国内常被阻断）' },
  { host: 'registry.npmjs.org', url: 'https://registry.npmjs.org/', note: 'npm 包' },
  { host: 'npmmirror.com', url: 'https://npmmirror.com/mirrors/electron/', note: 'Electron / 打包工具链镜像' },
  { host: 'cdn.jsdelivr.net', url: 'https://cdn.jsdelivr.net/gh/hjw200775-ops/PaperVNStudio@main/package.json', note: 'raw 文件的 CDN 镜像' },
  { host: 'ghfast.top', url: 'https://ghfast.top/https://raw.githubusercontent.com/hjw200775-ops/PaperVNStudio/main/package.json', note: 'raw 文件的代理镜像' }
];

function request(options) {
  return new Promise(resolve => {
    const started = Date.now();
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ms: Date.now() - started }, result));
    };
    const req = https.request(options, res => {
      const ip = res.socket && res.socket.remoteAddress;
      res.resume();
      res.on('end', () => done({ ok: true, status: res.statusCode, ip }));
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); done({ ok: false, reason: '超时 ' + TIMEOUT_MS + 'ms' }); });
    req.on('error', err => done({ ok: false, reason: err.code || err.message || String(err) }));
    req.end();
  });
}
const probeHost = ({ host, url }) => {
  const u = new URL(url);
  return request({
    method: 'GET', host: u.hostname, port: 443, path: u.pathname + u.search, servername: u.hostname,
    headers: { host: u.hostname, 'user-agent': 'PaperVNStudio-net-check' }
  }).then(r => Object.assign(r, { host }));
};
/* 绕过 DNS，直接连某个 IP，但按 github.com 做 TLS 校验与 Host 头。 */
const probeIp = ip => request({
  method: 'HEAD', host: ip, port: 443, path: '/', servername: 'github.com',
  headers: { host: 'github.com', 'user-agent': 'PaperVNStudio-net-check' }
}).then(r => Object.assign(r, { ip }));

function hostsPin() {
  try {
    const text = fs.readFileSync(HOSTS, 'utf8');
    const m = /^[ \t]*([0-9.]+)[ \t]+github\.com[ \t]*$/m.exec(text);
    return m ? m[1] : null;
  } catch { return undefined; }
}

(async () => {
  console.log('本机网络体检（' + new Date().toLocaleString('zh-CN') + '）\n');
  const results = [];
  for (const target of TARGETS) results.push(await probeHost(target));

  const width = Math.max(...results.map(r => r.host.length)) + 2;
  for (const r of results) {
    const target = TARGETS.find(t => t.host === r.host);
    const status = r.ok ? '可用 HTTP ' + r.status : '不通 ' + r.reason;
    console.log('  ' + r.host.padEnd(width) + status.padEnd(24) + String(Math.min(r.ms, 99999)).padStart(6) + 'ms   ' + target.note);
  }

  /* github.com 专项：DNS 结果 vs 边缘 IP */
  const resolved = await dns.lookup('github.com').catch(() => null);
  const pinned = hostsPin();
  const gh = results.find(r => r.host === 'github.com');
  console.log('\ngithub.com 专项：');
  console.log('  hosts 固定：' + (pinned === undefined ? '（hosts 不可读，需管理员权限）' : pinned || '无'));
  console.log('  实际连接 IP：' + (gh.ip || '未建立连接'));
  if (resolved) console.log('  DNS 解析：' + resolved.address);

  if (!gh.ok) {
    console.log('\n  github.com 不通，逐个试已知边缘 IP：');
    const alive = [];
    for (const ip of EDGE_IPS) {
      const r = await probeIp(ip);
      console.log('    ' + ip.padEnd(16) + (r.ok ? '可用 ' + r.status + '  ' + r.ms + 'ms' : '不通 ' + r.reason));
      if (r.ok) alive.push(ip);
    }
    if (alive.length) {
      console.log('\n  可行修复：把下面一行加进 ' + HOSTS + '（需管理员），然后 ipconfig /flushdns');
      console.log('    ' + alive[0] + '   github.com');
      console.log('  撤销：删掉该行，再 ipconfig /flushdns。若哪天又断，换用：' + alive.slice(1).join(' / '));
    } else {
      console.log('\n  所有边缘 IP 都不通：说明是整体阻断，hosts 无法解决，需要代理或镜像。');
    }
  }

  const down = results.filter(r => !r.ok);
  const mirrors = results.filter(r => ['cdn.jsdelivr.net', 'ghfast.top'].includes(r.host) && r.ok);
  console.log('\n结论：');
  if (!down.length) console.log('  GitHub 各子域与 npm 都可用。');
  else console.log('  不可达：' + down.map(r => r.host).join('、'));
  if (down.some(r => r.host === 'raw.githubusercontent.com')) {
    console.log('  · raw.githubusercontent.com 常被整体阻断，hosts 换 IP 也无效；改用镜像：' +
      (mirrors.length ? mirrors.map(m => m.host).join(' / ') + '，例如 https://ghfast.top/<原 raw 地址>' : '暂无可用镜像'));
  }
  if (down.some(r => r.host === 'objects.githubusercontent.com')) {
    console.log('  · Release 资产不通时，Electron 与打包工具链用 npmmirror 镜像（npm run build:win 已内置）。');
  }
  console.log('  · git 克隆/推送只依赖 github.com：' + (gh.ok ? '当前可用，正常使用，不要长期给 git 设代理。' : '当前不通，先按上面修复。'));
  console.log('\n提示：本脚本不改动任何系统设置。');
  if (down.length) process.exitCode = 1;
})();
