'use strict';
/*
 * V0.8.2-M0 / M0-5：时间轴技术原型（最小可交互预览）。
 *
 * 把现有演出动作（角色进场 + 背景交叉淡化并行 + 镜头推进 + BGM 淡入 + 延迟 SFX）
 * 物化成带绝对时间的多轨片段，提供一个可拖动的播放头，观察任意时刻的舞台状态。
 * 拖动播放头只做 stateAt 求值，不重放历史一次性音效/配音；正常播放才在正确时机触发。
 *
 * 用法：node scripts/build-timeline-prototype.cjs
 * 产物：release/v082m0/timeline-prototype.html（双击即开）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'v082m0', 'timeline-prototype.html');
const perfJs = fs.readFileSync(path.join(ROOT, 'dist', 'performance.js'), 'utf8');
const tlJs = fs.readFileSync(path.join(ROOT, 'dist', 'timeline.js'), 'utf8');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>V0.8.2-M0 · 时间轴技术原型</title>
<style>
 :root{--ink:#e8f0ea;--dim:#9fb3a8;--line:#2c4137;--panel:#16241d;--bg:#0f1915;--accent:#7ec8a3}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
 main{max-width:980px;margin:0 auto;padding:24px 20px 60px}
 h1{font-size:18px;margin:0 0 4px}p.sub{color:var(--dim);margin:0 0 18px;font-size:13px}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
 .kv{font-size:13px}.kv b{color:var(--accent);font-weight:600}
 .kv .dim{color:var(--dim)}
 .tl{display:flex;margin-top:4px}
 .lanes{flex:1;position:relative;overflow:hidden}
 .ruler{position:relative;height:22px;border-bottom:1px solid var(--line);margin-left:0}
 .ruler span{position:absolute;top:4px;font-size:10px;color:var(--dim);transform:translateX(-50%)}
 .lane{position:relative;height:34px;border-bottom:1px solid #22352c}
 .lane .name{position:absolute;left:0;top:8px;width:88px;font-size:12px;color:var(--dim);padding-right:8px;text-align:right}
 .clip{position:absolute;height:20px;top:7px;border-radius:5px;border:1px solid #0006;font-size:10px;line-height:20px;padding:0 6px;overflow:hidden;white-space:nowrap;color:#0f1915;cursor:default}
 .ph{position:absolute;top:0;bottom:0;width:2px;background:var(--ink);z-index:5;pointer-events:none}
 .ph::after{content:'';position:absolute;top:0;left:-5px;width:12px;height:12px;background:var(--ink);border-radius:3px 3px 0 0}
 .pad{position:absolute;inset:0;cursor:crosshair;z-index:6}
 .bar{height:8px;background:#21362c;border-radius:99px;overflow:hidden;margin:8px 0}
 .bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4f9b76,#9ad9b6)}
 .row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
 button{background:#1e3329;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
 button:hover{border-color:var(--accent)}button.primary{background:#265c44;border-color:#3c8a67}
 .hint{font-size:12px;color:#7f948a}
 .fxlog{font:12px/1.7 ui-monospace,monospace;color:var(--dim);background:#0d1813;border:1px solid var(--line);border-radius:8px;padding:8px;min-height:48px;margin-top:8px;white-space:pre-wrap}
 .tags{font-size:11px;color:var(--dim);margin-top:4px}
</style></head><body><main>
<h1>V0.8.2-M0 · 可视化多轨演出时间轴 · 技术原型</h1>
<p class="sub">把「角色进场 + 背景交叉淡化（并行）+ 镜头推进 + BGM 淡入 + 延迟音效」物化成多轨片段；拖动播放头观察任意时刻状态。</p>

<div class="card">
 <div class="grid" id="state"></div>
 <div class="bar"><i id="prog"></i></div>
 <div class="row">
  <button class="primary" id="play">▶ 播放</button><button id="reset">⟲ 回到 0</button>
  <span class="hint" id="timeLbl">t = 0.00s / 5.20s</span>
 </div>
 <div class="hint">拖动下方时间轴上的任意位置移动播放头。拖动只做 <code>stateAt()</code> 求值，<b>不重放</b>历史音效/配音；只有「▶ 播放」才会在正确时机触发一次性音频。</div>
</div>

<div class="card">
 <div class="tl" id="tl"><div class="lanes" id="lanes"></div></div>
 <div class="tags" id="tags"></div>
</div>

<div class="card">
 <div class="hint">正常播放时触发的一次性音频（SFX/Voice）日志——拖动播放头不会产生这些条目：</div>
 <div class="fxlog" id="fxlog">（未播放）</div>
</div>
</main>
<script>${perfJs}</script>
<script>${tlJs}</script>
<script>
const PF = createPaperPerformance();
const TL = createTimeline(PF);
const $ = (id) => document.getElementById(id);

/* —— M0-5 要求的演出组合 —— */
const actions = [
  PF.make('a1','character.show','char:lin',{params:{side:'left'},duration:1.0,blocking:true}),
  PF.make('a2','background.change','bg',{params:{assetId:'bg2',transition:'crossfade'},duration:0.8,mode:'parallel'}),
  PF.make('a3','camera.zoom','',{params:{scale:110},duration:1.4,mode:'after'}),
  PF.make('a4','audio.bgm.play','',{params:{audioId:'bgm1',volume:80,fadeIn:2,loopMode:'all'},duration:2,mode:'after'}),
  PF.make('a5','audio.sfx.play','',{params:{audioId:'sfx1',volume:100,key:'chime'},duration:0.3,mode:'after',delay:0.5})
];
const layers = [{id:'l_lin',name:'林悠',kind:'char',characterId:'lin',x:50,y:70},{id:'l_bg',name:'背景',kind:'bg'}];
const P = { characters:[{id:'lin',expressions:[]}], assets:[], audioAssets:[] };
const ctx = { P, layers };
const before = PF.emptyState();
const events = TL.toTimeline(actions);
const total = TL.totalDuration(actions);
const BLOCK = TL.blockUntil(actions);

