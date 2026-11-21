/* Also embedded verbatim in standalone exports; no network dependencies.
 * V0.6.1: title page + in-game menu + settings. The exported HTML and the
 * editor's "完整预览" both run this same player; "从本句试玩" stays in the editor.
 * 存档只保存 {id, trail}：trail 是恢复效果与音频状态所需的路径信息，
 * 绝不保存 AudioContext / HTMLAudioElement / 计时器等运行对象。 */
function paperPlayer(P,coreFactory,effectFactory,audioFactory){
 const C=coreFactory(),F=effectFactory(),E=id=>document.getElementById(id);
 /* 兜底：CSS 已覆盖的元素之外，也不让展示图被拖成系统文件拖放。输入控件除外。
    非真实 DOM 环境（测试里的 vm stub）跳过，不给播放器加环境耦合。 */
 if(typeof document!=='undefined'&&document&&typeof document.addEventListener==='function'){
  document.addEventListener('dragstart',e=>{
   const t=e.target;
   if(t&&t.closest&&t.closest('#titleScreen,#gameRoot,.overlay')&&!t.closest('input,textarea'))e.preventDefault();
  },true);
 }
 const A=typeof audioFactory==='function'?audioFactory():null;
 const hasAudio=!!(Array.isArray(P.audioAssets)&&P.audioAssets.length)||P.nodes.some(n=>n&&n.audio);
 const PREF_KEY='paper-audio-prefs',SAVE_KEY='paper-game-'+P.id;
 let state='title',i=0,trail=[],cancelEffect=()=>{},audio=null,msgTimer=0;
 /* ---------- 标题音乐（V0.7.3） ----------
    独立于剧情 BGM 的播放通道：进入游戏时暂停、返回标题时从暂停点继续，
    两者不共用 audio.js 的 BGM 槽位，避免标题曲与场景曲相互叠加。 */
 let titleAudio=null;
 function titleTrack(){
  const tm=P.titleMusic;if(!tm||!tm.audioId)return null;
  const a=(P.audioAssets||[]).find(x=>x.id===tm.audioId);
  return a?{asset:a,cfg:tm}:null;
 }
 function titleMusicEl(){
  const t=titleTrack();if(!t)return null;
  if(titleAudio&&titleAudio.dataset.id===t.asset.id)return titleAudio;
  releaseTitleMusic();
  const el=document.createElement('audio');
  el.src=t.asset.data;el.loop=t.cfg.loop!==false;el.preload='auto';
  el.volume=Math.min(1,Math.max(0,(Number(t.cfg.volume)||0)/100));
  el.dataset.id=t.asset.id;
  el.addEventListener('error',()=>{if(E('titleNote'))E('titleNote').textContent='标题音乐无法播放：'+(t.asset.name||'素材已损坏')+'。'});
  /* 挂进 DOM：audio 不占布局，但这样开发者工具里能直接看到音源与播放状态。 */
  el.hidden=true;
  if(document.body)document.body.appendChild(el);
  titleAudio=el;return el;
 }
 function playTitleMusic(){
  const t=titleTrack();if(!t)return;
  const el=titleMusicEl();if(!el||!el.paused)return;
  const pr=el.play();
  /* 自动播放被拒时不报错：第一次点击开始/继续会再试一次。 */
  if(pr&&pr.catch)pr.catch(()=>{});
 }
 function pauseTitleMusic(){
  if(titleAudio&&!titleAudio.paused){try{titleAudio.pause()}catch{}}
 }
 function releaseTitleMusic(){
  if(!titleAudio)return;
  try{titleAudio.pause()}catch{}
  titleAudio.removeAttribute('src');
  if(typeof titleAudio.load==='function')try{titleAudio.load()}catch{}
  if(titleAudio.parentNode)titleAudio.parentNode.removeChild(titleAudio);
  titleAudio=null;
 }
 let saveInfo={ok:false,reason:''},settingsOrigin='title',confirmOrigin='playing';
 const MIXERS=[['master','volMaster','volMasterVal'],['bgm','volBgm','volBgmVal'],
  ['sfx','volSfx','volSfxVal'],['voice','volVoice','volVoiceVal']];

 /* ---------- 基础工具 ---------- */
 function show(el,on){if(el)el.hidden=!on}
 function focus(el){if(el&&typeof el.focus==='function')try{el.focus()}catch{}}
 function showMsg(t){
  const el=E('msg');if(!el)return;
  el.textContent=t||'';
  clearTimeout(msgTimer);
  if(t)msgTimer=setTimeout(()=>{el.textContent=''},4200);
 }
 function loadPrefs(){try{const raw=localStorage.getItem(PREF_KEY);return raw?JSON.parse(raw):null}catch{return null}}
 function savePrefs(v){try{localStorage.setItem(PREF_KEY,JSON.stringify(v))}catch{}}
 function nameOf(audioId){const a=(P.audioAssets||[]).find(x=>x.id===audioId);return a?a.name:audioId||'未知素材'}

 /* ---------- 音频：复用 V0.5 运行层 ---------- */
 function showAudioStatus(st){
  const el=E('audioStatus');if(!el)return;
  if(!st){el.textContent='本作品没有音频';return}
  const errs=st.errors||[],err=errs[0];
  if(err){el.textContent='注意：'+err.title+'：'+(err.label||nameOf(err.audioId)||'当前句')+'。'+err.hint;el.className='audio-error';return}
  el.className='';
  const cur=st.bgm&&st.bgm.playing?'正在播放「'+nameOf(st.bgm.audioId)+'」':'当前没有背景音乐';
  el.textContent=(st.unlocked?'声音已启用':'点击「启用声音」后播放')+' · '+cur+(st.prefs.muted?' · 已静音':'');
 }
 function syncVolumeUI(){
  if(!audio)return;
  const p=audio.getPrefs();
  for(const [k,id,valId]of MIXERS){
   const el=E(id);if(!el)continue;
   if(document.activeElement!==el)el.value=String(Math.round(p[k]*100));
   const out=E(valId);if(out)out.textContent=el.value+'%';
  }
  const m=E('muteAll');if(m)m.checked=!!p.muted;
 }
 /* 进入一句：正常推进沿用当前播放位置；开始/继续/返回/读档从曲首重建。 */
 function enterAudio(mode){
  if(!audio||!A||state!=='playing')return;
  if(!audio.isUnlocked()){showAudioStatus(audio.status());return}
  const n=P.nodes[i];if(!n)return;
  const cue=A.pure.normalizeCue(n.audio);
  const rebuild=mode==='rebuild';
  const bgmState=rebuild?(C.bgmAt?C.bgmAt(P,n.id,trail):C.audioStateAlong(P,[...trail,n.id])):null;
  audio.enter(cue,{rebuild,bgmState,label:'第 '+(i+1)+' 句'});
 }
 /* 解锁重试只恢复当前句 BGM：不重播语音/音效，不重置剧情，也不叠音。 */
 function retryAudio(){
  if(!audio||!A||state==='title')return;
  if(!audio.isUnlocked()){showAudioStatus(audio.status());return}
  const n=P.nodes[i];if(!n)return;
  const cue=A.pure.normalizeCue(n.audio);
  const bgmState=C.bgmAt(P,n.id,trail);
  audio.stopAll();
  audio.enter({bgm:cue.bgm,sfx:[],voice:null},{rebuild:true,bgmState,label:'第 '+(i+1)+' 句'});
 }
 /* 开始 / 继续属于真实点击：先尝试解锁，失败也允许无声进入。 */
 function unlockThen(fn){
  if(!audio||!A)return Promise.resolve(fn());
  if(audio.isUnlocked())return Promise.resolve(fn());
  return Promise.resolve(audio.unlock()).then(r=>{
   if(r&&r.ok)savePrefs(audio.getPrefs());
   else showMsg('声音未启用：'+((r&&r.title)||'播放被拒绝')+'。'+((r&&r.hint)||'')+' 可以无声游玩，稍后在设置里重试。');
   return fn();
  }).catch(()=>{
   showMsg('声音未启用：浏览器拒绝了播放。可以无声游玩，稍后在设置里重试。');
   return fn();
  });
 }

 /* ---------- 舞台绘制 ---------- */
 function draw(animate,audioMode){
  cancelEffect();
  const n=P.nodes[i];
  const layers=E('layers');
  if(layers)layers.replaceChildren();
  if(!n){if(E('text'))E('text').textContent='暂无剧情';return}
  for(const l of C.stage(P,n.id,trail)){
   if(l.hidden)continue;const a=P.assets.find(a=>a.id===l.asset);if(!a)continue;
   const wrap=document.createElement('div');wrap.className='visual-layer';wrap.dataset.layer=l.id;
   Object.assign(wrap.style,{left:l.x+'%',top:l.y+'%',width:l.w+'%',height:l.h+'%',opacity:l.opacity/100});
   const im=document.createElement('img');im.alt=l.name;im.src=a.data;im.className=l.motion;im.style.objectFit=l.fit;im.draggable=false;
   wrap.appendChild(im);layers.appendChild(wrap);
  }
  const say=C.speakerOf(P,n);E('who').textContent=say.name;E('who').style.color=say.color||'';
  E('text').textContent=n.text;E('choices').replaceChildren();
  if(n.type==='choice')for(const o of n.options){
   const b=document.createElement('button');b.textContent=o.text;
   b.onclick=e=>{e.stopPropagation();if(state==='playing')go(o.target)};
   E('choices').appendChild(b);
  }
  E('hint').textContent=n.type==='end'?'故事结束':n.type==='choice'?'请选择一个选项':'点击 / 空格继续 ▸';
  E('back').disabled=!trail.length;
  const ls=C.stage(P,n.id,trail);
  if(animate)cancelEffect=F.animate(P,C,n.id,trail,E('layers'),ls);else F.apply(E('layers'),ls,F.frame(P,C,n.id,trail));
  if(audioMode!=='none')enterAudio(audioMode);
 }

 /* ---------- 存档：单槽，保留节点 ID 与实际 trail ---------- */
 function edgesOf(n){
  if(!n)return [];
  if(n.type==='end')return [];
  if(n.type==='choice')return (n.options||[]).map(o=>o.target).filter(Boolean);
  return C.edges(P,n);
 }
 function connected(a,b){
  const n=P.nodes.find(x=>x.id===a);
  return !!n&&edgesOf(n).includes(b);
 }
 /* 坏存档只报告原因并保留原数据，不静默删除、不跳到别的句子。 */
 function readSave(){
  let raw;
  try{raw=localStorage.getItem(SAVE_KEY)}
  catch{return {ok:false,reason:'浏览器不允许读取存档；可以开始新游戏，但本次可能无法保存。'}}
  if(!raw)return {ok:false,reason:'还没有保存进度；在游戏菜单里保存后就能继续。'}
  let x;
  try{x=JSON.parse(raw)}catch{return {ok:false,reason:'存档内容已损坏，无法继续；可以开始新游戏。'}}
  if(!x||typeof x.id!=='string'||!P.nodes.some(n=>n.id===x.id)){
   return {ok:false,reason:'存档指向的句子已被删除，无法继续；可以开始新游戏。'};
  }
  if(!Array.isArray(x.trail)||!x.trail.every(t=>P.nodes.some(n=>n.id===t))){
   return {ok:false,reason:'存档的路径已失效，无法继续；可以开始新游戏。'};
  }
  /* 存档必须从故事开头出发；空 trail 只允许停在首节点，防止伪造存档跳句。 */
  const firstId=P.nodes[0]&&P.nodes[0].id;
  if(x.trail.length){
   if(x.trail[0]!==firstId)return {ok:false,reason:'存档的路径不是从故事开头开始的，无法继续。'};
  }else if(x.id!==firstId){
   return {ok:false,reason:'存档缺少实际路径，无法继续；可以开始新游戏。'};
  }
  for(let k=0;k+1<x.trail.length;k++){
   if(!connected(x.trail[k],x.trail[k+1]))return {ok:false,reason:'存档的路径与实际分支不一致，无法继续。'};
  }
  if(x.trail.length&&!connected(x.trail[x.trail.length-1],x.id)){
   return {ok:false,reason:'存档的路径与实际分支不一致，无法继续。'};
  }
  return {ok:true,id:x.id,trail:x.trail.slice()};
 }
 function saveGame(){
  const n=P.nodes[i];
  if(!n){showMsg('当前没有可保存的句子。');return false}
  try{localStorage.setItem(SAVE_KEY,JSON.stringify({id:n.id,trail:trail.slice()}))}
  catch{
   showMsg('未能保存：浏览器不允许写入存档或空间不足；游戏仍可继续。');
   if(E('menuNote'))E('menuNote').textContent='未能保存：浏览器不允许写入存档或空间不足。';
   return false;
  }
  saveInfo={ok:true,id:n.id,trail:trail.slice()};
  if(E('menuNote'))E('menuNote').textContent='进度已保存。';
  showMsg('进度已保存');
  return true;
 }
 function loadGame(){
  const s=readSave();saveInfo=s;
  if(!s.ok){
   showMsg(s.reason);
   if(E('menuNote'))E('menuNote').textContent=s.reason;
   return false;
  }
  show(E('titleScreen'),false);show(E('gameRoot'),true);
  show(E('menuOverlay'),false);show(E('settingsOverlay'),false);show(E('confirmOverlay'),false);
  state='playing';
  i=Math.max(0,P.nodes.findIndex(n=>n.id===s.id));
  trail=s.trail.slice();
  draw(false,'rebuild');
  showMsg('已读取进度');
  if(E('menuNote'))E('menuNote').textContent='';
  focus(E('scene'));
  return true;
 }

 /* ---------- 标题背景 ---------- */
/* 只按素材 ID 取图：不读路径、不联网。缺图时回退默认标题页并明确提示，
   不阻塞「开始游戏」，也不影响正文场景。 */
let titleBgOk=false;
function applyTitleBackground(){
 const a=P.titleBackground?(P.assets||[]).find(x=>x.id===P.titleBackground):null;
 titleBgOk=!!(a&&typeof a.data==='string'&&/^data:image\//.test(a.data));
 const sec=E('titleScreen'),box=E('titleBg'),img=E('titleBgImg'),note=E('titleBgNote');
 if(box)box.hidden=!titleBgOk;
 if(img&&titleBgOk)img.src=a.data;   /* 缺图时容器整体隐藏，不保留半张图 */
 if(sec)sec.classList.toggle('has-bg',titleBgOk);
 if(note){
  const missing=!!P.titleBackground&&!titleBgOk;
  note.hidden=!missing;
  note.textContent=missing?'标题页背景素材缺失，已使用默认标题页样式。':'';
 }
}

/* ---------- 页面切换 ---------- */
 function renderTitle(){
  state='title';
  show(E('titleScreen'),true);show(E('gameRoot'),false);
  show(E('menuOverlay'),false);show(E('settingsOverlay'),false);show(E('confirmOverlay'),false);
  const empty=!P.nodes.length;
  saveInfo=readSave();
  applyTitleBackground();
  if(E('title'))E('title').textContent=P.title;
  if(E('startGame'))E('startGame').disabled=empty;
  if(E('continueGame')){
   E('continueGame').disabled=empty||!saveInfo.ok;
   E('continueGame').title=saveInfo.ok?'':'继续游戏不可用：'+saveInfo.reason;
  }
  if(E('titleEmpty'))E('titleEmpty').hidden=!empty;
  if(E('titleNote')){
   E('titleNote').textContent=empty?'这个作品还没有可播放的剧情。请回到编辑器添加至少一句台词。'
    :(saveInfo.ok?'继续游戏会回到上次保存的句子。':saveInfo.reason);
  }
  if(audio)showAudioStatus(audio.status());
  playTitleMusic();
  focus(empty?E('titleSettings'):(saveInfo.ok?E('continueGame'):E('startGame')));
 }
 function startSession(id,path){
  pauseTitleMusic();
  show(E('titleScreen'),false);show(E('gameRoot'),true);
  show(E('menuOverlay'),false);show(E('settingsOverlay'),false);show(E('confirmOverlay'),false);
  state='playing';
  i=Math.max(0,P.nodes.findIndex(n=>n.id===id));
  if(i<0)i=0;
  trail=Array.isArray(path)?path.slice():[];
  if(E('menuNote'))E('menuNote').textContent='';
  draw(true,'rebuild');
  focus(E('scene'));
 }
 function startGame(){
  if(!P.nodes.length){showMsg('这个作品还没有剧情，无法开始。');return Promise.resolve(false)}
  return unlockThen(()=>{startSession(P.nodes[0].id,[]);return true});
 }
 function continueGame(){
  const s=readSave();saveInfo=s;
  if(!s.ok){renderTitle();showMsg(s.reason);return Promise.resolve(false)}
  return unlockThen(()=>{startSession(s.id,s.trail);return true});
 }
 function openMenu(){
  if(state!=='playing')return;
  state='menu';
  show(E('menuOverlay'),true);
  if(E('menuNote'))E('menuNote').textContent='';
  focus(E('menuResume'));
 }
 function closeMenu(){
  if(state!=='menu')return;
  show(E('menuOverlay'),false);
  state='playing';
  focus(E('menuBtn'));
 }
 function openSettings(origin){
  settingsOrigin=origin||'title';
  state='settings';
  if(settingsOrigin==='menu')show(E('menuOverlay'),false);
  show(E('titleScreen'),settingsOrigin==='title');
  show(E('settingsOverlay'),true);
  show(E('audioPanel'),hasAudio);
  show(E('noAudioNote'),!hasAudio);
  if(E('settingsNote'))E('settingsNote').textContent=hasAudio?'':'本作品没有音频，音量设置不适用。';
  if(audio){syncVolumeUI();showAudioStatus(audio.status())}
  focus(hasAudio?E('volMaster'):E('setBack'));
 }
 function closeSettings(){
  if(state!=='settings')return;
  show(E('settingsOverlay'),false);
  if(settingsOrigin==='menu'){
   state='menu';show(E('menuOverlay'),true);focus(E('menuSettings'));
  }else{
   renderTitle();
  }
 }
 /* 返回标题：取消演出、停止全部声音与延迟任务、清空本次会话；保留存档与偏好。 */
 function returnTitle(){
  cancelEffect();cancelEffect=()=>{};
  if(audio)audio.stopAll();
  i=0;trail=[];
  const layers=E('layers');if(layers)layers.replaceChildren();
  for(const id of ['who','text','hint'])if(E(id))E(id).textContent='';
  if(E('choices'))E('choices').replaceChildren();
  show(E('gameRoot'),false);
  showMsg('');
  renderTitle();
 }
 function askRestart(){
  if(state==='title'){startGame();return}
  if(state!=='playing')return;
  confirmOrigin=state;
  state='confirm';
  show(E('confirmOverlay'),true);
  focus(E('cancelRestart'));
 }
 function cancelRestart(){
  if(state!=='confirm')return;
  show(E('confirmOverlay'),false);
  state=confirmOrigin;
  focus(E('restart'));
 }
 function confirmRestart(){
  if(state!=='confirm')return Promise.resolve(false);
  show(E('confirmOverlay'),false);
  if(!P.nodes.length)return Promise.resolve(false);
  return unlockThen(()=>{startSession(P.nodes[0].id,[]);return true});
 }

 /* ---------- 推进与返回 ---------- */
 function go(target){
  if(state!=='playing')return;
  const j=P.nodes.findIndex(n=>n.id===target);
  if(j<0)return;
  trail.push(P.nodes[i].id);i=j;draw(true,'enter');
 }
 function next(){
  if(state!=='playing')return;
  const n=P.nodes[i];
  if(n?.type==='say')go(n.next||P.nodes[i+1]?.id);
 }
 function back(){
  if(state!=='playing'||!trail.length)return;
  const at=trail.pop();i=P.nodes.findIndex(n=>n.id===at);
  draw(false,'rebuild');
 }

 /* ---------- 事件 ---------- */
 /* 只有「点一下」才推进：按住拖动（拖选、拖立绘）不应顺带翻页。
    位移阈值 8px 只用来区分手势，不影响点击、键盘与选项按钮（选项会 stopPropagation）。 */
 let pressAt=null;
 const sceneEl=E('scene');
 if(sceneEl&&typeof sceneEl.addEventListener==='function'){
  sceneEl.addEventListener('pointerdown',e=>{pressAt={x:e.clientX,y:e.clientY}});
  sceneEl.addEventListener('pointercancel',()=>{pressAt=null});
 }
 E('scene').onclick=e=>{
  if(pressAt&&Math.hypot(e.clientX-pressAt.x,e.clientY-pressAt.y)>8){pressAt=null;return}
  pressAt=null;
  if(state==='playing')next();
 };
 /* 关闭窗口或刷新时释放标题音乐，别把解码器与文件句柄留着。 */
 const releaseOnExit=()=>{pauseTitleMusic();releaseTitleMusic();if(audio)audio.stopAll()};
 if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){
  window.addEventListener('pagehide',releaseOnExit);
  window.addEventListener('beforeunload',releaseOnExit);
 }
 document.onkeydown=e=>{
  if(!e||e.repeat)return;
  const tag=e.target&&e.target.tagName;
  const typing=tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||!!(e.target&&e.target.isContentEditable);
  if(e.key==='Escape'){
   if(state==='settings'){e.preventDefault();closeSettings();return}
   if(state==='confirm'){e.preventDefault();cancelRestart();return}
   if(state==='menu'){e.preventDefault();closeMenu();return}
   if(state==='playing'){e.preventDefault();openMenu();return}
   return;
  }
  if(typing||tag==='BUTTON')return;
  if(state==='playing'&&(e.key===' '||e.key==='Enter')){e.preventDefault();next()}
 };
 for(const id of ['menuOverlay','settingsOverlay','confirmOverlay']){
  const el=E(id);if(el)el.onclick=e=>e.stopPropagation();
 }
 E('startGame').onclick=startGame;
 E('continueGame').onclick=continueGame;
 E('titleSettings').onclick=()=>openSettings('title');
 E('menuBtn').onclick=openMenu;
 E('menuResume').onclick=closeMenu;
 E('menuSettings').onclick=()=>openSettings('menu');
 E('menuTitle').onclick=returnTitle;
 E('setBack').onclick=closeSettings;
 E('save').onclick=saveGame;
 E('load').onclick=loadGame;
 E('back').onclick=back;
 E('restart').onclick=askRestart;
 E('confirmRestart').onclick=confirmRestart;
 E('cancelRestart').onclick=cancelRestart;

 /* 只有含音频工程才创建运行层与绑定音量控件：标题页不产生任何播放任务。 */
 if(hasAudio&&A){
  audio=A.runtime({assetData:id=>{const a=(P.audioAssets||[]).find(x=>x.id===id);return a?a.data:''},
   prefs:loadPrefs(),onStatus:showAudioStatus});
  const initial=audio.getPrefs();
  const bind=(id,k,valId)=>{
   const el=E(id);if(!el)return;
   el.value=String(Math.round(initial[k]*100));const out=E(valId);if(out)out.textContent=el.value+'%';
   el.oninput=()=>{const v=Number(el.value);audio.setPrefs({[k]:Number.isFinite(v)?v/100:1});
    if(out)out.textContent=el.value+'%';savePrefs(audio.getPrefs());showAudioStatus(audio.status())};
  };
  for(const [k,id,valId]of MIXERS)bind(id,k,valId);
  const mute=E('muteAll');
  if(mute){mute.checked=!!initial.muted;mute.onchange=()=>{audio.setPrefs({muted:!!mute.checked});savePrefs(audio.getPrefs());showAudioStatus(audio.status())}}
  const enable=E('enableSound');
  if(enable)enable.onclick=()=>Promise.resolve(audio.unlock()).then(r=>{
   if(!r.ok){showMsg('声音未启用：'+(r.title||'播放被拒绝')+'。'+(r.hint||''));showAudioStatus(audio.status());return}
   savePrefs(audio.getPrefs());
   if(state==='playing'||state==='menu')retryAudio();
   showAudioStatus(audio.status());
   showMsg('声音已启用');
  });
  showAudioStatus(audio.status());
  if(typeof window!=='undefined')window.paperAudioStatus=()=>audio.status();
 }else{
  show(E('audioPanel'),false);show(E('noAudioNote'),true);
  if(typeof window!=='undefined')window.paperAudioStatus=()=>null;
 }
 /* 只读状态，供离线 HTML 的自动化验收断言，不暴露运行对象。 */
 if(typeof window!=='undefined')window.paperGameState=()=>({state,i,trail:trail.slice(),
  saveOk:!!saveInfo.ok,saveReason:saveInfo.reason||'',nodes:P.nodes.length,hasAudio,
  titleBg:titleBgOk,audio:audio?audio.status():null});

 const cleanup=()=>{cancelEffect();cancelEffect=()=>{};if(audio){audio.stopAll();audio.dispose()}};
 if(typeof window!=='undefined'&&window.addEventListener){
  window.addEventListener('pagehide',cleanup);window.addEventListener('beforeunload',cleanup);
 }
 renderTitle();
}
const paperPlayerCSS=`/* 玩家端禁选区：舞台、台词、选项、标题页与菜单不接受文本选择，展示图片不参与原生拖拽。只挂在结构容器上，不绑对话框样式——V0.8 的快捷栏与 UI 设计器放进这些容器就自动继承。注意不要动 pointer-events：#layers 靠 none 让点击穿透到舞台。 */#titleScreen,#gameRoot,.overlay,#msg{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}#titleScreen img,#gameRoot img,.overlay img{-webkit-user-drag:none;user-drag:none;-webkit-user-select:none;user-select:none}/* 设置面板的滑块、复选与将来的输入框照常可用、可选中文本。 */#titleScreen input,#gameRoot input,#titleScreen textarea,#gameRoot textarea,.overlay input,.overlay textarea,.overlay select{-webkit-user-select:text;user-select:text}*{box-sizing:border-box}body{margin:0;background:#17261f;color:#f3f5eb;font:16px/1.8 "Microsoft YaHei",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;gap:12px}h1,h2{font-weight:400;margin:0}h1{font:500 clamp(24px,4vw,44px)/1.4 "Songti SC","SimSun",serif;letter-spacing:2px}h2{font-size:16px;letter-spacing:1px}.title-eyebrow{font:10px/1.6 Georgia,serif;letter-spacing:3px;color:#8fb99b;margin:0 0 6px}#titleScreen{width:min(560px,94vw)}.title-card{border:1px solid #3b5548;background:#1c3028;border-radius:10px;padding:clamp(20px,4vw,34px);box-shadow:0 12px 40px #0003}.title-actions{display:grid;gap:8px;margin-top:20px}.title-note{font-size:12px;color:#b9cbbd;line-height:1.7;margin:12px 0 0}.title-note:empty{display:none}/* 标题背景由工程素材渲染：cover 保持比例，左侧渐变保证标题与按钮对比度。 */#titleScreen.has-bg{position:fixed;inset:0;width:auto;max-width:none;display:flex;align-items:center;justify-content:center;padding:clamp(16px,4vw,48px);overflow:auto}#titleBg{position:absolute;inset:0;overflow:hidden;z-index:0}#titleBg img{width:100%;height:100%;object-fit:cover;display:block}#titleBg::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,#0b1712f2 0%,#0b1712b8 42%,#0b171226 78%,#0b171200 100%),linear-gradient(0deg,#0b1712cc 0%,#0b171200 45%)}#titleScreen.has-bg .title-card{position:relative;z-index:1;background:#16261fe8}#gameRoot{width:min(1100px,96vw)}#scene{aspect-ratio:16/9;position:relative;overflow:hidden;background:#dfe7dd;border-radius:8px;cursor:pointer;width:100%}#layers{position:absolute;inset:0;pointer-events:none}.visual-layer{position:absolute}.visual-layer img{width:100%;height:100%;display:block;transform-origin:bottom center}.breathe{animation:b 4s ease-in-out infinite}.sway{animation:s 5s ease-in-out infinite}@keyframes b{50%{transform:scaleY(1.017)}}@keyframes s{0%,100%{transform:rotate(-1deg)}50%{transform:rotate(1deg)}}#box{position:absolute;bottom:5%;left:5%;right:5%;padding:clamp(8px,2vw,18px) clamp(12px,2vw,22px);background:#fbfff1ed;color:#273d35;border-radius:6px;font-size:clamp(11px,1.6vw,18px)}#who{font-weight:bold;color:#3f6753}#text{white-space:pre-wrap;overflow-wrap:anywhere}#hint{font-size:10px;text-align:right;color:#76876c}#choices{position:absolute;top:10%;left:20%;right:20%;display:grid;gap:6px}button{font:inherit;font-size:clamp(11px,1.3vw,14px);background:#f3f5eb;color:#273d35;border:1px solid #b7c2ad;border-radius:5px;padding:8px 14px;cursor:pointer}button:hover{background:#e7efdf}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible{outline:2px solid #8fb99b;outline-offset:2px}#playBar{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}#playBar button{font-size:12px;padding:6px 12px}#menuBtn{background:#1c3028;color:#e9f1e4;border-color:#3b5548}.overlay{position:fixed;inset:0;background:#0b1511cc;display:flex;align-items:center;justify-content:center;padding:16px;z-index:30}.panel{width:min(520px,92vw);max-height:88vh;overflow:auto;background:#1c3028;border:1px solid #3b5548;border-radius:10px;padding:clamp(18px,3vw,28px);box-shadow:0 18px 50px #0005}.menu-actions{display:grid;gap:8px;margin-top:16px}.note{font-size:12px;color:#b9cbbd;line-height:1.7;margin:12px 0 0;overflow-wrap:anywhere}.note:empty{display:none}#audioPanel{margin-top:14px;border-top:1px solid #3b5548;padding-top:12px}.audio-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}#audioStatus{color:#b9cbbd;font-size:12px;line-height:1.6}#audioStatus.audio-error{color:#ffb4a8}#audioMixers{display:grid;gap:6px}#audioMixers label{display:grid;grid-template-columns:54px 1fr 40px;align-items:center;gap:8px;font-size:12px;color:#d7e3d5}#audioMixers input[type=range]{width:100%;accent-color:#8fb99b}#audioMixers span{text-align:right;font:11px monospace;color:#9db3a4}#audioMixers .mute-label{display:flex;grid-template-columns:none;gap:8px}.mute-label input{width:auto;accent-color:#8fb99b}#msg{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#0f1d17e8;border:1px solid #3b5548;color:#eef5ea;padding:9px 16px;border-radius:6px;font-size:12px;max-width:92vw;z-index:40;pointer-events:none}#msg:empty{display:none}[hidden]{display:none!important}@media(max-width:640px){body{padding:10px;gap:8px}.title-card{padding:18px}.title-actions button{width:100%}#playBar{justify-content:space-between}#playBar button{flex:1}.panel{padding:16px;max-height:90vh}#audioMixers label{grid-template-columns:44px 1fr 34px}#scene{aspect-ratio:16/10}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}`;
if(typeof module!=='undefined')module.exports={paperPlayer,paperPlayerCSS};
