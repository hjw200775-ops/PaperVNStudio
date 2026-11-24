'use strict';
/*
 * V0.8.1-RC3 · 音乐循环 A/B/C/D 人工试听页（M6）
 *
 * 自包含 HTML，双击即可打开，无需开发环境、断网可用。
 * 同一份标题曲《晚风经过二楼走廊》，四种循环方案快速切换：
 *   A 现有区间（6.0–14.0s，上一轮随手拍的区间，对照基线）
 *   B 整曲自然循环（0–37.794s，曲尾淡出接曲首）
 *   C 乐句匹配循环（6.4–30.5s，跳过前奏与尾声，循环主乐段）
 *   D 可选循环交叉淡化（整曲循环 + 循环点等功率交叉淡化，20/50/100/200/500ms）
 *
 * 支持盲听（隐藏方案名）、每方案 3 个完整循环、单独重复循环边界、进度与边界标记、
 * 试听评价表（自然度 1–5 / 循环是否明显 / 停顿爆音 / 是否适合标题 / 倾向方案 / 意见）。
 * 不预设哪个更好。
 *
 * 用法：node scripts/build-loop-abcd.cjs
 * 产物：release/wanfeng-v081rc3/晚风·循环方案ABCD试听.html
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'dist', 'samples', 'wanfeng-ch01', 'assets', 'audio');
const TITLE_OGG = path.join(AUDIO_DIR, '2217366c9255ecbddcbbf811f23c79e8fd5a15bb24e2cb530789aaaf9563e7ae.ogg');
const AUDIT = path.join(ROOT, 'release', 'audio-loop-audit.json');
const OUT = path.join(ROOT, 'release', 'wanfeng-v081rc3', '晚风·循环方案ABCD试听.html');

const DUR = 37.794;
const SCHEMES = {
  A: { label: 'A · 现有区间', desc: '上一轮设置的 6.0–14.0s 区间（无音乐依据，作为对照基线）', loop: { start: 6.0, end: 14.0 }, crossfade: 0 },
  B: { label: 'B · 整曲循环', desc: '整曲 0–37.794s，曲尾淡出自然接曲首淡入', loop: { start: 0, end: DUR, all: true }, crossfade: 0 },
  C: { label: 'C · 乐句匹配', desc: '6.4–30.5s，跳过稀疏前奏（0–6.4s）与尾声淡出（30.5–37.8s），循环主乐段', loop: { start: 6.4, end: 30.5 }, crossfade: 0 },
  D: { label: 'D · 交叉淡化', desc: '整曲循环 + 循环点等功率交叉淡化（可调 20–500ms），用淡化掩盖曲尾→曲首的接缝', loop: { start: 0, end: DUR, all: true }, crossfade: 50 }
};
const CF_OPTIONS = [20, 50, 100, 200, 500];

const oggB64 = fs.readFileSync(TITLE_OGG).toString('base64');
const mime = 'audio/ogg';
const dataUrl = 'data:' + mime + ';base64,' + oggB64;

// 尝试读取预计算波形（若无则页面内自行解码绘制）
let waveform = null;
try { const a = JSON.parse(fs.readFileSync(AUDIT, 'utf8')); if (a.assets && a.assets.title && a.assets.title.waveform) waveform = a.assets.title.waveform; } catch (e) {}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>《晚风经过二楼走廊》标题音乐循环 · A/B/C/D 试听</title>
<style>
 :root{--ink:#e8f0ea;--dim:#9fb3a8;--line:#2c4137;--panel:#16241d;--accent:#7ec8a3;--warn:#ffd479}
 *{box-sizing:border-box}body{margin:0;background:#0f1915;color:var(--ink);font:14px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
 main{max-width:920px;margin:0 auto;padding:28px 20px 80px}
 h1{font-size:20px;margin:0 0 4px}h1 small{font-weight:400;color:var(--dim);font-size:13px}
 .sub{color:var(--dim);margin:4px 0 18px;font-size:13px}
 section{margin:20px 0}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
 button{background:#1e3329;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer}
 button:hover{border-color:var(--accent)}button.primary{background:#265c44;border-color:#3c8a67}
 button.active{background:#3c8a67;border-color:#7ec8a3;color:#fff}
 button:disabled{opacity:.4;cursor:not-allowed}
 .scheme{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
 .scheme .lbl{font-weight:600}
 .scheme .desc{font-size:12px;color:var(--dim);line-height:1.5}
 .wave{position:relative;margin:8px 0 4px}
 canvas{width:100%;height:90px;display:block;background:#0d1813;border:1px solid var(--line);border-radius:8px}
 .mark{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);pointer-events:none;opacity:.85}
 .mark.tick{width:1px;background:#4c6b5c}
 .mark .tag{position:absolute;top:2px;font-size:10px;color:var(--accent);white-space:nowrap;transform:translateX(-50%)}
 .mark.end .tag{color:var(--warn)}
 .bar{height:8px;background:#21362c;border-radius:99px;overflow:hidden;margin:8px 0}
 .bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4f9b76,#9ad9b6)}
 table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left}
 .hint{font-size:12px;color:#7f948a}
 .badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
 .chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
 .chip{background:#1e3329;border:1px solid var(--line);border-radius:99px;padding:4px 12px;font-size:13px;cursor:pointer}
 .chip.active{background:#265c44;border-color:#3c8a67}
 label.field{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim)}
 select,input[type=number],textarea{background:#0d1813;border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:6px 8px;font:inherit}
 textarea{width:100%;min-height:64px;resize:vertical}
 .eval td:first-child{width:120px;color:var(--dim)}
 .stars{display:flex;gap:4px}
 .stars button{width:32px;height:32px;padding:0;border-radius:6px}
 .stars button.on{background:#265c44;border-color:#3c8a67}
 .result{white-space:pre-wrap;font:12px/1.6 ui-monospace,monospace;background:#0d1813;border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:8px;color:var(--dim)}
 .note{font-size:12px;color:#7f948a;border-left:3px solid var(--line);padding-left:10px;margin:10px 0}
</style></head><body><main>
<h1>《晚风经过二楼走廊》标题音乐循环 <small>· A/B/C/D 人工试听</small></h1>
<p class="sub">同一首素材、同一试听音量，四种循环方案。先不告诉你哪个好——请按你的真实听感评价。</p>

<section class="card">
  <div class="hint" id="playState">未播放</div>
  <div class="wave" id="waveWrap"><canvas id="wave" height="90"></canvas></div>
  <div class="bar"><i id="prog"></i></div>
  <table>
    <tr><th>播放时间</th><td id="time">—</td><th>循环次数</th><td id="loops">0</td><th>区间</th><td id="region">—</td></tr>
  </table>
  <div class="chips" id="schemes"></div>
  <div class="chips">
    <button id="stop">■ 停止</button>
    <button id="boundary">⟳ 单独重复循环边界（前后各 2s）</button>
    <button id="blind">盲听：隐藏方案名</button>
  </div>
  <div class="chips" id="cfRow" style="display:none">
    <span class="hint" style="line-height:32px">D 交叉淡化时长：</span>
  </div>
  <p class="note" id="note">每方案默认连播 3 个完整循环。A/B/C 使用与发布游戏「精确循环」相同的音频线程 loopStart/loopEnd；D 在循环点做等功率交叉淡化。</p>
</section>

<section class="card">
  <h2 style="font-size:15px;margin:0 0 6px">技术参数</h2>
  <table id="params"></table>
</section>

<section class="card eval">
  <h2 style="font-size:15px;margin:0 0 6px">试听评价表</h2>
  <table>
    <tr><td>当前方案</td><td id="evalScheme">—</td></tr>
    <tr><td>自然程度</td><td><div class="stars" id="natural">${[1,2,3,4,5].map(i=>'<button data-v="'+i+'">'+i+'</button>').join('')}</div></td></tr>
    <tr><td>能否听出循环</td><td><label><input type="radio" name="loopNotable" value="是"> 是，明显跳一下</label> <label style="margin-left:12px"><input type="radio" name="loopNotable" value="否"> 否，很自然</label></td></tr>
    <tr><td>停顿/爆音/突兀</td><td><label><input type="radio" name="glitch" value="有"> 有</label> <label style="margin-left:12px"><input type="radio" name="glitch" value="无"> 无</label></td></tr>
    <tr><td>适合做标题音乐长时间播放</td><td><label><input type="radio" name="fitTitle" value="适合"> 适合</label> <label style="margin-left:12px"><input type="radio" name="fitTitle" value="不适合"> 不适合</label></td></tr>
    <tr><td>意见</td><td><textarea id="comment" placeholder="旋律是否被截断、和声是否衔接自然、有没有叠音/音量突变……"></textarea></td></tr>
  </table>
  <div class="chips">
    <button class="primary" id="saveEval">记录本方案评价</button>
    <button id="exportEval">导出全部评价</button>
    <button id="clearEval">清空</button>
  </div>
  <div class="result" id="evalOut">尚未记录评价。</div>
</section>
</main>
<script>
const OGG = ${JSON.stringify(dataUrl)};
const DUR = ${DUR};
const SCHEMES = ${JSON.stringify(SCHEMES)};
const CF_OPTIONS = ${JSON.stringify(CF_OPTIONS)};
const $ = id => document.getElementById(id);

let ctx = null, buffer = null, current = null, playState = null, evals = {}, blind = false, cfMs = 50;
let currentScheme = null, order = ['A','B','C','D'];

function fmt(s){ s=Math.max(0,s); const m=Math.floor(s/60); return m+':'+String(Math.floor(s%60)).padStart(2,'0')+'.'+String(Math.floor((s%1)*10)); }

/* —— 解码一次，全局复用 —— */
async function ensureAudio(){
  if(buffer) return;
  ctx = ctx || new (window.AudioContext||window.webkitAudioContext)();
  const arr = await (await fetch(OGG)).arrayBuffer();
  buffer = await ctx.decodeAudioData(arr.slice(0));
  drawWave();
  drawParams();
}

