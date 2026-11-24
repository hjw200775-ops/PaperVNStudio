/* V0.8.1-RC3.1 / M3 · 循环试听编辑器（轻量级，不做多轨时间轴）。
 * createLoopAudition() 返回一个模态组件，供「标题音乐 / BGM / 演出循环配置」复用。
 * 它不自己解码/播放：通过注入的 runtime 与 assetId 走「与发布游戏一致」的
 * AudioBufferSourceNode + loopStart/loopEnd 精确循环（runtime.loopPreview）。
 * 波形按需生成（runtime.decodeWaveform 复用 64MiB 缓存），关闭即释放。 */
function createLoopAudition(){
 let overlay=null,cv=null,state=null,raf=0,preview=null;
 let els={};
 const sec=(s)=>{s=Math.max(0,Number(s)||0);const m=Math.floor(s/60);return m+':'+String(Math.floor(s%60)).padStart(2,'0')+'.'+String(Math.floor((s%1)*10))};

 function node(html){const d=document.createElement('div');d.innerHTML=html;return d.firstElementChild}

 function build(){
  if(overlay)return;
  overlay=node('<div class="loop-audition-overlay" hidden></div>');
  overlay.innerHTML=`
   <style>
    .loop-audition-overlay{position:fixed;inset:0;z-index:9999;background:rgba(8,16,12,.72);display:flex;align-items:center;justify-content:center;padding:20px}
    .loop-audition{width:min(760px,96vw);max-height:92vh;overflow:auto;background:#15231c;color:#e8f0ea;border:1px solid #2c4137;border-radius:14px;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 18px 60px #0008}
    .la-head{display:flex;align-items:baseline;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #2c4137}
    .la-head h3{margin:0;font-size:16px;font-weight:600}
    .la-head .la-sub{color:#9fb3a8;font-size:12px;margin-left:8px}
    .la-close{background:none;border:none;color:#9fb3a8;font-size:22px;cursor:pointer;line-height:1}
    .la-body{padding:14px 18px}
    .la-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}
    .la-row label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#9fb3a8}
    .la-row input,.la-row select{background:#0d1813;border:1px solid #2c4137;color:#e8f0ea;border-radius:6px;padding:6px 8px;font:inherit;width:84px}
    .la-wave{position:relative;margin:8px 0 4px}
    .la-wave canvas{width:100%;height:110px;display:block;background:#0b1511;border:1px solid #2c4137;border-radius:8px;cursor:crosshair;touch-action:none}
    .la-marker{position:absolute;top:0;bottom:0;width:2px;background:#7ec8a3;pointer-events:auto;cursor:ew-resize}
    .la-marker.b{background:#ffd479}
    .la-marker .la-tag{position:absolute;top:2px;font-size:10px;white-space:nowrap;transform:translateX(-50%);color:#7ec8a3}
    .la-marker.b .la-tag{color:#ffd479}
    .la-playhead{position:absolute;top:0;bottom:0;width:1px;background:#e8f0ea;pointer-events:none}
    .la-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
    .la-btn{background:#1e3329;color:#e8f0ea;border:1px solid #2c4137;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
    .la-btn:hover{border-color:#7ec8a3}
    .la-btn.primary{background:#265c44;border-color:#3c8a67}
    .la-btn.warn{border-color:#7a5b2a}
    .la-cand{margin:12px 0;padding:10px;border:1px dashed #2c4137;border-radius:8px}
    .la-cand .la-cand-title{font-size:12px;color:#9fb3a8;margin-bottom:6px}
    .la-cand button{background:#0d1813;border:1px solid #2c4137;color:#e8f0ea;border-radius:6px;padding:5px 10px;font-size:12px;margin:2px;cursor:pointer}
    .la-cand button:hover,.la-cand button.on{border-color:#7ec8a3}
    .la-note{font-size:12px;color:#7f948a;border-left:3px solid #2c4137;padding-left:10px;margin:10px 0}
    .la-status{font-size:12px;color:#9fb3a8;min-height:1.4em}
    .la-error{color:#ffd479}
   </style>
   <div class="loop-audition">
    <div class="la-head"><div><h3 id="laTitle">循环试听</h3><span class="la-sub" id="laSub"></span></div><button class="la-close" id="laClose">×</button></div>
    <div class="la-body">
     <div class="la-wave" id="laWaveWrap"><canvas id="laWave" height="110"></canvas></div>
     <div class="la-row">
      <label>循环模式<select id="laLoopMode"><option value="region">区间循环</option><option value="all">整曲循环</option><option value="off">不循环</option></select></label>
      <label>起点 A（秒）<input id="laStart" type="number" step="0.1" min="0"></label>
      <label>终点 B（秒）<input id="laEnd" type="number" step="0.1" min="0"></label>
      <label>试听音量<input id="laVol" type="range" min="10" max="100" value="80" style="width:100px"></label>
     </div>
     <div class="la-actions">
      <button class="la-btn primary" id="laPlay">▶ 播放</button>
      <button class="la-btn" id="laStop">■ 停止</button>
      <button class="la-btn warn" id="laSeam">⟳ 试听循环接缝</button>
     </div>
     <div class="la-cand" id="laCandWrap" hidden><div class="la-cand-title">《晚风》标题曲试听候选（仅本曲，非通用默认）</div><div id="laCands"></div></div>
     <div class="la-status" id="laStatus"></div>
     <p class="la-note" id="laNote">A/B 标记可拖动；「试听循环接缝」会从终点前 3 秒起播，穿过边界回跳起点后继续 2 秒，反复听接缝是否自然。</p>
     <div class="la-actions">
      <button class="la-btn primary" id="laApply">应用循环区间</button>
      <button class="la-btn" id="laReset">重置</button>
      <button class="la-btn" id="laCancel">取消</button>
     </div>
    </div>
   </div>`;
  document.body.appendChild(overlay);
  els.title=overlay.querySelector('#laTitle');els.sub=overlay.querySelector('#laSub');
  els.waveWrap=overlay.querySelector('#laWaveWrap');cv=overlay.querySelector('#laWave');
  els.mode=overlay.querySelector('#laLoopMode');els.start=overlay.querySelector('#laStart');els.end=overlay.querySelector('#laEnd');
  els.vol=overlay.querySelector('#laVol');
  els.play=overlay.querySelector('#laPlay');els.stop=overlay.querySelector('#laStop');els.seam=overlay.querySelector('#laSeam');
  els.candWrap=overlay.querySelector('#laCandWrap');els.cands=overlay.querySelector('#laCands');
  els.status=overlay.querySelector('#laStatus');els.note=overlay.querySelector('#laNote');
  els.apply=overlay.querySelector('#laApply');els.reset=overlay.querySelector('#laReset');els.cancel=overlay.querySelector('#laCancel');
  overlay.querySelector('#laClose').onclick=()=>close(false);

  overlay.onclick=e=>{if(e.target===overlay)close(false)};
  els.mode.onchange=()=>{refreshControls()};
  els.start.onchange=els.end.onchange=()=>{syncFromInputs()};
  els.play.onclick=()=>togglePlay();
  els.stop.onclick=()=>stopPreview();
  els.seam.onclick=()=>seamAudition();
  els.apply.onclick=()=>close(true);
  els.reset.onclick=()=>{if(state){state.loop={...state.originalLoop};renderFromLoop();status('已重置为原配置');}};
  els.cancel.onclick=()=>close(false);
  setupCanvasDrag();
 }

 function status(t,err){els.status.textContent=t||'';els.status.className='la-status'+(err?' la-error':'')}

 function open(opts){
  build();
  state={...opts,loop:{...(opts.loop||{mode:'all',start:0,end:0})},originalLoop:{...(opts.loop||{mode:'all',start:0,end:0})},
   duration:Number(opts.duration)||0,peaks:null,loading:false};
  els.title.textContent=opts.title||'循环试听';
  els.sub.textContent=(opts.audioName||'')+(state.duration?' · 总时长 '+sec(state.duration):'');
  els.vol.value='80';
  renderFromLoop();
  renderCandidates();
  overlay.hidden=false;
  loadWaveform();
  stopPreview();
 }
 function close(apply){
  stopPreview();
  if(overlay)overlay.hidden=true;
  if(apply&&state&&state.onApply){const loop=currentLoop();if(loop&&loop.mode==='region'&&!(loop.end>loop.start)){status('非法区间：终点必须大于起点','err');return}state.onApply(loop)}
  state=null;
 }

 function currentLoop(){
  const mode=els.mode.value;
  if(mode!=='region')return {mode,start:0,end:0};
  const s=Number(els.start.value)||0,e=Number(els.end.value)||0;
  return {mode:'region',start:s,end:e};
 }
 function renderFromLoop(){
  const l=state.loop||{mode:'all',start:0,end:0};
  els.mode.value=l.mode==='off'?'off':(l.mode==='all'?'all':'region');
  els.start.value=l.start||0;els.end.value=l.end||0;
  refreshControls();
 }
 function refreshControls(){
  const region=els.mode.value==='region';
  els.start.disabled=!region;els.end.disabled=!region;
  drawWave();
 }
 function syncFromInputs(){
  const s=Number(els.start.value)||0,e=Number(els.end.value)||0;
  if(state){state.loop={mode:'region',start:s,end:e}}
  if(state&&state.duration){const d=state.duration;els.start.max=String(Math.max(0,d-0.1));els.end.max=String(d);}
  if(e>0&&s>0&&!(e>s))status('终点需大于起点','err');else status('');
  drawWave();
 }

 function loadWaveform(){
  if(!state||state.peaks)return;
  const rt=state.runtime&&state.runtime();
  if(!rt||typeof rt.decodeWaveform!=='function'){state.peaks=[];drawWave();return}
  state.loading=true;status('正在生成波形…');
  Promise.resolve(rt.decodeWaveform(state.assetId,800)).then(r=>{
   if(!state)return;
   if(r&&r.ok){state.peaks=r.peaks;state.duration=r.duration;els.sub.textContent=(state.audioName||'')+' · 总时长 '+sec(state.duration);els.start.max=String(Math.max(0,r.duration-0.1));els.end.max=String(r.duration);status('');}
   else {state.peaks=[];status('波形生成失败：'+((r&&r.reason)||'素材不可解码'),'err')}
   drawWave();
  }).catch(e=>{if(state){state.peaks=[];status('波形生成失败：'+(e&&e.message||e),'err');drawWave()}});
 }

 function xOf(sec){return state&&state.duration?sec/state.duration*cv.clientWidth:0}
 function secOf(x){return state&&state.duration?x/cv.clientWidth*state.duration:0}

 function drawWave(){
  if(!cv||!state)return;
  const c=cv.getContext('2d'),w=cv.width=cv.clientWidth*(window.devicePixelRatio||1),h=cv.height=110*(window.devicePixelRatio||1);
  c.clearRect(0,0,w,h);c.fillStyle='#0b1511';c.fillRect(0,0,w,h);
  if(state.peaks&&state.peaks.length){
   c.fillStyle='#4f9b76';const n=state.peaks.length,bw=w/n;
   for(let i=0;i<n;i++){const p=state.peaks[i];const bh=Math.max(1,p*(h/2-6));c.fillRect(i*bw,h/2-bh,bw*0.82,bh*2)}
  }
  drawMarkers();
 }
 function drawMarkers(){
  if(!cv||!state)return;
  els.waveWrap.querySelectorAll('.la-marker,.la-playhead').forEach(m=>m.remove());
  const region=els.mode.value==='region';
  if(region){
   const s=Number(els.start.value)||0,e=Number(els.end.value)||0;
   if(state.duration){
    mkMarker(s,'A','a');mkMarker(e,'B','b');
   }
  }
  const ph=document.createElement('div');ph.className='la-playhead';ph.id='laPlayhead';els.waveWrap.appendChild(ph);
  function mkMarker(sec,tag,cls){
   const m=document.createElement('div');m.className='la-marker'+(cls==='b'?' b':'');m.dataset.sec=sec;m.dataset.tag=cls;
   m.style.left=Math.min(100,Math.max(0,sec/state.duration*100))+'%';
   m.innerHTML='<span class="la-tag">'+tag+' '+sec.toFixed(1)+'s</span>';
   m.addEventListener('pointerdown',e=>{e.stopPropagation();startDrag(m,cls,e)});
   els.waveWrap.appendChild(m);
  }
 }
 let drag=null;
 function setupCanvasDrag(){ /* 由标记自身的 pointerdown 处理 */ }
 function startDrag(marker,tag,e){
  drag={tag,marker};
  const move=ev=>{if(!drag||!state||!state.duration)return;const r=els.waveWrap.getBoundingClientRect();const sec=Math.max(0,Math.min(state.duration,(ev.clientX-r.left)/r.width*state.duration));drag.marker.dataset.sec=sec;drag.marker.style.left=(sec/state.duration*100)+'%';const lbl=drag.marker.querySelector('.la-tag');lbl.textContent=(tag==='a'?'A':'B')+' '+sec.toFixed(1)+'s';if(tag==='a')els.start.value=sec.toFixed(1);else els.end.value=sec.toFixed(1);syncFromInputs()};
  const up=()=>{drag=null;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up)};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
  e.preventDefault();
 }

 async function togglePlay(){
  if(!state)return;
  if(preview){stopPreview();return}
  const rt=state.runtime&&state.runtime();
  if(!rt||typeof rt.loopPreview!=='function'){status('当前环境不支持循环试听','err');return}
  const loop=currentLoop();
  if(loop.mode==='region'&&!(loop.end>loop.start)){status('非法区间：终点必须大于起点','err');return}
  status('正在加载素材…');
  const r=await rt.loopPreview(state.assetId,loop,Number(els.vol.value)/100);
  if(!state)return;
  if(!r||!r.ok){status('试听失败：'+((r&&r.reason)||'未知原因'),'err');return}
  preview=r;els.play.textContent='⏸ 暂停';status('播放中 · 循环 '+sec(r.loop.mode==='region'?r.loop.start:0)+'–'+sec(r.loop.mode==='region'?r.loop.end:(r.duration||0))+(r.loop.mode==='off'?'（不循环）':''));
  tick();
 }
 function stopPreview(){
  if(preview){try{preview.stop()}catch{}}
  preview=null;els.play.textContent='▶ 播放';
  cancelAnimationFrame(raf);
  if(els.waveWrap){const ph=els.waveWrap.querySelector('#laPlayhead');if(ph)ph.style.display='none'}
 }
 function tick(){
  if(!preview||!state){return}
  const t=preview.time?preview.time():0;
  const ph=els.waveWrap.querySelector('#laPlayhead');
  if(ph){ph.style.display='block';ph.style.left=Math.min(100,Math.max(0,t/state.duration*100))+'%'}
  els.status.textContent='播放中 '+sec(t)+' / '+sec(state.duration)+' · 循环 '+preview.loops()+' 次';
  raf=requestAnimationFrame(tick);
 }
 async function seamAudition(){
  if(!state)return;
  const rt=state.runtime&&state.runtime();
  if(!rt||typeof rt.loopPreview!=='function'){status('当前环境不支持循环试听','err');return}
  const loop=currentLoop();
  const d=state.duration;
  const leadIn=3,trail=2;
  let startOff;
  if(loop.mode==='region'){if(!(loop.end>loop.start)){status('非法区间','err');return}startOff=Math.max(0,loop.end-leadIn)}
  else if(loop.mode==='all'){startOff=Math.max(0,d-leadIn)}
  else {status('「不循环」没有接缝可试听','err');return}
  stopPreview();
  status('接缝试听：从终点前 '+leadIn+'s 起播，回跳起点后继续 '+trail+'s…');
  const r=await rt.loopPreview(state.assetId,loop,Number(els.vol.value)/100,startOff);
  if(!state)return;
  if(!r||!r.ok){status('试听失败：'+((r&&r.reason)||'未知原因'),'err');return}
  preview=r;els.play.textContent='⏸ 暂停';
  // 接缝试听：播放 leadIn 秒后自动跨过边界，继续 trail 秒，共持续几秒后停止由用户控制
  tick();
 }

 function renderCandidates(){
  if(!state||!Array.isArray(state.candidates)||!state.candidates.length){els.candWrap.hidden=true;return}
  els.candWrap.hidden=false;
  els.cands.innerHTML='';
  for(const c of state.candidates){
   const b=document.createElement('button');b.textContent=c.label||c.key;
   if(c.experimental){b.disabled=true;b.title='实验能力：交叉淡化仅在独立试听页可用，编辑器内暂不提供';b.style.opacity='.45'}
   else b.onclick=()=>{if(!state)return;state.loop={...c.loop};renderFromLoop();status('已套用候选：'+(c.label||c.key));drawWave()};
   els.cands.appendChild(b);
  }
 }

 return {open,close,isOpen:()=>!!(overlay&&!overlay.hidden)};
}
if(typeof module!=='undefined')module.exports=createLoopAudition;