/* —— 轨道与片段渲染 —— */
const COLORS = { '角色·lin':'#e7a2a2', '背景':'#8fb99b', '镜头':'#9ab8e7', 'BGM':'#e7c98a', 'SFX':'#c9a2e7', '等待':'#999' };
const lanesEl = $('lanes');
const tracks = [...new Set(events.map(e=>e.track))];
let laneHeightTotal = 0;
function buildLanes(){
  lanesEl.innerHTML='';
  const ruler=document.createElement('div');ruler.className='ruler';
  for(let t=0;t<=Math.ceil(total);t++){const s=document.createElement('span');s.style.left=(t/total*100)+'%';s.textContent=t+'s';ruler.appendChild(s)}
  lanesEl.appendChild(ruler);
  tracks.forEach(track=>{
    const lane=document.createElement('div');lane.className='lane';
    const name=document.createElement('div');name.className='name';name.textContent=track;lane.appendChild(name);
    const inner=document.createElement('div');inner.style.cssText='position:absolute;left:90px;right:0;top:0;bottom:0';
    events.filter(e=>e.track===track).forEach(e=>{
      const c=document.createElement('div');c.className='clip';
      c.style.left=(e.start/total*100)+'%';c.style.width=Math.max(2,(e.duration/total*100))+'%';
      c.style.background=COLORS[track]||'#7ec8a3';
      const nm=(PF.TYPES[e.type]||{name:e.type}).name;
      c.textContent=nm+' '+(e.oneShot?'♪':'');
      c.title=e.type+' ['+e.start+'s–'+e.end+'s]'+(e.blocking?' · 阻塞':'');
      inner.appendChild(c);
    });
    lane.appendChild(inner);lanesEl.appendChild(lane);
  });
  const ph=document.createElement('div');ph.className='ph';ph.id='ph';lanesEl.appendChild(ph);
  const pad=document.createElement('div');pad.className='pad';pad.id='pad';lanesEl.appendChild(pad);
  laneHeightTotal = ruler.offsetHeight + tracks.length*34;
  // 拖动播放头
  let dragging=false;
  const move=e=>{if(!dragging)return;const r=lanesEl.getBoundingClientRect();setT(Math.max(0,Math.min(total,(e.clientX-r.left)/r.width*total)));};
  pad.addEventListener('pointerdown',e=>{dragging=true;pad.setPointerCapture(e.pointerId);move(e)});
  pad.addEventListener('pointermove',move);
  pad.addEventListener('pointerup',()=>{dragging=false});
  pad.addEventListener('pointercancel',()=>{dragging=false});
}
buildLanes();