/* —— 波形 + 边界标记 —— */
function drawWave(){
  const cv = $('wave'), c2 = cv.getContext('2d');
  const w = cv.width = cv.clientWidth * (window.devicePixelRatio||1);
  const h = cv.height = 90 * (window.devicePixelRatio||1);
  const d = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(d.length / w));
  c2.fillStyle = '#0d1813'; c2.fillRect(0,0,w,h);
  c2.strokeStyle = '#4f9b76'; c2.lineWidth = 1;
  c2.beginPath();
  for(let x=0;x<w;x++){
    let peak=0; const s=x*step;
    for(let i=0;i<step;i++){ const v=Math.abs(d[s+i]); if(v>peak)peak=v; }
    const y = h/2 - peak * (h/2 - 4);
    x===0 ? c2.moveTo(x,y) : c2.lineTo(x,y);
  }
  c2.stroke();
  window.__waveStep = step;
}
function xOf(sec){ return (sec / buffer.duration) * $('wave').clientWidth; }
function drawMarks(){
  const w = $('waveWrap');
  w.querySelectorAll('.mark').forEach(m=>m.remove());
  const s = currentScheme ? SCHEMES[currentScheme].loop : null;
  if(!s) return;
  const pts = s.all ? [[0,'曲首'],[DUR,'曲尾']] : [[s.start,'起点'],[s.end,'终点']];
  pts.forEach(([sec,tag],i)=>{
    const m = document.createElement('div'); m.className = 'mark'+(i===1?' end':'');
    m.style.left = (sec/buffer.duration*100)+'%';
    m.innerHTML = '<span class="tag">'+tag+' '+sec.toFixed(1)+'s</span>';
    w.appendChild(m);
  });
}

