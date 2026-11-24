'use strict';
/* V0.8.1-RC2 / M8：标题音乐循环 A/B 试听页（流式 vs 精确），同一素材、同一区间。
 *
 * 用法：node scripts/build-title-ab.cjs
 * 产物：release/wanfeng-v081/标题循环·A-B试听.html
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'release', 'wanfeng-v081', 'audio');
const OUT = path.join(ROOT, 'release', 'wanfeng-v081', '标题循环·A-B试听.html');
const AUDIO_DIR = path.join(PROJECT, 'assets', 'audio');

const p = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.paper.json'), 'utf8'));
const tm = p.titleMusic || {};
const asset = (p.audioAssets || []).find((a) => a.id === tm.audioId);
if (!asset) { console.error('工程里没有标题音乐素材'); process.exit(2); }
const file = path.join(PROJECT, asset.file);
if (!fs.existsSync(file)) { console.error('素材文件不存在：' + file); process.exit(2); }
const mime = /\.ogg$/i.test(file) ? 'audio/ogg' : /\.mp3$/i.test(file) ? 'audio/mpeg' : 'audio/wav';
const data = 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
const start = Number(tm.loopStart) || 0;
const end = Number(tm.loopEnd) || 0;
const audioJs = fs.readFileSync(path.join(ROOT, 'dist', 'audio.js'), 'utf8');
const secs = (ms) => (ms / 1000).toFixed(2);

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>标题音乐循环 · A/B 试听（${start}s–${end}s）</title>
<style>
 :root{--ink:#e8f0ea;--dim:#9fb3a8;--line:#2c4137;--panel:#16241d;--accent:#7ec8a3}
 *{box-sizing:border-box}body{margin:0;background:#0f1915;color:var(--ink);font:14px/1.6 "Segoe UI",system-ui,sans-serif}
 main{max-width:860px;margin:0 auto;padding:32px 24px 64px}
 h1{font-size:20px;margin:0 0 6px}p{color:var(--dim);margin:6px 0}
 .row{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
 button{background:#1e3329;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}
 button:hover{border-color:var(--accent)}button.primary{background:#265c44;border-color:#3c8a67}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0}
 .mode{font:600 13px ui-monospace,monospace;color:var(--accent)}
 table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}
 .bar{height:8px;background:#21362c;border-radius:99px;overflow:hidden;margin:10px 0}
 .bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4f9b76,#9ad9b6)}
 .hint{font-size:12px;color:#7f948a}
 .badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
 .jump{color:#ffd479}
</style></head><body><main>
<h1>标题音乐循环 · A/B 试听</h1>
<p>同一首素材、同一区间 <b>${start}.00s – ${end}.00s</b>，只换播放路径：A 是旧的流式 <code>&lt;audio&gt;</code> +
定时器回跳，B 是精确模式（<code>AudioBufferSourceNode</code> + <code>loopStart/loopEnd</code>）。</p>
<p class="hint">听什么：A 在每次回到 ${start}s 时可能有一小段空白或“咔”一下；B 应当听不出接缝。
播放器不改变音乐本身，也不评价旋律与配器。</p>

<div class="row">
  <button id="a" class="primary">▶ A · 流式循环（旧）</button>
  <button id="b" class="primary">▶ B · 精确循环</button>
  <button id="stop">■ 停止</button>
</div>

<div class="card">
  <div class="mode" id="mode">未播放</div>
  <div class="bar"><i id="prog"></i></div>
  <table>
    <tr><th>播放时间</th><td id="time">—</td><th>循环次数</th><td id="loops">0</td></tr>
    <tr><th>区间</th><td id="region">${start} – ${end}s</td><th>接缝误差</th><td id="seam">—</td></tr>
  </table>
  <p class="hint" id="note">A 的接缝误差来自定时器轮询（60ms 一次）；B 的接缝由音频线程处理，不产生调度空白。</p>
</div>

<div class="card">
  <div class="mode">自动演示</div>
  <p class="hint">依次播放 A 三个完整循环、B 三个完整循环，便于连续对比。</p>
  <div class="row"><button id="auto">▶ 自动 A/B（各 3 个循环）</button></div>
  <p class="hint" id="autoNote">—</p>
</div>

<script>
${audioJs}
const ASSET = ${JSON.stringify(data)};
const REGION = { mode: 'region', start: ${start}, end: ${end} };
const SPAN = Math.max(1, ${end} - ${start});
const A = createPaperAudio();
const $ = (id) => document.getElementById(id);
let engines = {};
function engine(mode) {
  if (!engines[mode]) engines[mode] = A.runtime({
    assetData: () => ASSET, prefs: { master: 1, bgm: 1, sfx: 1, voice: 1 },
    loopMode: mode, onStatus: () => {}
  });
  return engines[mode];
}
let current = null, timer = 0, loops = 0, modeName = '';
function stop() {
  if (current) { try { current.titleStop(0.15); } catch (e) {} }
  current = null; modeName = ''; $('mode').textContent = '已停止';
  $('prog').style.width = '0%';
}
async function play(mode) {
  stop();
  const rt = engine(mode);
  const r = await rt.titlePlay({ audioId: 'title', volume: 1, fadeIn: 0.6, loop: REGION, offset: REGION.start });
  if (!r || !r.ok) { $('mode').textContent = '播放失败：' + ((r && r.reason) || '未知'); return; }
  current = rt; modeName = mode; loops = 0;
  $('mode').textContent = (mode === 'precise' ? 'B · 精确循环' : 'A · 流式循环') +
    ' · 实际模式 ' + r.mode + (r.reason ? '（' + r.reason + '）' : '');
  $('note').textContent = mode === 'precise'
    ? 'B 的循环由音频线程在 loopEnd 处直接接回 loopStart，调度上不产生空白。'
    : 'A 每 60ms 检查一次 currentTime 再回跳，越过 loopEnd 的那段时间就是接缝。';
  clearInterval(timer);
  timer = setInterval(() => {
    const s = rt.titleSnapshot ? rt.titleSnapshot() : null;
    if (!s || !s.playing) return;
    loops = s.loops || 0;
    $('loops').textContent = loops;
    $('time').textContent = (s.time || 0).toFixed(2) + 's / ' + (s.duration || 0).toFixed(1) + 's';
    $('prog').style.width = Math.min(100, ((s.time || 0) / Math.max(1, s.duration || 1)) * 100) + '%';
    $('seam').innerHTML = mode === 'precise'
      ? '<span class="badge">音频线程</span>'
      : '<span class="jump">≤60ms 轮询</span>';
  }, 120);
}
$('a').onclick = () => play('stream');
$('b').onclick = () => play('precise');
$('stop').onclick = stop;
let autoRunning = false;
$('auto').onclick = async () => {
  if (autoRunning) { autoRunning = false; stop(); $('autoNote').textContent = '已中断'; return; }
  autoRunning = true;
  const need = (n) => new Promise((res) => {
    const t = setInterval(() => { if (loops >= n || !autoRunning) { clearInterval(t); res(); } }, 120);
  });
  $('autoNote').textContent = 'A · 流式，等待 3 个完整循环…';
  await play('stream'); await need(3);
  if (!autoRunning) return;
  $('autoNote').textContent = 'B · 精确，等待 3 个完整循环…';
  await play('precise'); await need(3);
  if (!autoRunning) return;
  stop(); $('autoNote').textContent = '自动 A/B 完成：A 3 循环、B 3 循环。';
  autoRunning = false;
};
window.__abState = () => ({ mode: modeName, loops, snapshot: current ? current.snapshot() : null });
</script>
</main></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(JSON.stringify({ out: path.relative(ROOT, OUT).split(path.sep).join('/'), bytes: fs.statSync(OUT).size,
  region: [start, end], asset: asset.name, sampleRateHint: 'browser' }, null, 1));
