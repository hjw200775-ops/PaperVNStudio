/* Also embedded verbatim in standalone exports; no network dependencies.
 * V0.5: the exported player uses the SAME audio factory as the editor.
 * 存档只保存 {id, trail}：trail 是恢复音频状态所需的路径信息，
 * 绝不保存 AudioContext / HTMLAudioElement / 计时器等运行对象。 */
function paperPlayer(P,coreFactory,effectFactory,audioFactory){
 const C=coreFactory(),F=effectFactory(),E=id=>document.getElementById(id);
 const A=typeof audioFactory==='function'?audioFactory():null;
 const hasAudio=!!(Array.isArray(P.audioAssets)&&P.audioAssets.length)||P.nodes.some(n=>n&&n.audio);
 const PREF_KEY='paper-audio-prefs';
 let i=0,trail=[],cancelEffect=()=>{},audio=null;
 function loadPrefs(){try{const raw=localStorage.getItem(PREF_KEY);return raw?JSON.parse(raw):null}catch{return null}}
 function savePrefs(v){try{localStorage.setItem(PREF_KEY,JSON.stringify(v))}catch{}}
 function nameOf(audioId){const a=(P.audioAssets||[]).find(x=>x.id===audioId);return a?a.name:audioId||'未知素材'}
 function showAudioStatus(st){
  const el=E('audioStatus');if(!el)return;
  if(!st){el.textContent='本工程没有音频';return}
  const errs=st.errors||[],err=errs[0];
  if(err){el.textContent='⚠ '+err.title+'：'+(err.label||nameOf(err.audioId)||'当前句')+'。'+err.hint;el.className='audio-error';return}
  el.className='';
  const cur=st.bgm&&st.bgm.playing?'正在播放「'+nameOf(st.bgm.audioId)+'」':'当前没有背景音乐';
  el.textContent=(st.unlocked?'声音已启用':'点击「启用声音」后播放')+' · '+cur+(st.prefs.muted?' · 已静音':'');
 }
 function enterAudio(mode){
  if(!audio||!A)return;
  /* 浏览器首次播放受限：未解锁前只提示，不创建播放对象，避免无声失败后假报正在播放。 */
  if(!audio.isUnlocked()){showAudioStatus(audio.status());return}
  const n=P.nodes[i];if(!n)return;
  const cue=A.pure.normalizeCue(n.audio);
  const rebuild=mode==='rebuild';
  /* 返回 / 读档 / 重开 / 定点试玩：按真实 trail 结算目标句生效的 BGM，从曲首启动。 */
  const bgmState=rebuild?(C.bgmAt?C.bgmAt(P,n.id,trail):C.audioStateAlong(P,[...trail,n.id])):null;
  audio.enter(cue,{rebuild,bgmState,label:'第 '+(i+1)+' 句'});
 }
 function draw(animate=false,audioMode='none'){
  cancelEffect();
  const n=P.nodes[i];E('layers').replaceChildren();
  if(!n){E('text').textContent='暂无剧情';return}
  for(const l of C.stage(P,n.id,trail)){
   if(l.hidden)continue;const a=P.assets.find(a=>a.id===l.asset);if(!a)continue;
   const wrap=document.createElement('div');wrap.className='visual-layer';wrap.dataset.layer=l.id;
   Object.assign(wrap.style,{left:l.x+'%',top:l.y+'%',width:l.w+'%',height:l.h+'%',opacity:l.opacity/100});
   const im=document.createElement('img');im.alt=l.name;im.src=a.data;im.className=l.motion;im.style.objectFit=l.fit;
   wrap.appendChild(im);E('layers').appendChild(wrap);
  }
  const say=C.speakerOf(P,n);E('who').textContent=say.name;E('who').style.color=say.color||'';
  E('text').textContent=n.text;E('choices').replaceChildren();
  if(n.type==='choice')for(const o of n.options){const b=document.createElement('button');b.textContent=o.text;b.onclick=e=>{e.stopPropagation();go(o.target)};E('choices').appendChild(b)}
  E('hint').textContent=n.type==='end'?'故事结束':n.type==='choice'?'请选择一个选项':'点击 / 空格继续 ▸';
  E('back').disabled=!trail.length;
  const ls=C.stage(P,n.id,trail);
  if(animate)cancelEffect=F.animate(P,C,n.id,trail,E('layers'),ls);else F.apply(E('layers'),ls,F.frame(P,C,n.id,trail));
  if(audioMode!=='none')enterAudio(audioMode);
 }
 function go(target){const j=P.nodes.findIndex(n=>n.id===target);if(j>=0){trail.push(P.nodes[i].id);i=j;draw(true,'enter')}}
 function next(){const n=P.nodes[i];if(n?.type==='say')go(n.next||P.nodes[i+1]?.id)}
 E('scene').onclick=next;
 document.onkeydown=e=>{if(e.target.tagName==='BUTTON')return;if(e.key===' '||e.key==='Enter'){e.preventDefault();next()}};
 E('restart').onclick=()=>{i=0;trail=[];draw(true,'rebuild')};
 E('back').onclick=()=>{if(trail.length){const at=trail.pop();i=P.nodes.findIndex(n=>n.id===at);draw(false,'rebuild')}};
 const key='paper-game-'+P.id;
 E('save').onclick=()=>{try{localStorage.setItem(key,JSON.stringify({id:P.nodes[i]?.id,trail}));E('msg').textContent='进度已保存'}catch{E('msg').textContent='浏览器不允许保存'}};
 E('load').onclick=()=>{try{
  const x=JSON.parse(localStorage.getItem(key));
  if(x&&P.nodes.some(n=>n.id===x.id)&&Array.isArray(x.trail)&&x.trail.every(t=>P.nodes.some(n=>n.id===t))){
   i=P.nodes.findIndex(n=>n.id===x.id);trail=x.trail;draw(false,'rebuild');E('msg').textContent='已读取进度';
  }else E('msg').textContent='没有有效存档或存档版本不兼容';
 }catch{E('msg').textContent='无法读取存档'}};
 /* 只有含音频工程才创建运行层与绑定音量控件：旧工程不产生任何播放任务。 */
 if(hasAudio&&A){
  audio=A.runtime({assetData:id=>{const a=(P.audioAssets||[]).find(x=>x.id===id);return a?a.data:''},
   prefs:loadPrefs(),onStatus:showAudioStatus});
  const initial=audio.getPrefs();
  const bind=(id,k,valId)=>{
   const el=E(id);if(!el)return;
   el.value=String(Math.round(initial[k]*100));const out=E(valId);if(out)out.textContent=el.value+'%';
   el.oninput=()=>{const v=Number(el.value);audio.setPrefs({[k]:Number.isFinite(v)?v/100:1});if(out)out.textContent=el.value+'%';savePrefs(audio.getPrefs());showAudioStatus(audio.status())};
  };
  bind('volMaster','master','volMasterVal');bind('volBgm','bgm','volBgmVal');
  bind('volSfx','sfx','volSfxVal');bind('volVoice','voice','volVoiceVal');
  const mute=E('muteAll');
  if(mute){mute.checked=!!initial.muted;mute.onchange=()=>{audio.setPrefs({muted:!!mute.checked});savePrefs(audio.getPrefs());showAudioStatus(audio.status())}}
  const enable=E('enableSound');
  if(enable)enable.onclick=()=>Promise.resolve(audio.unlock()).then(r=>{
    if(!r.ok){E('msg').textContent='声音未启用：'+(r.title||'播放被拒绝')+'。'+(r.hint||'');showAudioStatus(audio.status());return}
    savePrefs(audio.getPrefs());enterAudio('rebuild');E('msg').textContent='声音已启用';
   });
  showAudioStatus(audio.status());
  /* 只读状态查询，供离线 HTML 的自动化验收断言播放状态与时间推进；
     不暴露 AudioContext / HTMLAudioElement 等运行对象。 */
  if(typeof window!=='undefined')window.paperAudioStatus=()=>audio.status();
 }else{
  const panel=E('audioPanel');if(panel)panel.hidden=true;
  if(typeof window!=='undefined')window.paperAudioStatus=()=>null;
 }
 const cleanup=()=>{if(audio)audio.dispose();cancelEffect()};
 if(typeof window!=='undefined'&&window.addEventListener){window.addEventListener('pagehide',cleanup);window.addEventListener('beforeunload',cleanup)}
 E('title').textContent=P.title;
 draw(true,'rebuild');
}
const paperPlayerCSS=`body{margin:0;background:#17261f;color:#f3f5eb;font:16px/1.8 "Microsoft YaHei",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;flex-direction:column}h1{font-size:18px;font-weight:400}#scene{width:min(1100px,96vw);aspect-ratio:16/9;position:relative;overflow:hidden;background:#dfe7dd;border-radius:8px;cursor:pointer}#layers{position:absolute;inset:0;pointer-events:none}.visual-layer{position:absolute}.visual-layer img{width:100%;height:100%;display:block;transform-origin:bottom center}.breathe{animation:b 4s ease-in-out infinite}.sway{animation:s 5s ease-in-out infinite}@keyframes b{50%{transform:scaleY(1.017)}}@keyframes s{0%,100%{transform:rotate(-1deg)}50%{transform:rotate(1deg)}}#box{position:absolute;bottom:5%;left:5%;right:5%;padding:clamp(8px,2vw,18px) clamp(12px,2vw,22px);background:#fbfff1ed;color:#273d35;border-radius:6px;font-size:clamp(11px,1.6vw,18px)}#who{font-weight:bold;color:#3f6753}#text{white-space:pre-wrap;overflow-wrap:anywhere}#hint{font-size:10px;text-align:right;color:#76876c}#choices{position:absolute;top:10%;left:20%;right:20%;display:grid;gap:6px}button{font:inherit;font-size:clamp(10px,1.3vw,14px);background:#f3f5eb;color:#273d35;border:1px solid #b7c2ad;border-radius:5px;padding:6px 12px;cursor:pointer}button:disabled{opacity:.4}nav{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}#audioPanel{width:min(1100px,96vw);margin-top:8px;border:1px solid #3b5548;border-radius:6px;padding:8px 12px;font-size:12px;background:#1c3028}.audio-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px}#audioStatus{color:#b9cbbd}#audioStatus.audio-error{color:#ffb4a8}#audioMixers{display:flex;gap:14px;flex-wrap:wrap;align-items:center}#audioMixers label{display:flex;gap:5px;align-items:center;color:#d7e3d5}#audioMixers input[type=range]{width:96px;accent-color:#8fb99b}#audioMixers span{min-width:34px;color:#9db3a4}.mute-label{cursor:pointer}#msg{font-size:12px;min-height:24px}@media(prefers-reduced-motion:reduce){*{animation:none!important}}`;
if(typeof module!=='undefined')module.exports={paperPlayer,paperPlayerCSS};