/* —— 播放器：A/B/C 用原生 loopStart/loopEnd（与发布游戏精确循环一致）—— */
function startNative(schemeKey){
  const s = SCHEMES[schemeKey];
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const g = ctx.createGain(); g.gain.value = 1;
  src.connect(g); g.connect(ctx.destination);
  if(s.loop.all){ src.loop = true; }
  else { src.loop = true; src.loopStart = s.loop.start; src.loopEnd = s.loop.end; }
  src.start(0, s.loop.all ? 0 : s.loop.start);
  const span = s.loop.all ? buffer.duration : (s.loop.end - s.loop.start);
  return { src, g, span, scheme: schemeKey, kind:'native' };
}

/* —— D：循环点等功率交叉淡化（两段交替，重叠区等功率此消彼长）—— */
function startCrossfade(schemeKey, cfMs){
  const s = SCHEMES[schemeKey];
  const cf = cfMs / 1000;
  const span = s.loop.all ? buffer.duration : (s.loop.end - s.loop.start);
  const loopStart = s.loop.start;
  const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  let stopFlag = false, timer = null, sources = [];
  const now = ctx.currentTime;
  function schedule(at){
    if(stopFlag) return;
    const src = ctx.createBufferSource(); src.buffer = buffer;
    const g = ctx.createGain();
    const segStart = at, segEnd = at + span;
    g.gain.setValueAtTime(0, segStart);
    g.gain.linearRampToValueAtTime(1, segStart + cf);
    g.gain.setValueAtTime(1, segEnd - cf);
    g.gain.linearRampToValueAtTime(0, segEnd);
    src.connect(g); g.connect(master);
    try { src.start(segStart, loopStart, span + 0.05); } catch(e){}
    try { src.stop(segEnd + 0.1); } catch(e){}
    sources.push(src);
    const delayMs = Math.max(30, (span - cf) * 1000 - 40);
    timer = setTimeout(()=>schedule(segEnd - cf), delayMs);
  }
  schedule(now + 0.05);
  return { src:null, g:master, span, scheme: schemeKey, kind:'crossfade', cf, stopInner:()=>{ stopFlag=true; clearTimeout(timer); sources.forEach(s=>{try{s.stop()}catch(e){}}); try{master.disconnect()}catch(e){} } };
}

