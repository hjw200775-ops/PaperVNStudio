/* V0.5 基础音频：统一音频层。
 * createPaperAudio() 返回两部分：
 *   pure    —— 只做计算的纯函数（音量、指令归一化、WAV 头、错误分类），
 *              编辑器、导出播放器与 Node 测试共用同一份实现；
 *   runtime —— 真正创建播放对象、启动/停止/淡变、管理计时器的运行层。
 * 纯函数不碰 DOM / Audio，运行层不解释剧情：两者都靠同一套指令结构通信。
 * 本文件既被 <script> 直接加载，也被 buildGameHTML 用 toString() 内嵌进离线游戏。
 */
function createPaperAudio(){
 const LIMITS={maxSingle:16*1024*1024,maxTotal:96*1024*1024,maxSfx:8,maxDelay:20,maxFade:10};
 const CATEGORIES=['bgm','sfx','voice'];
 const CATEGORY_NAMES={bgm:'背景音乐',sfx:'音效',voice:'语音'};
 const EXT_MIME={wav:'audio/wav',wave:'audio/wav',mp3:'audio/mpeg',ogg:'audio/ogg',oga:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',flac:'audio/flac',webm:'audio/webm'};
 const DEFAULT_PREFS={master:1,bgm:.8,sfx:1,voice:1,muted:false};
 const DEFAULT_FADE={fadeIn:.4,fadeOut:.4};
 const ERRORS={
  permission:{code:'permission',title:'未获得播放许可',hint:'请点击「启用声音」，在浏览器允许后再试一次。'},
  decode:{code:'decode',title:'音频无法解码',hint:'当前运行环境不能解码这个素材；请改用 16-bit PCM WAV。'},
  missing:{code:'missing',title:'音频素材缺失',hint:'素材已被删除或工程引用失效，请重新导入或替换。'},
  unknown:{code:'unknown',title:'播放失败',hint:'请重试；若仍失败可换用 WAV 素材。'}
 };
 const num=(x,d)=>x==null||x===''||!Number.isFinite(+x)?d:+x;
 const clamp=(x,a,b,d)=>Math.min(b,Math.max(a,num(x,d)));
 const finiteDuration=x=>Number.isFinite(+x)&&+x>0?+x:0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));

 /* ---------------- 纯函数：偏好与音量 ---------------- */
 function normalizePrefs(raw){
  const r=raw||{};
  return {master:clamp(r.master,0,1,DEFAULT_PREFS.master),bgm:clamp(r.bgm,0,1,DEFAULT_PREFS.bgm),
   sfx:clamp(r.sfx,0,1,DEFAULT_PREFS.sfx),voice:clamp(r.voice,0,1,DEFAULT_PREFS.voice),muted:!!r.muted};
 }
 /* 最终音量 = 总音量 × 分类音量 × 本次播放音量；静音直接归零但不重启声音。 */
 function finalVolume(prefs,category,itemVolume){
  const p=normalizePrefs(prefs),cat=CATEGORIES.includes(category)?category:'bgm';
  if(p.muted)return 0;
  return clamp(p.master*p[cat]*clamp(itemVolume,0,1,1),0,1,0);
 }

 /* ---------------- 纯函数：V0.8.1 音频演出 ---------------- */
 /* 完整混音：
      最终音量 = Master × 用户分类音量 × 剧情音量 × 播放音量 × Ducking
   用户偏好（prefs）与剧情音量（showVolume）是两条独立链路：
   剧情再大声也不会改写用户在设置里存下的值。 */
 function mixVolume(prefs,category,itemVolume,showVolume,ducking){
  const p=normalizePrefs(prefs),cat=CATEGORIES.includes(category)?category:'bgm';
  if(p.muted)return 0;
  const duck=cat==='bgm'?clamp(ducking==null?1:ducking,0,1,1):1;
  return clamp(p.master*p[cat]*clamp(showVolume==null?1:showVolume,0,1,1)*clamp(itemVolume,0,1,1)*duck,0,1,0);
 }
 /* 交叉淡化增益曲线：linear 是线性；equalPower 用 sin/cos，保证中途功率不变（听感不塌）。 */
 function crossfadeGains(progress,curve){
  const p=clamp(progress,0,1,0);
  if(curve==='equalPower')return {out:Math.cos(p*Math.PI/2),in:Math.sin(p*Math.PI/2)};
  return {out:1-p,in:p};
 }
 /* 循环区间：off / all（整曲循环）/ region（从曲首进入 start–end 区间后反复）。 */
 function loopSpec(raw){
  const r=raw||{};
  const mode=['off','all','region'].includes(r.mode)?r.mode:(r.enabled===false?'off':(r.end>0?'region':(r.loop?'all':'off')));
  const start=clamp(r.start,0,86400,0);
  const end=clamp(r.end,0,86400,0);
  if(mode==='off')return {mode:'off',start:0,end:0};
  if(mode==='all')return {mode:'all',start:0,end:0};
  if(!(end>start))return {mode:'all',start:0,end:0};
  return {mode:'region',start,end};
 }
 /* Ducking 参数：level 是「压低到原来的多少」，0.35 表示降到 35%。 */
 function duckSpec(raw){
  const r=raw||{};
  return {enabled:r.enabled!==false,level:clamp(r.level==null?r.strength:r.level,0,1,.35),
   attack:clamp(r.attack,0,LIMITS.maxFade,.25),release:clamp(r.release,0,LIMITS.maxFade,.6)};
 }
 /* 音频演出动作的归一化：把动作参数变成音频引擎能直接执行的指令。
    这里只做「值域与缺省」，不读 DOM、不创建播放对象，Node 测试可直接断言。 */
 function audioActionSpec(type,params){
  const p=params||{};
  const spec={type,audioId:typeof p.audioId==='string'?p.audioId:''};
  switch(type){
   case 'audio.bgm.play':
    return {...spec,action:'play',volume:clamp(p.volume,0,1,1),fadeIn:clamp(p.fadeIn,0,LIMITS.maxFade,.8),
     loop:loopSpec({mode:p.loopMode,start:p.loopStart,end:p.loopEnd})};
   case 'audio.bgm.stop':
    return {...spec,action:'stop',fadeOut:clamp(p.fadeOut,0,LIMITS.maxFade,1)};
   case 'audio.bgm.crossfade':
    return {...spec,action:'crossfade',volume:clamp(p.volume,0,1,1),duration:clamp(p.duration,0,LIMITS.maxFade,2),
     curve:p.curve==='equalPower'?'equalPower':'linear',
     loop:loopSpec({mode:p.loopMode,start:p.loopStart,end:p.loopEnd})};
   case 'audio.bgm.volume':
    return {...spec,action:'volume',volume:clamp(p.volume,0,1,1),duration:clamp(p.duration,0,LIMITS.maxFade,.8)};
   case 'audio.bgm.loop':
    return {...spec,action:'loop',loop:loopSpec({mode:p.loopMode,start:p.loopStart,end:p.loopEnd})};
   case 'audio.sfx.play':
    return {...spec,action:'sfx',volume:clamp(p.volume,0,1,1),delay:clamp(p.delay,0,LIMITS.maxDelay,0),
     key:typeof p.key==='string'?p.key:''};
   case 'audio.sfx.stop':
    return {...spec,action:'sfxStop',key:typeof p.key==='string'?p.key:''};
   case 'audio.voice.play':
    return {...spec,action:'voice',volume:clamp(p.volume,0,1,1),duck:p.duck!==false};
   case 'audio.voice.stop':
    return {...spec,action:'voiceStop'};
   case 'audio.bus.volume':
    return {...spec,action:'bus',bus:CATEGORIES.includes(p.bus)?p.bus:'bgm',
     volume:clamp(p.volume,0,1,1),duration:clamp(p.duration,0,LIMITS.maxFade,.6)};
   case 'audio.ducking':
    return {...spec,action:'ducking',duck:duckSpec({enabled:p.enabled,level:p.level,attack:p.attack,release:p.release})};
   default:
    return null;
  }
 }
 function formatSeconds(sec){
  const s=Math.max(0,finiteDuration(sec));
  return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0')+'.'+String(Math.floor((s%1)*10));
 }
 function formatBytes(n){
  const b=Math.max(0,num(n,0));
  return b>=1024*1024?(b/1024/1024).toFixed(1)+' MB':b>=1024?(b/1024).toFixed(0)+' KB':b+' B';
 }

 /* ---------------- 纯函数：逐句音频指令 ---------------- */
 /* 节点音频：bgm 缺省/null = 沿用；stop = 停止；play = 从头播放（同一首也是从头）。
    sceneMode 不参与：画面独立不等于音乐独立。 */
 function normalizeCue(raw){
  const a=raw||{},out={bgm:null,sfx:[],voice:null};
  const b=a.bgm;
  if(b&&b.action==='stop')out.bgm={action:'stop',fadeOut:clamp(b.fadeOut,0,LIMITS.maxFade,DEFAULT_FADE.fadeOut)};
  else if(b&&b.action==='play'&&typeof b.audioId==='string'&&b.audioId){
   out.bgm={action:'play',audioId:b.audioId,volume:clamp(b.volume,0,1,1),loop:!!b.loop,
    fadeIn:clamp(b.fadeIn,0,LIMITS.maxFade,DEFAULT_FADE.fadeIn),
    fadeOut:clamp(b.fadeOut,0,LIMITS.maxFade,DEFAULT_FADE.fadeOut)};
  }
  if(Array.isArray(a.sfx))for(const s of a.sfx){
   if(!s||typeof s.audioId!=='string'||!s.audioId)continue;
   out.sfx.push({id:typeof s.id==='string'?s.id:'',audioId:s.audioId,
    volume:clamp(s.volume,0,1,1),delay:clamp(s.delay,0,LIMITS.maxDelay,0)});
  }
  if(a.voice&&typeof a.voice.audioId==='string'&&a.voice.audioId){
   out.voice={audioId:a.voice.audioId,volume:clamp(a.voice.volume,0,1,1)};
  }
  return out;
 }
 function emptyCue(node){return normalizeCue(node&&node.audio)}

 /* ---------------- 纯函数：素材解析与校验 ---------------- */
 function decodeDataUrl(dataUrl){
  if(typeof dataUrl!=='string')throw Error('音频数据为空');
  const m=/^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl);
  if(!m)throw Error('音频素材不是内嵌的 data: 音频');
  const b64=m[2];
  let bytes;
  if(typeof Buffer!=='undefined'&&typeof Buffer.from==='function'){bytes=new Uint8Array(Buffer.from(b64,'base64'))}
  else{
   const raw=atob(b64);bytes=new Uint8Array(raw.length);
   for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  }
  if(!bytes.length)throw Error('音频文件是空的');
  return {mime:m[1].toLowerCase(),bytes};
 }
 /* 只认结构完整的 RIFF/WAVE：损坏文件在导入阶段就拒绝，不留到播放时无声失败。 */
 function wavInfo(bytes){
  const u=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  const str=(a,b)=>String.fromCharCode.apply(null,u.subarray(a,b));
  const le=(a,n)=>{let v=0;for(let i=0;i<n;i++)v+=u[a+i]*(256**i);return v};
  if(u.length<44||str(0,4)!=='RIFF'||str(8,12)!=='WAVE')throw Error('不是有效的 WAV 文件（缺少 RIFF/WAVE 头）');
  let at=12,fmt=null,dataSize=0,foundData=false;
  while(at+8<=u.length){
   const name=str(at,at+4),size=le(at+4,4),body=at+8;
   if(size<0||body+size>u.length)throw Error('WAV 文件已损坏（数据块长度越界）');
   if(name==='fmt '&&size>=16){
    const format=le(body,2),channels=le(body+2,2),sampleRate=le(body+4,4),byteRate=le(body+8,4),bits=le(body+14,2);
    if(!channels||!sampleRate||!byteRate||!bits)throw Error('WAV 文件已损坏（格式参数无效）');
    if(format!==1&&format!==3&&format!==0xFFFE)throw Error('暂不支持压缩编码的 WAV，请使用 PCM WAV');
    fmt={format,channels,sampleRate,byteRate,bits,blockAlign:le(body+12,2)};
   }
   if(name==='data'){dataSize=size;foundData=true}
   at=body+size+(size%2);
  }
  if(!fmt)throw Error('WAV 文件缺少 fmt 数据块');
  if(!foundData||dataSize<=0)throw Error('WAV 文件没有音频数据');
  if(fmt.byteRate<=0)throw Error('WAV 文件已损坏（字节率为零）');
  return {duration:dataSize/fmt.byteRate,sampleRate:fmt.sampleRate,channels:fmt.channels,bits:fmt.bits,format:fmt.format,bytes:u.length};
 }
 function extOf(name){
  const m=/\.([a-z0-9]+)$/i.exec(String(name||''));
  return m?m[1].toLowerCase():'';
 }
 function classifyError(err){
  const code=err&&(err.name||err.code)||'';
  const text=String(err&&err.message||err||'');
  if(/NotAllowed|not allowed|play\(\) failed|user gesture/i.test(code+' '+text))return ERRORS.permission;
  if(/NotSupported|decode|SRC_NOT_SUPPORTED|MEDIA_ERR|format|codec/i.test(code+' '+text))return ERRORS.decode;
  return ERRORS.unknown;
 }
 function errorInfo(kind,audioId,detail){
  const base=ERRORS[kind]||ERRORS.unknown;
  return {kind,code:base.code,title:base.title,hint:base.hint,audioId:audioId||'',detail:String(detail||'')};
 }
 /* 导入校验：单文件与总量上限、扩展名/MIME、WAV 头，以及「当前环境确实能解码」。 */
 function checkImport({name,size,mime,bytes,ext,totalBytes,elementFactory,canPlayType,headerChecked}){
  if(!bytes||!bytes.length)return {ok:false,message:'「'+name+'」是空文件，无法导入。'};
  if(bytes.length>LIMITS.maxSingle)return {ok:false,message:'「'+name+'」超过单文件 '+formatBytes(LIMITS.maxSingle)+' 限制，已拒绝。'};
  if(num(totalBytes,0)+bytes.length>LIMITS.maxTotal)return {ok:false,message:'音频总量将超过 '+formatBytes(LIMITS.maxTotal)+'，已拒绝；请先移除不用的素材。'};
  const e=ext||extOf(name);
  if(!EXT_MIME[e])return {ok:false,message:'「'+name+'」的格式不受支持；本版可靠支持 PCM WAV，其他格式需当前环境能解码。'};
  const expected=EXT_MIME[e];
  if(mime&&mime!==expected&&!(e==='wav'&&/wav|x-wav|vnd\.wave/i.test(mime)))return {ok:false,message:'「'+name+'」扩展名与文件类型不一致，已拒绝。'};
  if((e==='wav'||e==='wave')&&!headerChecked){try{wavInfo(bytes)}catch(err){return {ok:false,message:'「'+name+'」：'+err.message+'。'}}}
  else{
   const probe=elementFactory?elementFactory():null;
   const can=canPlayType?canPlayType(expected):(probe&&probe.canPlayType?probe.canPlayType(expected):'');
   if(!can)return {ok:false,message:'当前运行环境无法解码 '+e.toUpperCase()+'（'+expected+'），已拒绝；请改用 PCM WAV。'};
  }
  return {ok:true,ext:e,mime:expected,bytes:bytes.length};
 }
 /* 时长异步读取：优先让浏览器给元数据；失败时 PCM WAV 用文件头兜底并给出明确提示。 */
 function readMeta(dataUrl,opts){
  const o=opts||{};
  return Promise.resolve().then(async()=>{
   /* M3：暂存素材传进来的是受控 paper 协议地址，不能再走 decodeDataUrl。
      WAV 时长已由主进程从文件头算出，这里只补浏览器元数据。 */
   let bytes=null,mime=String(o.mime||'').toLowerCase();
   if(/^data:/i.test(dataUrl)){const parsed=decodeDataUrl(dataUrl);bytes=parsed.bytes;mime=parsed.mime}
   let header=null;
   if(bytes&&/\bwav\b/i.test(mime))header=wavInfo(bytes);
   else if(Number.isFinite(o.headerDuration))header={duration:o.headerDuration};
   const el=o.elementFactory?o.elementFactory():null;
   if(!el||!el.addEventListener)return {duration:header?header.duration:0,source:header?'header':'unknown',note:header?'已按 WAV 文件头读取时长；当前环境未提供解码元数据。':'当前环境无法读取时长，已按未知时长导入。'};
   return await new Promise(resolve=>{
    let done=false;
    const finish=(duration,source,note)=>{if(done)return;done=true;clearTimeout(timer);resolve({duration:Math.max(0,duration||0),source,note:note||''})};
    const timer=setTimeout(()=>finish(header?header.duration:0,header?'header':'unknown',header?'已按 WAV 文件头读取时长；浏览器元数据读取超时。':'浏览器元数据读取超时，时长未知。'),1800);
    try{
     el.preload='metadata';
     el.addEventListener('loadedmetadata',()=>finish(Number.isFinite(el.duration)?el.duration:(header?header.duration:0),'element',''));
     el.addEventListener('error',()=>finish(header?header.duration:0,header?'header':'unknown',header?'已按 WAV 文件头读取时长；当前环境无法解码该素材的元数据。':'当前环境无法解码该素材，时长未知。'));
     el.src=dataUrl;
     if(el.load)el.load();
    }catch(e){finish(header?header.duration:0,header?'header':'unknown','读取音频元数据失败：'+e.message)}
   });
  });
 }
 /* 1 帧静音 PCM WAV：只用来在真实用户操作中取得播放许可，不播放任何作品素材。 */
 function silenceUrl(){
  const u=new Uint8Array(46);
  const ascii=(a,s)=>{for(let i=0;i<s.length;i++)u[a+i]=s.charCodeAt(i)};
  const le=(a,v,n)=>{for(let i=0;i<n;i++)u[a+i]=(v>>>(8*i))&255};
  ascii(0,'RIFF');le(4,38,4);ascii(8,'WAVE');ascii(12,'fmt ');le(16,16,4);
  le(20,1,2);le(22,1,2);le(24,8000,4);le(28,16000,4);le(32,2,2);le(34,16,2);
  ascii(36,'data');le(40,2,4);le(44,0,2);
  let s='';for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);
  return 'data:audio/wav;base64,'+(typeof btoa!=='undefined'?btoa(s):Buffer.from(u).toString('base64'));
 }

 /* ---------------- 运行层：实际播放、停止与淡变 ---------------- */
 function createRuntime(opts){
  const o=opts||{};
  const makeEl=o.elementFactory||(()=>new Audio());
  const assetData=o.assetData||(()=>'');
  const onStatus=o.onStatus||(()=>{});
  let prefs=normalizePrefs(o.prefs);
  /* V0.8.1：剧情音量、Ducking 与循环统计。
     showVolume 只由演出动作改写，prefs 只由玩家设置改写，两者相乘、互不覆盖。 */
  let showVolume={bgm:1,sfx:1,voice:1};
  let duck={enabled:true,level:.35,attack:.25,release:.6,active:false,factor:1};
  let duckTimer=null,duckHold=0;
  let loopTimer=null,loopStats={jumps:0,lastJumpAt:0,lastGapMs:null,maxGapMs:null,overrunMaxMs:0,overrunSumMs:0};
  let audioEvents=[];
  const busVolume=cat=>clamp(showVolume[cat],0,1,1);
  const duckFactor=cat=>cat==='bgm'?duck.factor:1;
  function channelVolume(ch,factor){
   return Math.min(1,mixVolume(prefs,ch.kind,ch.itemVolume,busVolume(ch.kind),duckFactor(ch.kind))*num(factor,1));
  }
  const noteAudio=(ev)=>audioEvents=[{at:Date.now(),...ev},...audioEvents].slice(0,40);
  let unlocked=false,generation=0,bgm=null,voice=null,preview=null;
  let sfxChannels=[],sfxTimers=[],fadeTimers=[],pendingSwitch=null,retiring=[];
  const sfxHandles=new Map();
  let errors=[],lastEnter=null,disposed=false;
  const emit=()=>{try{onStatus(status())}catch{}};
  const record=(kind,audioId,detail,label)=>{
   const info=errorInfo(kind,audioId,detail);info.label=label||'';
   errors=[info,...errors].slice(0,8);emit();return info;
  };
  function hardStop(ch){
   if(!ch||!ch.el)return;
   try{ch.el.pause()}catch{}
   try{ch.el.currentTime=0}catch{}
   ch.done=true;
  }
  function clearFades(){
   for(const t of fadeTimers){clearTimeout(t.t);clearInterval(t.i)}fadeTimers=[];
   /* retiring 里是 {ch} 包装（finish 按 x.ch 过滤），这里必须取出真正的通道，
      否则淡出中的旧曲永远不会被停掉。 */
   for(const r of retiring)hardStop(r&&r.ch?r.ch:r);
   retiring=[];
  }
  function cancelPending(){if(pendingSwitch){clearTimeout(pendingSwitch.timer);pendingSwitch=null}}
  function leave(){
   for(const t of sfxTimers)clearTimeout(t);sfxTimers=[];
   for(const ch of sfxChannels)hardStop(ch);
   sfxChannels=[];
   if(voice){hardStop(voice);voice=null;if(duckHold>0)duckPop()}
  }
  function stopPreview(silent){
   if(preview){hardStop(preview);preview=null;if(!silent)emit()}
  }
  function stopBgm(immediate){
   cancelPending();
   if(bgm){hardStop(bgm);bgm=null}
   clearFades();
   if(!immediate)emit();
  }
  function channel(kind,audioId,itemVolume,loop,label){
   const src=assetData(audioId);
   if(!src){record('missing',audioId,'工程里找不到这个音频素材',label);return null}
   let el;
   try{el=makeEl()}catch(e){record('unknown',audioId,e.message,label);return null}
   const ch={kind,audioId,itemVolume:clamp(itemVolume,0,1,1),loop:!!loop,el,label:label||'',done:false,startedAt:0,playVolume:0};
   try{
    el.src=src;el.loop=!!loop;el.currentTime=0;
    el.volume=channelVolume(ch,1);
   }catch(e){record('decode',audioId,e.message,label);return null}
   ch.playVolume=el.volume;
   return ch;
  }
  /* 返回真实播放 Promise 的结果；失败不把状态留在「正在播放」。 */
  function start(ch,myGen){
   if(!ch)return Promise.resolve({ok:false,kind:'missing'});
   const el=ch.el;
   let pr;
   try{pr=el.play()}catch(e){return Promise.resolve(onFail(ch,e))}
   return Promise.resolve(pr).then(()=>{
    if(myGen!==generation||ch.done){hardStop(ch);return {ok:true,cancelled:true,ch}}
    ch.startedAt=Date.now();
    el.onerror=()=>{if(ch.done)return;const err=(el.error&&el.error.message)||'播放中出现解码错误';record('decode',ch.audioId,err,ch.label);hardStop(ch);emit()};
    emit();
    return {ok:true,ch};
   }).catch(e=>onFail(ch,e));
   function onFail(ch2,e){
    const kind=classifyError(e).code;
    const info=record(kind,ch2.audioId,(e&&e.message)||'',ch2.label);
    hardStop(ch2);
    if(bgm===ch2)bgm=null;
    if(voice===ch2)voice=null;
    if(preview===ch2)preview=null;
    sfxChannels=sfxChannels.filter(x=>x!==ch2);
    emit();
    return {ok:false,kind,info,ch:ch2};
   }
  }
  /* 淡变按当前偏好实时计算目标音量，因此调音量不会打断淡变或重启声音。 */
  function fade(ch,from,to,seconds,myGen,after){
   if(!ch||ch.done)return (after||(()=>{}))();
   const dur=Math.max(0,Math.min(LIMITS.maxFade,num(seconds,0)))*1000;
   if(dur<20){try{ch.el.volume=channelVolume(ch,clamp(to,0,1,1))}catch{};return (after||(()=>{}))()}
   const t0=Date.now();let iv=null,tm=null;
   const apply=()=>{
    if(myGen!==generation||ch.done)return;
    const r=Math.min(1,(Date.now()-t0)/dur),factor=from+(to-from)*r;
    ch.fadeFactor=factor;
    try{ch.el.volume=channelVolume(ch,factor)}catch{}
   };
   iv=setInterval(apply,30);
   tm=setTimeout(()=>{clearInterval(iv);apply();fadeTimers=fadeTimers.filter(x=>x.i!==iv);if(after&&myGen===generation&&!ch.done)after()},dur+20);
   fadeTimers.push({i:iv,t:tm});
  }
  function applyPrefs(){
   const all=[bgm,voice,preview,...sfxChannels,...retiring.map(r=>r.ch)].filter(Boolean);
   for(const ch of all){
    if(ch.el&&!ch.done)try{ch.el.volume=channelVolume(ch,num(ch.fadeFactor,1))}catch{}
   }
  }
  function startBgm(spec,myGen,label){
   const ch=channel('bgm',spec.audioId,spec.volume,spec.loop,label);
   if(!ch)return Promise.resolve({ok:false});
   bgm=ch;
   const fi=clamp(spec.fadeIn,0,LIMITS.maxFade,DEFAULT_FADE.fadeIn);
   if(fi>0)try{ch.el.volume=0}catch{}
   return start(ch,myGen).then(r=>{
    if(!r.ok||r.cancelled||myGen!==generation)return r;
    if(fi>0)fade(ch,0,1,fi,myGen);
    emit();return r;
   });
  }
  /* 切换：旧曲淡出结束后新曲淡入（首版不做复杂叠轨）。快速再次切句会取消过期的切换。
     淡变结束回调与兜底计时器可能同时到达，finish 用 once 守卫，绝不让旧曲再响一次。 */
  function switchBgm(spec,myGen,label){
   const old=bgm;bgm=null;
   const fo=old?clamp(spec.fadeOut,0,LIMITS.maxFade,DEFAULT_FADE.fadeOut):0;
   let done=false,started=null;
   const finish=()=>{
    if(done)return started||Promise.resolve({ok:true});done=true;
    if(myGen!==generation)return Promise.resolve({ok:true,cancelled:true});
    pendingSwitch=null;
    if(old){hardStop(old);retiring=retiring.filter(x=>x.ch!==old)}
    started=startBgm(spec,myGen,label);
    return started;
   };
   if(old&&fo>0){
    retiring.push({ch:old});
    fade(old,1,0,fo,myGen,()=>{if(myGen===generation)finish()});
    pendingSwitch={gen:myGen,spec,label,finish,
     timer:setTimeout(()=>{if(myGen===generation&&pendingSwitch&&pendingSwitch.gen===myGen)finish()},fo*1000+40)};
    return Promise.resolve({ok:true,pending:true});
   }
   if(old)hardStop(old);
   return finish();
  }
  function scheduleSfx(s,myGen,label){
   let tm=null;
   const run=()=>{
    if(myGen!==generation)return;                 /* 提前切句：延迟任务已被取消 */
    sfxTimers=sfxTimers.filter(t=>t!==tm);
    if(sfxChannels.length>=LIMITS.maxSfx){const drop=sfxChannels.shift();hardStop(drop)}
    const ch=channel('sfx',s.audioId,s.volume,false,label);
    if(!ch)return;
    sfxChannels.push(ch);
    ch.el.onended=()=>{hardStop(ch);sfxChannels=sfxChannels.filter(x=>x!==ch);emit()};
    start(ch,myGen).then(r=>{if(!r.ok)sfxChannels=sfxChannels.filter(x=>x!==ch)});
   };
   const delay=Math.max(0,Math.min(LIMITS.maxDelay,num(s.delay,0)))*1000;
   if(!delay){run();return}
   tm=setTimeout(run,delay);sfxTimers.push(tm);
  }
  /* 进入一句。cue 为节点指令；rebuild 为真时按 bgmState 从曲首重建（定点试玩/读档/返回/重开）。
     普通推进时 bgm 指令为空 = 沿用，当前播放位置不动；显式 play 一律从头（包括同一首）。 */
  /* ---------------- V0.8.1：音频演出（交叉淡化 / 循环区间 / Ducking / 独立音效） ----------------
   * 这一层只做「副作用」，不理解剧情；演出目标状态由 performance.js 计算，
   * 播放器在动作起点调用这里，跳过动画时用 applyAudioState() 一次性落到终态。 */
  /* 循环检查同时挂 rAF 与低频定时器：
     - 窗口可见时 rAF 每帧检查，接缝误差在一帧内；
     - 窗口被遮挡/后台时 rAF 不触发，定时器兜底（浏览器会把它节流到 ~1s，
       这是平台限制，实测值如实记录在验收报告里，不宣称采样级无缝）。 */
  function ensureLoopTicker(){
   if(loopTimer)return;
   const check=()=>{
    const ch=bgm;
    if(!ch||ch.done||!ch.loopWindow||ch.loopWindow.mode!=='region')return;
    const w=ch.loopWindow;
    let t=0;try{t=ch.el.currentTime}catch{return}
    if(t>=w.end){
     try{ch.el.currentTime=w.start}catch{return}
     const now=Date.now();
     const gap=loopStats.lastJumpAt?now-loopStats.lastJumpAt:null;
     /* 接缝误差：发现越界时已经超出 loopEnd 多少毫秒（轮询周期决定上限）。 */
     const overrun=Math.max(0,(t-w.end)*1000);
     loopStats.jumps++;
     loopStats.overrunSumMs+=overrun;
     loopStats.overrunMaxMs=Math.max(loopStats.overrunMaxMs,overrun);
     loopStats.lastGapMs=gap;
     if(gap!=null)loopStats.maxGapMs=Math.max(loopStats.maxGapMs||0,gap);
     loopStats.lastJumpAt=now;
     noteAudio({kind:'loop',audioId:ch.audioId,from:+t.toFixed(3),to:w.start});
    }
   };
   const handles=[];
   if(typeof requestAnimationFrame==='function'){
    let stopped=false;
    const frame=()=>{ if(stopped)return; check(); if(!stopped)rafId=requestAnimationFrame(frame); };
    let rafId=requestAnimationFrame(frame);
    handles.push(()=>{stopped=true;cancelAnimationFrame(rafId)});
   }
   const iv=setInterval(check,400);
   if(iv.unref)iv.unref();
   handles.push(()=>clearInterval(iv));
   /* 媒体元素自己的 timeupdate 不受「窗口不可见」的定时器节流影响（约 4Hz），
      在没有 rAF 的环境里把接缝误差从 1s 拉到 ~250ms。 */
   const ch=bgm;
   if(ch&&ch.el&&typeof ch.el.addEventListener==='function'&&!ch.el.__loopBound){
    ch.el.__loopBound=true;
    ch.el.addEventListener('timeupdate',()=>{try{check()}catch{}});
   }
   loopTimer={stop(){for(const h of handles)try{h()}catch{}},handles};
  }
  function stopLoopTicker(){if(loopTimer){try{loopTimer.stop()}catch{}loopTimer=null}}
  function applyLoop(ch,loop){
   const w=loop||{mode:'off',start:0,end:0};
   ch.loopWindow=w;
   try{ch.el.loop=w.mode==='all'}catch{}
   if(w.mode==='region')ensureLoopTicker();
  }
  /* 剧情音量：只改 showVolume，不写 prefs，玩家在设置里的值永远不会被覆盖。 */
  function setBusVolume(cat,value,duration){
   const c=CATEGORIES.includes(cat)?cat:'bgm';
   const target=clamp(value,0,1,1);
   const from=busVolume(c);
   const dur=Math.max(0,num(duration,0))*1000;
   if(dur<20){showVolume={...showVolume,[c]:target};applyPrefs();return showVolume[c]}
   const t0=Date.now(),myGen=generation;
   const iv=setInterval(()=>{
    if(myGen!==generation){clearInterval(iv);return}
    const p=Math.min(1,(Date.now()-t0)/dur);
    showVolume={...showVolume,[c]:from+(target-from)*p};
    applyPrefs();
    if(p>=1)clearInterval(iv);
   },30);
   fadeTimers.push({i:iv,t:null});
   return showVolume[c];
  }
  function bgmVolume(target,options){
   const ch=bgm;
   if(!ch||ch.done)return {ok:false};
   const to=clamp(target,0,1,1);
   const from=ch.itemVolume;
   const dur=Math.max(0,num(options&&options.duration,0))*1000;
   if(dur<20){ch.itemVolume=to;try{ch.el.volume=channelVolume(ch,num(ch.fadeFactor,1))}catch{};emit();return {ok:true,volume:to}}
   const t0=Date.now(),myGen=generation;
   const iv=setInterval(()=>{
    if(myGen!==generation||ch.done){clearInterval(iv);return}
    const p=Math.min(1,(Date.now()-t0)/dur);
    ch.itemVolume=from+(to-from)*p;
    try{ch.el.volume=channelVolume(ch,num(ch.fadeFactor,1))}catch{}
    if(p>=1){clearInterval(iv);emit()}
   },30);
   fadeTimers.push({i:iv,t:null});
   return {ok:true,pending:true};
  }
  /* 交叉淡化：新旧两个通道同时存在，按曲线此消彼长；旧通道在新曲到位后才销毁。 */
  function bgmCrossfade(spec,label){
   const myGen=generation;
   const target=spec&&spec.audioId;
   if(!target)return Promise.resolve({ok:false,kind:'missing'});
   cancelPending();
   const old=bgm;
   if(old&&!old.done&&old.audioId===target){
    /* 同一首：不新建实例、不回到曲首，只做音量过渡——否则会出现双重 BGM。 */
    bgmVolume(spec.volume==null?1:spec.volume,{duration:spec.duration});
    if(spec.loop)applyLoop(old,spec.loop);
    return Promise.resolve({ok:true,same:true});
   }
   const ch=channel('bgm',target,spec.volume,false,label);
   if(!ch)return Promise.resolve({ok:false,kind:'missing'});
   bgm=ch;
   if(spec.loop)applyLoop(ch,spec.loop);
   ch.fadeFactor=0;
   try{ch.el.volume=0}catch{}
   if(old)retiring.push({ch:old});
   const dur=Math.max(0,num(spec.duration,0))*1000;
   const curve=spec.curve==='equalPower'?'equalPower':'linear';
   const t0=Date.now();
   let iv=null;
   const step=()=>{
    if(myGen!==generation){clearInterval(iv);return}
    const p=dur<=0?1:Math.min(1,(Date.now()-t0)/dur);
    const g=crossfadeGains(p,curve);
    ch.fadeFactor=g.in;
    try{ch.el.volume=channelVolume(ch,g.in)}catch{}
    if(old&&!old.done){
     old.fadeFactor=g.out;
     try{old.el.volume=channelVolume(old,g.out)}catch{}
    }
    if(p>=1){
     clearInterval(iv);
     if(old&&!old.done){hardStop(old);retiring=retiring.filter(x=>x.ch!==old)}
     noteAudio({kind:'crossfade',to:target,curve,ms:Math.round(dur)});
     emit();
    }
   };
   iv=setInterval(step,30);
   fadeTimers.push({i:iv,t:null});
   noteAudio({kind:'bgm',audioId:target,mode:'crossfade'});
   return start(ch,myGen).then(r=>{emit();return r.ok?{ok:true}:r});
  }
  function duckTarget(){return duck.active&&duck.enabled?duck.level:1}
  function rampDuck(){
   const target=duckTarget();
   const dur=Math.max(0,(duck.active?duck.attack:duck.release))*1000;
   const from=duck.factor,t0=Date.now(),myGen=generation;
   if(duckTimer){clearInterval(duckTimer);duckTimer=null}
   if(dur<20){duck.factor=target;applyPrefs();return}
   duckTimer=setInterval(()=>{
    if(myGen!==generation){clearInterval(duckTimer);duckTimer=null;return}
    const p=Math.min(1,(Date.now()-t0)/dur);
    duck.factor=from+(target-from)*p;
    applyPrefs();
    if(p>=1){clearInterval(duckTimer);duckTimer=null}
   },30);
  }
  /* 连续语音用计数持有，避免每句语音都让 BGM 抖一次。 */
  function duckPush(){duckHold++;duck.active=true;duck.factor=duck.factor||1;rampDuck()}
  function duckPop(){duckHold=Math.max(0,duckHold-1);if(!duckHold){duck.active=false;rampDuck()}}
  function setDucking(spec){
   duck={...duck,...duckSpec({...duck,...(spec||{})})};
   if(!duck.enabled){duck.active=false;duckHold=0}
   rampDuck();emit();return {...duck};
  }
  function sfxPlay(spec,label){
   const myGen=generation;
   const key=spec&&spec.key;
   if(key&&sfxHandles.has(key)){
    const old=sfxHandles.get(key);
    hardStop(old);sfxChannels=sfxChannels.filter(x=>x!==old);sfxHandles.delete(key);
   }
   if(sfxChannels.length>=LIMITS.maxSfx){const drop=sfxChannels.shift();hardStop(drop)}
   const ch=channel('sfx',spec.audioId,spec.volume,false,label);
   if(!ch)return {ok:false};
   sfxChannels.push(ch);
   if(key)sfxHandles.set(key,ch);
   ch.el.onended=()=>{hardStop(ch);sfxChannels=sfxChannels.filter(x=>x!==ch);if(key&&sfxHandles.get(key)===ch)sfxHandles.delete(key);emit()};
   start(ch,myGen).then(r=>{if(!r.ok)sfxChannels=sfxChannels.filter(x=>x!==ch)});
   noteAudio({kind:'sfx',audioId:spec.audioId,key:key||''});
   return {ok:true};
  }
  function sfxStop(key){
   if(!key)return {ok:false};
   const ch=sfxHandles.get(key);
   if(!ch)return {ok:false};
   hardStop(ch);sfxChannels=sfxChannels.filter(x=>x!==ch);sfxHandles.delete(key);emit();
   return {ok:true};
  }
  function voicePlay(spec,label){
   const myGen=generation;
   if(voice){const old=voice;voice=null;hardStop(old);duckPop()}
   const ch=channel('voice',spec.audioId,spec.volume,false,label);
   if(!ch)return {ok:false};
   voice=ch;
   ch.el.onended=()=>{if(voice!==ch)return;voice=null;duckPop();emit()};
   if(spec.duck!==false)duckPush();
   start(ch,myGen).then(r=>{if(!r.ok&&voice===ch){voice=null;duckPop()}});
   noteAudio({kind:'voice',audioId:spec.audioId});
   return {ok:true};
  }
  function voiceStop(){
   if(!voice)return {ok:false};
   const ch=voice;voice=null;hardStop(ch);duckPop();emit();
   return {ok:true};
  }
  /* 跳过演出 / 快进 / 读档：把「可计算的音频终态」一次性落地。
     同一首 BGM 只调音量与循环，不重启（否则切换场景就从头响）。 */
  function applyAudioState(state){
   const s=state||{};
   if(s.buses)for(const c of CATEGORIES)if(Number.isFinite(s.buses[c]))showVolume={...showVolume,[c]:clamp(s.buses[c],0,1,1)};
   if(s.ducking)duck={...duck,...duckSpec({...duck,...s.ducking})};
   const want=s.bgm;
   if(want===null){
    if(bgm){hardStop(bgm);bgm=null}
    stopLoopTicker();
   }else if(want&&want.audioId){
    if(bgm&&!bgm.done&&bgm.audioId===want.audioId){
     bgm.itemVolume=clamp(want.volume,0,1,1);
     bgm.fadeFactor=1;
     if(want.loop)applyLoop(bgm,want.loop);
     try{bgm.el.volume=channelVolume(bgm,1)}catch{}
    }else{
     if(bgm){hardStop(bgm);bgm=null}
     const ch=channel('bgm',want.audioId,want.volume,false,'');
     if(ch){
      bgm=ch;
      if(want.loop)applyLoop(ch,want.loop);
      ch.fadeFactor=1;
      try{ch.el.volume=channelVolume(ch,1)}catch{}
      start(ch,generation);
      if(!want.playing)try{ch.el.pause()}catch{}
     }
    }
   }
   applyPrefs();emit();
   return snapshot();
  }
  function snapshot(){
   const view=ch=>{
    if(!ch)return null;
    let t=0,dur=0,vol=0,paused=true;
    try{t=ch.el.currentTime||0;dur=Number.isFinite(ch.el.duration)?ch.el.duration:0;vol=ch.el.volume||0;paused=!!ch.el.paused}catch{}
    return {audioId:ch.audioId,itemVolume:ch.itemVolume,fade:num(ch.fadeFactor,1),volume:vol,time:t,duration:dur,paused,
     loop:ch.loopWindow?{...ch.loopWindow}:{mode:'off',start:0,end:0}};
   };
   return {unlocked,prefs:{...prefs},buses:{...showVolume},ducking:{...duck,hold:duckHold},
    loop:{...loopStats},bgm:view(bgm),voice:view(voice),sfx:sfxChannels.map(view),
    instances:{bgm:bgm?1:0,retiring:retiring.length,sfx:sfxChannels.length,voice:voice?1:0},
    events:audioEvents.slice(0,12),generation};
  }

  function enter(cue,options){
   const c=normalizeCue(cue),opt=options||{},label=opt.label||'';
   const prevSwitch=pendingSwitch;
   const myGen=++generation;
   lastEnter={cue:c,options:{...opt}};
   stopPreview(true);
   clearFades();
   leave();
   const explicit=!!opt.rebuild||!!(c.bgm&&c.bgm.action);
   if(prevSwitch){
    clearTimeout(prevSwitch.timer);
    pendingSwitch=null;
   }
   const tasks=[];
   if(opt.rebuild){
    /* 返回 / 读档 / 重开：先彻底清掉旧的 BGM 通道，再按目标句状态从曲首重建。 */
    stopBgm(true);
    const st=opt.bgmState;
    if(st&&st.audioId)tasks.push(startBgm({audioId:st.audioId,volume:st.volume,loop:st.loop,fadeIn:st.fadeIn||0},myGen,label));
   }else if(c.bgm&&c.bgm.action==='play'){
    tasks.push(switchBgm(c.bgm,myGen,label));
   }else if(c.bgm&&c.bgm.action==='stop'){
    const old=bgm;bgm=null;
    if(old){
     retiring.push({ch:old});
     fade(old,1,0,c.bgm.fadeOut,myGen,()=>{hardStop(old);retiring=retiring.filter(x=>x.ch!==old);emit()});
    }
   }else{
    /* 沿用：若上一次切换还在淡出，立即把它收尾（新曲从曲首启动），
       不重启已经在播的音乐，也不把这次切换悄悄丢掉。 */
    if(prevSwitch)tasks.push(startBgm(prevSwitch.spec,myGen,prevSwitch.label));
   }
   for(const s of c.sfx)scheduleSfx(s,myGen,label);
   if(c.voice){
    const ch=channel('voice',c.voice.audioId,c.voice.volume,false,label);
    if(ch){voice=ch;ch.el.onended=()=>{if(voice===ch)voice=null;emit()};tasks.push(start(ch,myGen))}
   }
   emit();
   return Promise.all(tasks).then(results=>({ok:results.every(r=>!r||r.ok!==false),results,errors:errors.slice(0,3)}));
  }
  function retry(){return lastEnter?enter(lastEnter.cue,{...lastEnter.options,force:true}):Promise.resolve({ok:false})}
  function setPrefs(patch){prefs=normalizePrefs({...prefs,...(patch||{})});applyPrefs();emit();return prefs}
  function getPrefs(){return {...prefs}}
  function status(){
   const snap=ch=>ch?{audioId:ch.audioId,label:ch.label||'',playing:!!ch.el&&!ch.el.paused&&!ch.el.ended&&!ch.done,
    paused:!!ch.el&&!!ch.el.paused,time:Number.isFinite(ch.el?.currentTime)?ch.el.currentTime:0,
    duration:Number.isFinite(ch.el?.duration)?ch.el.duration:0,loop:!!ch.el?.loop,
    volume:Number.isFinite(ch.el?.volume)?ch.el.volume:0,itemVolume:ch.itemVolume,done:ch.done}:null;
   return {unlocked,prefs:{...prefs},generation,
    bgm:snap(bgm),voice:snap(voice),preview:snap(preview),
    sfx:sfxChannels.map(snap),pendingSfx:sfxTimers.length,
    pendingSwitch:!!pendingSwitch,retiring:retiring.length,
    errors:errors.slice(0,8),disposed};
  }
  /* 真实用户手势里调用：播放一帧静音，验证浏览器是否放行。 */
  function unlock(){
   let el;
   try{el=makeEl()}catch(e){return Promise.resolve({ok:false,...errorInfo('unknown','',e.message)})}
   try{el.src=silenceUrl();el.volume=0;el.loop=false}catch(e){return Promise.resolve({ok:false,...errorInfo('decode','',e.message)})}
   let pr;try{pr=el.play()}catch(e){return Promise.resolve({ok:false,...errorInfo('unknown','',e.message)})}
   return Promise.resolve(pr).then(()=>{try{el.pause()}catch{};unlocked=true;errors=errors.filter(x=>x.code!=='permission');emit();return {ok:true,message:'声音已启用'}})
    .catch(e=>{const info=errorInfo(classifyError(e).code,'',(e&&e.message)||'');unlocked=false;errors=[info,...errors].slice(0,8);emit();return {ok:false,...info}});
  }
  function previewAsset(audioId,category,volume){
   const myGen=++generation;
   stopPreview(true);
   /* 素材试听与游戏试玩不叠音：试听开始时清掉试玩中的声音。 */
   leave();cancelPending();clearFades();
   if(bgm){hardStop(bgm);bgm=null}
   const kind=CATEGORIES.includes(category)?category:'sfx';
   const ch=channel(kind,audioId,num(volume,1),false,'素材试听');
   if(!ch){emit();return Promise.resolve({ok:false})}
   preview=ch;
   return start(ch,myGen).then(r=>{emit();return r});
  }
  function stopAll(){
   generation++;
   cancelPending();clearFades();leave();stopPreview(true);
   duckHold=0;duck.active=false;duck.factor=1;if(duckTimer){clearInterval(duckTimer);duckTimer=null}
   stopLoopTicker();sfxHandles.clear();
   if(bgm){hardStop(bgm);bgm=null}
   emit();
  }
  function dispose(){stopAll();disposed=true;emit()}
  return {enter,retry,unlock,status,setPrefs,getPrefs,previewAsset,stopPreview:()=>{stopPreview()},stopAll,dispose,isUnlocked:()=>unlocked,
   /* V0.8.1 音频演出 API */
   bgmCrossfade,bgmVolume,bgmStop:options=>{const fo=clamp(options&&options.fadeOut,0,LIMITS.maxFade,1);const old=bgm;bgm=null;if(!old)return {ok:false};
     if(fo>0){retiring.push({ch:old});fade(old,1,0,fo,generation,()=>{hardStop(old);retiring=retiring.filter(x=>x.ch!==old);emit()})}else{hardStop(old)}
     noteAudio({kind:'bgm-stop',audioId:old.audioId});emit();return {ok:true}},
   bgmLoop:spec=>{if(!bgm)return {ok:false};applyLoop(bgm,loopSpec(spec));return {ok:true,loop:{...bgm.loopWindow}}},
   setBusVolume,sfxPlay,sfxStop,voicePlay,voiceStop,setDucking,applyAudioState,snapshot,
   getLoopStats:()=>({...loopStats})};
 }

 return {LIMITS,CATEGORIES,CATEGORY_NAMES,EXT_MIME,DEFAULT_PREFS,DEFAULT_FADE,
  pure:{normalizePrefs,finalVolume,normalizeCue,emptyCue,decodeDataUrl,wavInfo,extOf,classifyError,errorInfo,checkImport,readMeta,formatSeconds,formatBytes,silenceUrl,
   mixVolume,crossfadeGains,loopSpec,duckSpec,audioActionSpec},
  runtime:createRuntime};
}
if(typeof module!=='undefined')module.exports=createPaperAudio;