/* —— 状态求值 + 展示 —— */
function pct(v){return Math.round((v==null?0:v)*100)+'%'}
function setT(t){
  curT=t;
  const st = TL.scrubState(before, actions, t, ctx);
  const ch = st.layers['l_lin']||{};
  $('state').innerHTML =
    '<div class="kv"><b>'+pct(ch.opacity)+'</b><div class="dim">林悠 透明度</div></div>'+
    '<div class="kv"><b>'+(st.camera.scale||1).toFixed(2)+'×</b><div class="dim">镜头缩放</div></div>'+
    '<div class="kv"><b>'+(st.audio.bgm?('bgm1 · '+pct(st.audio.bgm.volume)):'—')+'</b><div class="dim">背景音乐</div></div>'+
    '<div class="kv"><b>'+(st.layers['l_bg']&&st.layers['l_bg'].assetId==='bg2'?'bg2':(st.layers['l_bg']&&st.layers['l_bg'].assetId||'bg 原'))+'</b><div class="dim">背景</div></div>'+
    '<div class="kv"><b>'+pct(st.screen.dim)+'</b><div class="dim">屏幕渐暗</div></div>';
  $('ph').style.left=(t/total*100)+'%';
  $('prog').style.width=(t/total*100)+'%';
  $('timeLbl').textContent='t = '+t.toFixed(2)+'s / '+total.toFixed(2)+'s'+(t>=BLOCK?' · 阻塞结束':'');
}
let curT=0,playing=false,raf=0,lastFx=-1;
function fxAt(t){const hit=TL.audioSideEffectsAt(actions,t);return hit;}
function tick(){
  if(!playing)return;
  curT+=0.02;
  if(curT>=total){curT=total;stopPlay();}
  const hit=TL.audioSideEffectsAt(actions,curT-0.02);
  hit.forEach(h=>{ if(h.action.id!==lastFx){ lastFx=h.action.id; logFx('触发 '+(PF.TYPES[h.action.type]||{}).name+' @ '+h.start.toFixed(2)+'s ('+(h.action.params.key||h.action.params.audioId||'')+')'); } });
  setT(curT);
  raf=requestAnimationFrame(tick);
}
function logFx(s){$('fxlog').textContent+=String.fromCharCode(10)+s}
function play(){if(playing)return;playing=true;lastFx=-1;$('fxlog').textContent='（播放中）';raf=requestAnimationFrame(tick);$('play').textContent='⏸ 暂停'}
function stopPlay(){playing=false;cancelAnimationFrame(raf);$('play').textContent='▶ 播放'}
$('play').onclick=()=>playing?stopPlay():play();
$('reset').onclick=()=>{stopPlay();setT(0);lastFx=-1;$('fxlog').textContent='（未播放）'};
setT(0);
window.__protoState=()=>({t:curT,total,tracks,events:events.map(e=>({id:e.id,track:e.track,start:e.start,end:e.end,oneShot:e.oneShot}))});
</script></main></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(JSON.stringify({ out: path.relative(ROOT, OUT).split(path.sep).join('/'), bytes: fs.statSync(OUT).size }, null, 1));