function stopPlay(){
  if(current){ try{ if(current.src) current.src.stop(); }catch(e){} if(current.stopInner) current.stopInner(); if(current.g){ try{current.g.disconnect()}catch(e){} } }
  current = null; playState = null;
  $('playState').textContent = '已停止'; $('prog').style.width='0%'; $('loops').textContent='0';
  document.querySelectorAll('#schemes button').forEach(b=>b.classList.remove('active'));
}
function playScheme(key){
  if(!buffer) return;
  stopPlay();
  currentScheme = key;
  const s = SCHEMES[key];
  const useCf = key==='D';
  current = useCf ? startCrossfade(key, cfMs) : startNative(key);
  playState = { key, startAt: ctx.currentTime, span: current.span, loops: 0, lastPhase: 0 };
  $('playState').textContent = (blind?('方案 '+ (order.indexOf(key)+1)) : s.label) + ' · 播放中（3 个完整循环）';
  $('region').textContent = s.loop.all ? '整曲 0–'+DUR+'s' : s.loop.start+'–'+s.loop.end+'s';
  $('evalScheme').textContent = blind?('方案 '+ (order.indexOf(key)+1)) : s.label;
  $('note').textContent = useCf
    ? 'D 在循环点做 '+cfMs+'ms 等功率交叉淡化，用淡化掩盖曲尾→曲首的接缝。'
    : 'A/B/C 使用与发布游戏「精确循环」相同的音频线程 loopStart/loopEnd。';
  $('cfRow').style.display = key==='D'?'flex':'none';
  document.querySelectorAll('#schemes button').forEach(b=>b.classList.toggle('active', b.dataset.key===key));
  drawMarks();
  rAF();
}
function rAF(){
  if(!playState || !current){ return; }
  const span = playState.span;
  const t = ctx.currentTime - playState.startAt;
  const phase = span>0 ? (t % span) : 0;
  if(phase < playState.lastPhase){ playState.loops++; if(playState.loops >= 3){ stopPlay(); $('playState').textContent='已播完 3 个循环，请评价或换下一方案。'; return; } }
  playState.lastPhase = phase;
  const s = SCHEMES[currentScheme];
  const absTime = s.loop.all ? phase : s.loop.start + phase;
  $('time').textContent = fmt(absTime)+' / '+fmt(buffer.duration);
  $('loops').textContent = playState.loops;
  $('prog').style.width = Math.min(100, (absTime / buffer.duration)*100)+'%';
  requestAnimationFrame(rAF);
}

/* —— 单独重复循环边界 —— */
function boundaryLoop(){
  if(!buffer) return;
  stopPlay();
  const s = SCHEMES[currentScheme||'A'];
  const seg = { start: Math.max(0, s.loop.end - 2), end: Math.min(buffer.duration, s.loop.end + 2) };
  const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
  src.loopStart = seg.start; src.loopEnd = seg.end;
  const g = ctx.createGain(); g.gain.value = 1; src.connect(g); g.connect(ctx.destination);
  src.start(0, seg.start);
  current = { src, g, span: seg.end-seg.start, scheme: currentScheme, kind:'boundary', stopInner:null };
  playState = { key: currentScheme, startAt: ctx.currentTime, span: seg.end-seg.start, loops:0, lastPhase:0 };
  $('playState').textContent = '重复循环边界 '+seg.start.toFixed(1)+'s–'+seg.end.toFixed(1)+'s（听接缝是否自然）';
  $('region').textContent = seg.start+'–'+seg.end+'s';
  rAF();
}

/* —— 盲听 —— */
function setBlind(on){
  blind = on;
  $('blind').textContent = on ? '盲听中：显示方案名' : '盲听：隐藏方案名';
  document.querySelectorAll('#schemes button').forEach(b=>{
    const k=b.dataset.key;
    b.querySelector('.lbl').textContent = on ? ('方案 '+ (order.indexOf(k)+1)) : SCHEMES[k].label;
    b.querySelector('.desc').textContent = on ? '（盲听中，暂不透露区间）' : SCHEMES[k].desc;
  });
  document.querySelectorAll('#params tr').forEach((tr,idx)=>{ if(idx>0 && on) tr.cells[0].textContent = '方案 ' + order.indexOf(tr.dataset.key); });
  if(currentScheme){ $('playState').textContent = (blind?('方案 '+(order.indexOf(currentScheme)+1)):SCHEMES[currentScheme].label)+' · 播放中'; $('evalScheme').textContent = blind?('方案 '+(order.indexOf(currentScheme)+1)):SCHEMES[currentScheme].label; }
  drawParams();
}

/* —— 技术参数表 —— */
function drawParams(){
  const tb = $('params'); tb.innerHTML = '<tr><th>方案</th><th>区间</th><th>循环方式</th><th>说明</th></tr>';
  order.forEach(k=>{
    const s = SCHEMES[k];
    const name = blind ? ('方案 '+order.indexOf(k)) : s.label;
    const region = s.loop.all ? '整曲 0–'+DUR+'s' : s.loop.start+'–'+s.loop.end+'s';
    const way = k==='D' ? ('循环点等功率交叉淡化 '+cfMs+'ms') : '音频线程 loopStart/loopEnd';
    const tr = document.createElement('tr'); tr.dataset.key = k;
    tr.innerHTML = '<td>'+name+'</td><td>'+region+'</td><td>'+way+'</td><td>'+s.desc+'</td>';
    tb.appendChild(tr);
  });
}

/* —— 评价记录 —— */
function buildEval(){
  const nat = document.querySelector('#natural button.on');
  const radio = name => { const el = document.querySelector('input[name='+name+']:checked'); return el?el.value:'（未填）'; };
  return {
    scheme: currentScheme ? (blind?('方案 '+order.indexOf(currentScheme)):SCHEMES[currentScheme].label) : '—',
    natural: nat ? nat.dataset.v : '（未填）',
    loopNotable: radio('loopNotable'),
    glitch: radio('glitch'),
    fitTitle: radio('fitTitle'),
    comment: $('comment').value.trim()
  };
}
$('saveEval').onclick = ()=>{ const key = currentScheme||'—'; evals[key]=buildEval(); $('evalOut').textContent = '已记录 '+(Object.keys(evals).length)+' 条：\\n'+JSON.stringify(evals,null,2); };
$('exportEval').onclick = ()=>{ const e=buildEval(); if(currentScheme) evals[currentScheme]=e; const txt=JSON.stringify(evals,null,2); navigator.clipboard && navigator.clipboard.writeText(txt); $('evalOut').textContent = txt; };
$('clearEval').onclick = ()=>{ evals={}; $('evalOut').textContent='已清空。'; document.querySelectorAll('#natural button').forEach(b=>b.classList.remove('on')); document.querySelectorAll('input[type=radio]').forEach(r=>r.checked=false); $('comment').value=''; };

/* —— 事件绑定 —— */
document.querySelectorAll('#natural button').forEach(b=>b.onclick=()=>{ document.querySelectorAll('#natural button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); });
const sRow = $('schemes');
order.forEach(k=>{
  const s = SCHEMES[k];
  const b = document.createElement('button'); b.className='scheme'; b.dataset.key=k;
  b.innerHTML = '<span class="lbl">'+s.label+'</span><span class="desc">'+s.desc+'</span>';
  b.onclick = ()=>playScheme(k);
  sRow.appendChild(b);
});
$('stop').onclick = stopPlay;
$('boundary').onclick = boundaryLoop;
$('blind').onclick = ()=>setBlind(!blind);
CF_OPTIONS.forEach(ms=>{
  const c = document.createElement('button'); c.className='chip'+(ms===cfMs?' active':''); c.textContent=ms+'ms';
  c.onclick = ()=>{ cfMs=ms; document.querySelectorAll('#cfRow .chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); if(currentScheme==='D') playScheme('D'); drawParams(); };
  $('cfRow').appendChild(c);
});

window.__abxState = ()=>({ scheme: currentScheme, loops: playState?playState.loops:0, evals, blind, cfMs });

/* 首次进入自动解码并准备 */
ensureAudio().then(()=>{ $('playState').textContent = '已就绪，点击上方任一方案开始试听。'; });
</script></main></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(JSON.stringify({ out: path.relative(ROOT, OUT).split(path.sep).join('/'), bytes: fs.statSync(OUT).size, schemes: Object.keys(SCHEMES), waveformPrecomputed: !!waveform }, null, 1));
