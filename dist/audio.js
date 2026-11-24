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
  /* 播放事件计数（M2：严格验收用）。区分「请求/开始/完成/合法取消/真正失败/解码失败/回退」，
     合法取消与预期回退不算失败，真正播放失败必须可被验收脚本发现。 */
  let playStats={requested:0,started:0,completed:0,cancelled:0,failed:0,decodeFailed:0,fallback:0};
  const busVolume=cat=>clamp(showVolume[cat],0,1,1);
  const duckFactor=cat=>cat==='bgm'?duck.factor:1;
  function channelVolume(ch,factor){
   return Math.min(1,mixVolume(prefs,ch.kind,ch.itemVolume,busVolume(ch.kind),duckFactor(ch.kind))*num(factor,1));
  }
  const noteAudio=(ev)=>{
   audioEvents=[{at:Date.now(),...ev},...audioEvents].slice(0,40);
   const k=ev&&ev.kind;
   if(k==='play-requested')playStats.requested++;
   else if(k==='play-started')playStats.started++;
   else if(k==='play-completed')playStats.completed++;
   else if(k==='play-cancelled')playStats.cancelled++;
   else if(k==='play-failed')playStats.failed++;
   else if(k==='decode-failed')playStats.decodeFailed++;
   else if(k==='precise-fallback'||k==='title-fallback')playStats.fallback++;
  };
  let unlocked=false,generation=0,bgm=null,voice=null,preview=null;
  let sfxChannels=[],sfxTimers=[],fadeTimers=[],pendingSwitch=null,retiring=[];
  const sfxHandles=new Map();

  /* ---------------- V0.8.1-RC：Web Audio 图与精确循环 ----------------
   * 两套播放模式共存：
   *   stream  —— 现有 HTMLAudioElement，适合大文件与长语音，不预解码；
   *   precise —— AudioBufferSourceNode + 音频时钟循环，接缝由浏览器在音频线程处理，
   *              不依赖 rAF / 定时器命中边界。
   * 选择依据：显式偏好 > 内存预算 > 解码结果；失败一律回退 stream 并给出 reason。 */
  const AC = (typeof globalThis !== 'undefined') && (globalThis.AudioContext || globalThis.webkitAudioContext);
  const modePref = ['stream', 'precise', 'auto'].indexOf(o.loopMode) >= 0 ? o.loopMode : 'auto';
  const memoryBudgetBytes = Math.max(8 * 1024 * 1024, Number(o.memoryBudgetBytes) || 64 * 1024 * 1024);
  const decodeCache = new Map();
  let decodeCacheBytes = 0, graph = null, graphError = '', loadSeq = 0;
  /* 解码串行化与在途统计：并发 decodeAudioData 会把峰值推到 N 倍预算，
     串行之后任何时候最多只有一段音频处于解码中，预算才真的是预算。 */
  let decodeChain = Promise.resolve(), decodeInFlight = 0, decodeInFlightBytes = 0;
  let decodePeakBytes = 0, decodeCancelled = 0, decodeRejected = 0;
  let preciseBgm = null;
  let preciseReason = '';
  let loopPreviewState = null;  /* M3：循环试听专用 scratch 播放器，独立于 BGM/语音/预览槽 */

  function ensureGraph() {
    if (graph || graphError) return graph;
    /* 允许外部注入上下文（离线渲染 / 测试替身）；没有原生构造器也没有注入才放弃。 */
    if (!AC && !o.audioContext) return null;
    try {
      /* 允许外部注入 AudioContext：离线渲染（OfflineAudioContext）可以用同一套图做确定性验收。 */
      const ctx = o.audioContext || new AC({ latencyHint: 'interactive' });
      const master = ctx.createGain(), duckNode = ctx.createGain(), tap = ctx.createGain();
      const buses = { bgm: ctx.createGain(), sfx: ctx.createGain(), voice: ctx.createGain() };
      buses.bgm.connect(duckNode); duckNode.connect(master);
      buses.sfx.connect(master); buses.voice.connect(master);
      master.connect(ctx.destination);
      /* tap 接在各总线之后、master 之前：验收可以拿到真实输出波形，
         同时把 master 调 0 就能静音测试而不影响采集。 */
      buses.bgm.connect(tap); buses.sfx.connect(tap); buses.voice.connect(tap);
      graph = { ctx, master, duckNode, tap, buses };
      applyGraphGains();
      if (o.onGraph) { try { o.onGraph({ ctx, tap }); } catch (e) {} }
      if (ctx.state === 'suspended' && o.autoResume !== false && typeof ctx.resume === 'function') {
        Promise.resolve(ctx.resume()).catch(() => {});
      }
      return graph;
    } catch (e) { graphError = String((e && e.message) || e); return null; }
  }
  function applyGraphGains() {
    if (!graph) return;
    const g = graph;
    g.master.gain.value = prefs.muted ? 0 : prefs.master;
    for (const c of CATEGORIES) g.buses[c].gain.value = busVolume(c) * (prefs[c] == null ? 1 : prefs[c]);
    g.duckNode.gain.value = duck.factor;
  }
  /* AudioParam 不允许重叠排程：一次交叉淡化还没走完又切歌时，
     setValueCurveAtTime / setValueAtTime 会抛 NotSupportedError（15 分钟浸泡抓到的真问题）。
     统一做法：先取消该参数上未走完的事件，把当前值钉在 now，再排新曲线。 */
  function retarget(param, now) {
    try {
      const v = typeof param.value === 'number' ? param.value : 1;
      if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
      param.setValueAtTime(v, now);
      return v;
    } catch (e) { return 1; }
  }
  function cacheGet(id) { const c = decodeCache.get(id); if (c) c.at = Date.now(); return c || null; }
  function cachePut(id, buffer, bytes) {
    const old = decodeCache.get(id);
    if (old) { decodeCacheBytes -= old.bytes; decodeCache.delete(id); }
    decodeCache.set(id, { buffer, bytes, at: Date.now() });
    decodeCacheBytes += bytes;
    const playing = preciseBgm ? preciseBgm.audioId : '';
    while (decodeCacheBytes > memoryBudgetBytes && decodeCache.size > 1) {
      let victim = '', oldest = Infinity;
      for (const [k, v] of decodeCache) { if (k === playing) continue; if (v.at < oldest) { oldest = v.at; victim = k; } }
      if (!victim) break;
      decodeCacheBytes -= decodeCache.get(victim).bytes;
      decodeCache.delete(victim);
    }
  }
  function cacheClear() { decodeCache.clear(); decodeCacheBytes = 0; }
  function cacheStats() { return { entries: decodeCache.size, bytes: decodeCacheBytes, budget: memoryBudgetBytes,
    ids: [...decodeCache.keys()], mode: preciseBgm ? 'precise' : 'stream' }; }
  /* 预算前置：先按压缩体积估算解码后内存（压缩音频约 20–25 倍），
     放不下就先淘汰，再不行就直接回退，不把内存赌在解码完成之后。 */
  function decodeEstimate(srcLen, tail) {
    const compressed = Math.max(0, Number(srcLen) || 0);
    const wav = /\.wav(\?|$)/i.test(String(tail || '')) || /^data:audio\/(x-)?wav/i.test(String(tail || ''));
    return Math.round(compressed * (wav ? 2.2 : 24));
  }
  function cacheMakeRoom(need, keepId) {
    while (decodeCacheBytes + need > memoryBudgetBytes && decodeCache.size) {
      let victim = '', oldest = Infinity;
      for (const [k, v] of decodeCache) { if (k === keepId || k === (preciseBgm && preciseBgm.audioId)) continue; if (v.at < oldest) { oldest = v.at; victim = k; } }
      if (!victim) return false;
      decodeCacheBytes -= decodeCache.get(victim).bytes;
      decodeCache.delete(victim);
    }
    return decodeCacheBytes + need <= memoryBudgetBytes;
  }

  /* 解码一段素材；token 用于识别过期请求，慢的旧结果不能覆盖新状态。 */
  async function loadBuffer(audioId, token) {
    const hit = cacheGet(audioId);
    if (hit) return { ok: true, buffer: hit.buffer, bytes: hit.bytes, cached: true };
    /* 排队：同一时刻只允许一段在解，过期请求在真正开始前就丢弃。 */
    const prev = decodeChain;
    let release;
    decodeChain = new Promise((r) => { release = r; });
    await prev;
    try {
      if (token !== loadSeq) { decodeCancelled++; return { ok: false, reason: 'stale' }; }
      return await loadBufferSerial(audioId, token);
    } finally { release(); }
  }
  async function loadBufferSerial(audioId, token) {
    const src = assetData(audioId);
    if (!src) return { ok: false, reason: 'missing' };
    const estimate = decodeEstimate(src.length, src.slice(0, 64));
    if (estimate > memoryBudgetBytes) {
      decodeRejected++;
      return { ok: false, reason: 'budget', bytes: estimate };
    }
    let arr;
    decodeInFlight++; decodeInFlightBytes += estimate;
    decodePeakBytes = Math.max(decodePeakBytes, decodeInFlightBytes);
    try {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        arr = await res.arrayBuffer();
      } catch (e) {
        return { ok: false, reason: 'fetch: ' + ((e && e.message) || e) };
      }
      if (token !== loadSeq) { decodeCancelled++; return { ok: false, reason: 'stale' }; }
      if (!cacheMakeRoom(estimate, audioId)) {
        decodeRejected++;
        return { ok: false, reason: 'budget', bytes: estimate };
      }
      try {
        const buffer = await graph.ctx.decodeAudioData(arr.slice(0));
        if (token !== loadSeq) { decodeCancelled++; return { ok: false, reason: 'stale' }; }
        const est = buffer.length * buffer.numberOfChannels * 4;
        if (est > memoryBudgetBytes) { decodeRejected++; return { ok: false, reason: 'budget', bytes: est }; }
        cachePut(audioId, buffer, est);
        return { ok: true, buffer, bytes: est, cached: false };
      } catch (e) {
        return { ok: false, reason: 'decode: ' + ((e && e.message) || e) };
      }
    } finally {
      decodeInFlight = Math.max(0, decodeInFlight - 1);
      decodeInFlightBytes = Math.max(0, decodeInFlightBytes - estimate);
    }
  }
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
  /* 返回真实播放 Promise 的结果；失败不把状态留在「正在播放」。
     合法取消（切句/换曲/停音打断 play() 导致的 AbortError）与真正播放失败要分开：
     取消不记错误、不计失败，否则一句被正常打断就会污染状态栏并被误判为播放失败。 */
  function start(ch,myGen){
   if(!ch)return Promise.resolve({ok:false,kind:'missing'});
   const el=ch.el;
   noteAudio({kind:'play-requested',cat:ch.kind,audioId:ch.audioId,label:ch.label});
   let pr;
   try{pr=el.play()}catch(e){return Promise.resolve(onFail(ch,e))}
   return Promise.resolve(pr).then(()=>{
    if(myGen!==generation||ch.done){hardStop(ch);noteAudio({kind:'play-cancelled',cat:ch.kind,audioId:ch.audioId,reason:'generation'});return {ok:true,cancelled:true,ch}}
    ch.startedAt=Date.now();
    noteAudio({kind:'play-started',cat:ch.kind,audioId:ch.audioId});
    el.onerror=()=>{if(ch.done)return;const err=(el.error&&el.error.message)||'播放中出现解码错误';noteAudio({kind:'decode-failed',cat:ch.kind,audioId:ch.audioId});record('decode',ch.audioId,err,ch.label);hardStop(ch);emit()};
    emit();
    return {ok:true,ch};
   }).catch(e=>{
    /* play() 被打断：自己 stop 过（ch.done）、代际过期、或浏览器报 AbortError——都是合法取消。 */
    if(ch.done||myGen!==generation||/AbortError|interrupted|interruption|play\(\) request/i.test(String((e&&e.name)||'')+' '+String((e&&e.message)||''))){
     hardStop(ch);
     noteAudio({kind:'play-cancelled',cat:ch.kind,audioId:ch.audioId,reason:'abort'});
     return {ok:true,cancelled:true,ch};
    }
    return onFail(ch,e);
   });
   function onFail(ch2,e){
    const kind=classifyError(e).code;
    const info=record(kind,ch2.audioId,(e&&e.message)||'',ch2.label);
    noteAudio({kind:'play-failed',cat:ch2.kind,audioId:ch2.audioId,reason:kind});
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
   applyGraphGains();
   const all=[bgm,voice,preview,...sfxChannels,...retiring.map(r=>r.ch)].filter(Boolean);
   for(const ch of all){
    if(ch.el&&!ch.done)try{ch.el.volume=channelVolume(ch,num(ch.fadeFactor,1))}catch{}
   }
  }
  function startBgm(spec,myGen,label){
   /* 剧情要起音乐：标题曲（无论精确还是流式）一律让位，结构上排除叠加。 */
   if(titleEl)yieldTitleForStory(0.3);
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
    ch.el.onended=()=>{hardStop(ch);sfxChannels=sfxChannels.filter(x=>x!==ch);noteAudio({kind:'play-completed',cat:'sfx',audioId:ch.audioId});emit()};
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
  /* 精确模式下的 BGM 交叉淡化：增益曲线全部排到 AudioParam 上，与渲染帧率无关。 */
  async function bgmCrossfadePrecise(spec, label, owner) {
    const g = ensureGraph();
    if (!g) { preciseReason = 'no-graph'; return { ok: false, mode: 'precise', reason: preciseReason }; }
    const token = ++loadSeq;
    const loaded = await loadBuffer(spec.audioId, token);
    if (!loaded.ok) { preciseReason = loaded.reason; return { ok: false, mode: 'precise', reason: loaded.reason }; }
    if (token !== loadSeq) return { ok: false, mode: 'precise', reason: 'stale' };
    const now = g.ctx.currentTime;
    const dur = Math.max(.02, clamp(spec.duration, 0, 10, .4));
    const old = preciseBgm;
    const node = g.ctx.createGain();
    node.gain.setValueAtTime(0, now);
    node.connect(g.buses.bgm);
    const src = g.ctx.createBufferSource();
    src.buffer = loaded.buffer;
    const loop = spec.loop || { mode: 'off' };
    src.loop = loop.mode !== 'off';
    if (loop.mode === 'region') { src.loopStart = loop.start; src.loopEnd = loop.end; }
    src.connect(node);
    /* offset 用于「从暂停点继续」：标题音乐返回标题页时不希望从头炸响。 */
    const offset = Math.max(0, Number(spec.offset) || 0);
    try { src.start(now, offset); } catch (e) { src.start(now); }
    preciseBgm = { src, node, audioId: spec.audioId, startedAt: now, offset, buffer: loaded.buffer, loop,
      label: label || '', owner: owner === 'title' ? 'title' : 'story' };
    const targetVol = clamp(spec.volume, 0, 1, 1);
    const n = 48, inCurve = new Float32Array(n), outCurve = new Float32Array(n);
    const base = old ? retarget(old.node.gain, now) : 0;
    for (let i = 0; i < n; i++) {
      const p = i / (n - 1);
      const gains = spec.curve === 'equalPower'
        ? { out: Math.cos(p * Math.PI / 2), in: Math.sin(p * Math.PI / 2) }
        : { out: 1 - p, in: p };
      inCurve[i] = targetVol * gains.in;
      outCurve[i] = base * gains.out;
    }
    try {
      node.gain.setValueCurveAtTime(inCurve, now, dur);
      if (old) old.node.gain.setValueCurveAtTime(outCurve, now, dur);
    } catch (e) {
      /* 兜底也要先取消：新节点上可能已经排了一半的曲线。 */
      try { retarget(node.gain, now); node.gain.linearRampToValueAtTime(targetVol, now + dur); } catch (e2) {}
    }
    if (old) {
      const victim = old;
      setTimeout(() => { try { victim.src.stop(); } catch (e) {} try { victim.node.disconnect(); } catch (e) {} }, Math.ceil(dur * 1000) + 60);
      noteAudio({ kind: 'precise-crossfade', to: spec.audioId, ms: Math.round(dur * 1000), curve: spec.curve || 'linear' });
    }
    preciseReason = '';
    return { ok: true, mode: 'precise', bytes: loaded.bytes, cached: !!loaded.cached };
  }
  function preciseStop(fadeOut, owner) {
    const cur = preciseBgm;
    if (!cur || !graph) return false;
    if (owner && cur.owner !== owner) return false;
    const now = graph.ctx.currentTime, dur = Math.max(.02, clamp(fadeOut, 0, 10, .4));
    try {
      cur.node.gain.setValueAtTime(cur.node.gain.value, now);
      cur.node.gain.linearRampToValueAtTime(0, now + dur);
    } catch (e) {}
    setTimeout(() => { try { cur.src.stop(); } catch (e) {} try { cur.node.disconnect(); } catch (e) {} }, Math.ceil(dur * 1000) + 40);
    preciseBgm = null;
    return true;
  }
  function preciseSnapshot() {
    if (!preciseBgm || !graph) return null;
    const g = graph;
    const elapsed = g.ctx.currentTime - preciseBgm.startedAt;
    const loop = preciseBgm.loop || { mode: 'off' };
    let time = preciseBgm.offset + elapsed;
    if (loop.mode === 'region' && loop.end > loop.start) {
      const span = loop.end - loop.start;
      time = time <= loop.end ? time : loop.start + ((time - loop.start) % span);
    } else if (loop.mode === 'all' && preciseBgm.buffer.duration > 0) {
      time = time % preciseBgm.buffer.duration;
    }
    return {
      audioId: preciseBgm.audioId, itemVolume: preciseBgm.node.gain.value, fade: 1,
      volume: mixVolume(prefs, 'bgm', preciseBgm.node.gain.value, busVolume('bgm'), duck.factor),
      time, duration: preciseBgm.buffer.duration, paused: false, loop, mode: 'precise',
      owner: preciseBgm.owner || 'story', startedAt: preciseBgm.startedAt
    };
  }
  /* ---------------- 标题音乐（V0.8.1-RC2） ----------------
   * 不再是「另一条独立通道」：与剧情 BGM 共用同一个音乐槽。preciseBgm.owner 只有
   * story / title 两种取值，新的一首起来时旧的必然被淡出并销毁，所以结构上不可能出现
   * 双 BGM 或标题曲与场景曲叠加。
   * 精确模式走 AudioBufferSourceNode（与剧情 BGM 同一套图、同一套 prefs）；
   * 无图 / 超预算 / 解码失败时回退 HTMLAudioElement，并如实给出 preciseReason。 */
  let titleEl = null, titleCfg = null, titleOffset = 0, titlePaused = false, titleTicker = null;
  let titleLoopStats = { jumps: 0, overrunMaxMs: 0, overrunSumMs: 0 };

  function titleLoopOf(spec) {
    if (spec && spec.loop) return loopSpec(spec.loop);
    return loopSpec({ mode: spec && spec.loopMode, start: spec && spec.loopStart, end: spec && spec.loopEnd });
  }
  function stopTitleTicker() { if (titleTicker) { clearInterval(titleTicker.t); titleTicker = null; } }
  /* 流式回退下的区间循环：精确模式永远不走这里，因此不再依赖定时器命中边界。 */
  function startTitleTicker(ch, loop) {
    stopTitleTicker();
    if (!(loop.mode === 'region' && loop.end > loop.start)) return;
    titleTicker = { t: setInterval(() => {
      if (!titleEl || titleEl !== ch || !ch.el || ch.el.paused) return;
      let t = 0; try { t = ch.el.currentTime; } catch (e) { return; }
      if (t >= loop.end) {
        const overrun = Math.max(0, (t - loop.end) * 1000);
        try { ch.el.currentTime = loop.start; } catch (e) { return; }
        titleLoopStats.jumps++;
        titleLoopStats.overrunSumMs += overrun;
        titleLoopStats.overrunMaxMs = Math.max(titleLoopStats.overrunMaxMs, overrun);
      }
    }, 60) };
  }
  function stopTitleStream(fadeOut) {
    stopTitleTicker();
    const ch = titleEl;
    titleEl = null;
    if (!ch) return false;
    const fo = Math.max(0, Number(fadeOut) || 0);
    if (fo > 0) {
      retiring.push({ ch });
      fade(ch, num(ch.fadeFactor, 1), 0, fo, generation, () => {
        hardStop(ch); retiring = retiring.filter((x) => x.ch !== ch);
      });
    } else hardStop(ch);
    return true;
  }
  /* 标题曲还占着精确槽位时，剧情要起音乐必须先让它走——这就是「不重叠」的保证。 */
  function yieldTitleForStory(fadeOut) {
    if (preciseBgm && preciseBgm.owner === 'title') { preciseStop(fadeOut == null ? .4 : fadeOut, 'title'); titleCfg = null; titlePaused = false; titleOffset = 0; }
    if (titleEl) { stopTitleStream(fadeOut == null ? .4 : fadeOut); titleCfg = null; titlePaused = false; titleOffset = 0; }
  }
  function preciseTitleTime() {
    if (!preciseBgm || !graph) return 0;
    const elapsed = graph.ctx.currentTime - preciseBgm.startedAt;
    const loop = preciseBgm.loop || { mode: 'off' };
    let t = (preciseBgm.offset || 0) + elapsed;
    if (loop.mode === 'region' && loop.end > loop.start) {
      t = t <= loop.end ? t : loop.start + ((t - loop.start) % (loop.end - loop.start));
    } else if (loop.mode === 'all' && preciseBgm.buffer.duration > 0) {
      t = t % preciseBgm.buffer.duration;
    }
    return t;
  }
  /* 循环次数由音频时钟推导（不是采样统计）；接缝毫秒必须以 PCM 为准，见验收报告。 */
  function titleLoopCount() {
    if (!preciseBgm || !graph || preciseBgm.owner !== 'title') return 0;
    const l = preciseBgm.loop || { mode: 'off' };
    const t = (preciseBgm.offset || 0) + (graph.ctx.currentTime - preciseBgm.startedAt);
    if (l.mode === 'region' && l.end > l.start) {
      return t <= l.end ? 0 : Math.max(0, Math.floor((t - l.start) / (l.end - l.start)));
    }
    if (l.mode === 'all' && preciseBgm.buffer.duration > 0) return Math.max(0, Math.floor(t / preciseBgm.buffer.duration));
    return 0;
  }
  async function titlePlay(spec) {
    const audioId = spec && spec.audioId;
    if (!audioId) return { ok: false, reason: 'missing' };
    const loop = titleLoopOf(spec);
    const vol = clamp(spec.volume, 0, 1, 1);
    const fadeIn = Math.max(0, Math.min(LIMITS.maxFade, Number(spec.fadeIn) || 0));
    const offset = Math.max(0, Number(spec.offset) || 0);
    const g = modePref !== 'stream' ? ensureGraph() : null;
    if (g) {
      const token = ++loadSeq;
      const loaded = await loadBuffer(audioId, token);
      if (loaded.ok && token === loadSeq) {
        const now = g.ctx.currentTime;
        const old = preciseBgm;
        const node = g.ctx.createGain();
        node.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, now);
        node.connect(g.buses.bgm);
        const src = g.ctx.createBufferSource();
        src.buffer = loaded.buffer;
        src.loop = loop.mode !== 'off';
        if (loop.mode === 'region') { src.loopStart = loop.start; src.loopEnd = loop.end; }
        src.connect(node);
        try { src.start(now, offset); } catch (e) { try { src.start(now); } catch (e2) {} }
        preciseBgm = { src, node, audioId, startedAt: now, offset, buffer: loaded.buffer, loop, label: 'title', owner: 'title' };
        if (fadeIn > 0) { try { node.gain.linearRampToValueAtTime(vol, now + fadeIn); } catch (e) { node.gain.value = vol; } }
        if (old) {
          const fo = Math.max(.05, fadeIn || .4);
          try {
            retarget(old.node.gain, now);
            old.node.gain.linearRampToValueAtTime(0, now + fo);
          } catch (e) {}
          const victim = old;
          setTimeout(() => { try { victim.src.stop(); } catch (e) {} try { victim.node.disconnect(); } catch (e) {} }, Math.ceil(fo * 1000) + 60);
        }
        titleCfg = { audioId, volume: vol, loop, fadeIn };
        titlePaused = false; titleOffset = 0; preciseReason = '';
        noteAudio({ kind: 'title-play', audioId, mode: 'precise', loop: loop.mode, offset });
        emit();
        return { ok: true, mode: 'precise', bytes: loaded.bytes, cached: !!loaded.cached, loops: 0 };
      }
      preciseReason = (loaded && loaded.reason) || 'unavailable';
      noteAudio({ kind: 'title-fallback', reason: preciseReason });
    } else {
      preciseReason = modePref === 'stream' ? 'stream-pref' : (graphError || 'no-graph');
    }
    /* ---- 流式回退 ---- */
    yieldTitleForStory(0);
    if (preciseBgm) preciseStop(0);
    const ch = channel('bgm', audioId, vol, loop.mode === 'all');
    if (!ch) return { ok: false, reason: 'load' };
    titleEl = ch;
    titleCfg = { audioId, volume: vol, loop, fadeIn };
    titlePaused = false;
    if (fadeIn > 0) { try { ch.el.volume = 0; } catch (e) {} }
    if (offset > 0) { try { ch.el.currentTime = offset; } catch (e) {} }
    if (loop.mode === 'region') startTitleTicker(ch, loop);
    const started = await start(ch, generation);
    if (!started.ok) { titleEl = null; return { ok: false, reason: started.kind || 'play' }; }
    if (fadeIn > 0) fade(ch, 0, 1, fadeIn, generation);
    noteAudio({ kind: 'title-play', audioId, mode: 'stream', loop: loop.mode, reason: preciseReason });
    emit();
    return { ok: true, mode: 'stream', reason: preciseReason, offset };
  }
  function titlePause(fadeOut) {
    const fo = fadeOut == null ? .35 : Math.max(0, Math.min(LIMITS.maxFade, Number(fadeOut) || 0));
    if (preciseBgm && preciseBgm.owner === 'title') {
      titleOffset = Math.max(0, preciseTitleTime());
      preciseStop(fo, 'title');
      titlePaused = true;
      noteAudio({ kind: 'title-pause', mode: 'precise', offset: +titleOffset.toFixed(3) });
      emit();
      return { ok: true, mode: 'precise', offset: +titleOffset.toFixed(3) };
    }
    if (titleEl) {
      try { titleOffset = Math.max(0, titleEl.el.currentTime || 0); } catch (e) {}
      stopTitleStream(fo);
      titlePaused = true;
      noteAudio({ kind: 'title-pause', mode: 'stream', offset: +titleOffset.toFixed(3) });
      emit();
      return { ok: true, mode: 'stream', offset: +titleOffset.toFixed(3) };
    }
    return { ok: false };
  }
  function titleResume(fadeOut) {
    if (!titleCfg) return Promise.resolve({ ok: false, reason: 'no-cfg' });
    return titlePlay({ audioId: titleCfg.audioId, volume: titleCfg.volume, loop: titleCfg.loop,
      fadeIn: fadeOut == null ? .4 : fadeOut, offset: titleOffset });
  }
  function titleStop(fadeOut) {
    const fo = fadeOut == null ? .35 : Math.max(0, Number(fadeOut) || 0);
    let stopped = false;
    if (preciseBgm && preciseBgm.owner === 'title') stopped = preciseStop(fo, 'title') || stopped;
    if (stopTitleStream(fo)) stopped = true;
    titleCfg = null; titlePaused = false; titleOffset = 0;
    if (stopped) { noteAudio({ kind: 'title-stop' }); emit(); }
    return { ok: stopped };
  }
  function titleSnapshot() {
    const cfg = titleCfg;
    if (preciseBgm && preciseBgm.owner === 'title') {
      const time = preciseTitleTime();
      return { playing: true, paused: false, audioId: preciseBgm.audioId, mode: 'precise',
        volume: mixVolume(prefs, 'bgm', preciseBgm.node.gain.value, busVolume('bgm'), duck.factor),
        itemVolume: preciseBgm.node.gain.value, time, duration: preciseBgm.buffer.duration,
        loop: preciseBgm.loop, loops: titleLoopCount(), offset: 0, owner: 'title' };
    }
    if (titleEl) {
      return { playing: true, paused: false, audioId: titleEl.audioId, mode: 'stream',
        volume: channelVolume(titleEl, num(titleEl.fadeFactor, 1)), itemVolume: titleEl.itemVolume,
        time: titleEl.el.currentTime, loop: cfg && cfg.loop, loops: titleLoopStats.jumps, offset: 0,
        reason: preciseReason, owner: 'title' };
    }
    return { playing: false, paused: titlePaused, audioId: cfg ? cfg.audioId : '',
      mode: '', loop: cfg ? cfg.loop : null, offset: titlePaused ? +titleOffset.toFixed(3) : 0, loops: 0 };
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
   if(preciseBgm&&graph){
    const now=graph.ctx.currentTime;
    const to=clamp(target,0,1,1),dur=Math.max(.02,num(options&&options.duration,0));
    try{retarget(preciseBgm.node.gain,now);preciseBgm.node.gain.linearRampToValueAtTime(to,now+dur)}catch(e){}
    return {ok:true,mode:'precise',volume:to};
   }
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
  /* 对外入口：按模式偏好决定走精确循环还是流式；精确失败自动回退并记原因。 */
  function bgmCrossfade(spec,label){
   const target=spec&&spec.audioId;
   if(!target)return Promise.resolve({ok:false,kind:'missing'});
   if(modePref!=='stream'){
    const g=ensureGraph();
    if(g){
     if(preciseBgm&&preciseBgm.audioId===target&&spec.loop&&spec.loop.mode!=='off'){
      const now=g.ctx.currentTime;
      try{retarget(preciseBgm.node.gain,now);preciseBgm.node.gain.linearRampToValueAtTime(clamp(spec.volume,0,1,1),now+Math.max(.02,num(spec.duration,0)))}
      catch(e){try{preciseBgm.node.gain.value=clamp(spec.volume,0,1,1)}catch(e2){}}
      preciseBgm.loop=spec.loop;
      try{
       preciseBgm.src.loop=spec.loop.mode!=='off';
       if(spec.loop.mode==='region'){preciseBgm.src.loopStart=spec.loop.start;preciseBgm.src.loopEnd=spec.loop.end}
      }catch(e){}
      return Promise.resolve({ok:true,same:true,mode:'precise'});
     }
     return bgmCrossfadePrecise(spec,label).then(r=>{
      if(r&&r.ok)return r;
      /* 过期请求只丢弃，绝不能回退成流式播放——否则旧请求会把新音乐盖掉。 */
      if(r&&r.reason==='stale')return {ok:false,mode:'precise',reason:'stale',cancelled:true};
      noteAudio({kind:'precise-fallback',reason:(r&&r.reason)||''});
      return streamCrossfade(spec,label).then(x=>Object.assign({},x,{fallback:(r&&r.reason)||''}));
     });
    }
   }
   return streamCrossfade(spec,label);
  }
  function streamCrossfade(spec,label){
   const myGen=generation;
   const target=spec&&spec.audioId;
   if(!target)return Promise.resolve({ok:false,kind:'missing'});
   cancelPending();
   if(preciseBgm)preciseStop(0.2);
   if(titleEl){
    const tc=titleEl;titleEl=null;titleCfg=null;titlePaused=false;titleOffset=0;stopTitleTicker();
    retiring.push({ch:tc});
    fade(tc,num(tc.fadeFactor,1),0,Math.max(.2,num(spec.duration,.4)),generation,()=>{hardStop(tc);retiring=retiring.filter(x=>x.ch!==tc)});
   }
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
   rampDuck();
   if(graph){
    const now=graph.ctx.currentTime,target=duckTarget();
    const dur=Math.max(.02,duck.active?duck.attack:duck.release);
    try{retarget(graph.duckNode.gain,now);graph.duckNode.gain.linearRampToValueAtTime(target,now+dur)}catch(e){}
   }
   emit();return {...duck};
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
   ch.el.onended=()=>{hardStop(ch);sfxChannels=sfxChannels.filter(x=>x!==ch);if(key&&sfxHandles.get(key)===ch)sfxHandles.delete(key);noteAudio({kind:'play-completed',cat:'sfx',audioId:ch.audioId});emit()};
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
   ch.el.onended=()=>{if(voice!==ch)return;voice=null;duckPop();noteAudio({kind:'play-completed',cat:'voice',audioId:ch.audioId});emit()};
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
    if(preciseBgm)preciseStop(0);
    if(bgm){hardStop(bgm);bgm=null}
    stopLoopTicker();
   }else if(want&&want.audioId){
    /* 有 Web Audio 图时走精确模式：跳过/快进后的终态同样应该是采样级循环。
       解码是异步的，期间旧的流式通道仍在播，解码完成后精确源接管（同曲只调音量）。 */
    if(modePref!=='stream'&&(graph||ensureGraph())){
     bgmCrossfade({audioId:want.audioId,volume:want.volume,duration:0,curve:'linear',
      loop:want.loop||{mode:'off',start:0,end:0}});
    }else if(bgm&&!bgm.done&&bgm.audioId===want.audioId){
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
  /* 内存画像：缓存、在播解码缓冲、在途解码、流式通道分别统计，不把缓存预算当峰值。 */
  function audioMemory(){
   const active=preciseBgm?preciseBgm.buffer.length*preciseBgm.buffer.numberOfChannels*4:0;
   const streams=(bgm?1:0)+(voice?1:0)+(titleEl?1:0)+sfxChannels.length+retiring.length+(preview?1:0);
   return {budgetBytes:memoryBudgetBytes,cacheBytes:decodeCacheBytes,cacheEntries:decodeCache.size,
    activeBufferBytes:active,decoding:decodeInFlight,decodingBytes:decodeInFlightBytes,
    decodePeakBytes,decodeCancelled,decodeRejected,streamChannels:streams,
    workingSetBytes:decodeCacheBytes+decodeInFlightBytes};
  }
  /* M2：播放事件统计。验收脚本据此判断「请求/开始/完成/合法取消/真正失败/解码失败/回退」，
     而不是只看「有没有 JS 异常」。合法取消与预期回退不计失败。 */
  function playbackStats(){return {...playStats}}
  /* M3：循环试听工具。解码缓冲复用 64MiB 缓存与串行化，不绕预算、不无条件解码全工程。 */
  async function decodeWaveform(audioId, bins){
   if(!ensureGraph())return {ok:false,reason:'no-graph'};
   const token=++loadSeq;
   const r=await loadBuffer(audioId,token);
   if(!r||!r.ok||!r.buffer)return {ok:false,reason:(r&&r.reason)||'no-buffer'};
   const ch=r.buffer.getChannelData(0);
   const n=Math.max(16,Math.min(bins||800,4000));
   const step=Math.max(1,Math.floor(ch.length/n));
   const peaks=new Array(n);let peak=0;
   for(let b=0;b<n;b++){let m=0;const s=b*step;for(let i=0;i<step&&s+i<ch.length;i++){const v=Math.abs(ch[s+i]);if(v>m)m=v;}peaks[b]=m;if(m>peak)peak=m;}
   if(peak>0)for(let b=0;b<n;b++)peaks[b]=+((peaks[b]/peak).toFixed(4));
   return {ok:true,duration:r.buffer.duration,sampleRate:r.buffer.sampleRate,channels:r.buffer.numberOfChannels,peaks};
  }
  /* M3：循环试听播放。走与发布游戏完全相同的 AudioBufferSourceNode + loopStart/loopEnd，
     接同一根 bgm 总线（音量 / Ducking / master 语义一致），但不占用 BGM 槽、不影响当前工程播放状态。
     startOffset 用于「试听循环接缝」：从 loopEnd 前数秒起播，穿过边界回跳 loopStart 继续。 */
  function loopPreview(audioId,loop,volume,startOffset){
   loopPreviewStop();
   const g0=ensureGraph();
   if(!g0)return Promise.resolve({ok:false,reason:'no-graph',loop:loopSpec(loop)});
   const token=++loadSeq;
   return loadBuffer(audioId,token).then(r=>{
    if(!r||!r.ok||!r.buffer)return {ok:false,reason:(r&&r.reason)||'no-buffer',loop:loopSpec(loop)};
    const g=g0;
    const w=loopSpec(loop);
    const src=g.ctx.createBufferSource();src.buffer=r.buffer;
    src.loop=w.mode!=='off';
    if(w.mode==='region'){src.loopStart=w.start;src.loopEnd=w.end;}
    const gain=g.ctx.createGain();gain.gain.value=Math.min(1,num(volume,1));
    src.connect(gain);gain.connect(g.buses.bgm);
    const dur=r.buffer.duration;
    const off=num(startOffset, w.mode==='region'?w.start:0);
    const startAt=g.ctx.currentTime+0.04;
    src.start(startAt,Math.max(0,Math.min(off,dur-0.01)));
    loopPreviewState={src,gain};
    const time=()=>{const t=g.ctx.currentTime-startAt;
     if(w.mode==='region'){const span=Math.max(.001,w.end-w.start);return w.start+((t%span)+span)%span;}
     if(w.mode==='all'){return ((t%dur)+dur)%dur;}
     return Math.min(t,dur);};
    const loops=()=>{const t=g.ctx.currentTime-startAt;
     if(w.mode==='region'){const span=Math.max(.001,w.end-w.start);return Math.floor(t/span);}
     if(w.mode==='all')return Math.floor(t/dur);return 0;};
    return {ok:true,mode:'precise',loop:{...w},duration:dur,startAt,
     time,loops,
     stop:()=>{try{src.stop()}catch{};try{gain.disconnect()}catch{};if(loopPreviewState&&loopPreviewState.src===src)loopPreviewState=null;}};
   });
  }
  function loopPreviewStop(){if(loopPreviewState){try{loopPreviewState.src.stop()}catch{};try{loopPreviewState.gain.disconnect()}catch{};loopPreviewState=null;}}
  function snapshot(){
   const view=ch=>{
    if(!ch)return null;
    let t=0,dur=0,vol=0,paused=true;
    try{t=ch.el.currentTime||0;dur=Number.isFinite(ch.el.duration)?ch.el.duration:0;vol=ch.el.volume||0;paused=!!ch.el.paused}catch{}
    return {audioId:ch.audioId,itemVolume:ch.itemVolume,fade:num(ch.fadeFactor,1),volume:vol,time:t,duration:dur,paused,
     loop:ch.loopWindow?{...ch.loopWindow}:{mode:'off',start:0,end:0}};
   };
   const precise=preciseSnapshot();
   return {unlocked,prefs:{...prefs},buses:{...showVolume},ducking:{...duck,hold:duckHold},
    loop:{...loopStats},bgm:precise||view(bgm),voice:view(voice),sfx:sfxChannels.map(view),
    title:titleSnapshot(),music:{owner:precise?precise.owner:(bgm?'story':(titleEl?'title':null))},
    audioMemory:audioMemory(),
    instances:{bgm:(precise||bgm)?1:0,retiring:retiring.length,sfx:sfxChannels.length,voice:voice?1:0,title:(precise&&precise.owner==='title')||titleEl?1:0},
    mode:precise?'precise':'stream',modePref,preciseReason,graphError,
    cache:cacheStats(),graph:graph?{state:graph.ctx.state,sampleRate:graph.ctx.sampleRate,baseLatency:graph.ctx.baseLatency}:null,
    events:audioEvents.slice(0,12),generation,
    /* 双 BGM 直接检测：精确模式与流式 BGM 同时存在就是叠加（除非是精确交叉淡化期间的短暂共存）。 */
    dualBgm:!!(precise&&bgm),
    errors:errors.slice(0,8),playbackStats:playbackStats()};
  }

  function enter(cue,options){
   const c=normalizeCue(cue),opt=options||{},label=opt.label||'';
   const prevSwitch=pendingSwitch;
   const myGen=++generation;
   lastEnter={cue:c,options:{...opt}};
   /* 进入新的一句时，清掉上一句遗留的解码/缺失/未知错误，只保留「未获播放许可」——
      否则一句播放失败后，错误横幅会一直挂到会话结束（即使后面的句子都正常）。 */
   errors=errors.filter(x=>x.code==='permission');
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
    /* 返回 / 读档 / 重开：先彻底清掉旧的 BGM 通道，再按目标句状态从曲首重建。
       精确模式（AudioBufferSourceNode）的 BGM 也必须一并停掉，否则会与重建起的流式
       BGM 叠加成双 BGM。 */
    stopBgm(true);
    if(preciseBgm)preciseStop(0);
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
    if(ch){voice=ch;ch.el.onended=()=>{if(voice===ch)voice=null;noteAudio({kind:'play-completed',cat:'voice',audioId:ch.audioId});emit()};tasks.push(start(ch,myGen))}
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
   if(preciseBgm)preciseStop(0);
   loopPreviewStop();
   stopTitleStream(0);titleCfg=null;titlePaused=false;titleOffset=0;
   if(bgm){hardStop(bgm);bgm=null}
   emit();
  }
  function dispose(){
   stopAll();disposed=true;
   /* 自己创建的上下文要关掉；注入的（离线渲染 / 测试）由调用方负责。 */
   if(graph&&!o.audioContext&&typeof graph.ctx.close==='function'){try{graph.ctx.close()}catch{}}
   graph=null;cacheClear();emit();
  }
  return {enter,retry,unlock,status,setPrefs,getPrefs,previewAsset,stopPreview:()=>{stopPreview()},stopAll,dispose,isUnlocked:()=>unlocked,
   /* V0.8.1-RC2：标题音乐走同一个音乐槽与同一套 prefs */
   titlePlay,titlePause,titleResume,titleStop,titleSnapshot,audioMemory,
   /* V0.8.1 音频演出 API */
   bgmCrossfade,bgmVolume,bgmStop:options=>{const fo=clamp(options&&options.fadeOut,0,LIMITS.maxFade,1);
    if(preciseBgm){preciseStop(fo);noteAudio({kind:'bgm-stop'});emit();return {ok:true,mode:'precise'}}
    const old=bgm;bgm=null;if(!old)return {ok:false};
     if(fo>0){retiring.push({ch:old});fade(old,1,0,fo,generation,()=>{hardStop(old);retiring=retiring.filter(x=>x.ch!==old);emit()})}else{hardStop(old)}
     noteAudio({kind:'bgm-stop',audioId:old.audioId});emit();return {ok:true}},
   bgmLoop:spec=>{
    const w=loopSpec(spec);
    if(preciseBgm){try{
      preciseBgm.loop=w;
      preciseBgm.src.loop=w.mode!=='off';
      if(w.mode==='region'){preciseBgm.src.loopStart=w.start;preciseBgm.src.loopEnd=w.end}
      return {ok:true,loop:{...w},mode:'precise'};
    }catch(e){}}
    if(!bgm)return {ok:false};
    applyLoop(bgm,w);
    return {ok:true,loop:{...bgm.loopWindow}}},
   setBusVolume,sfxPlay,sfxStop,voicePlay,voiceStop,setDucking,applyAudioState,snapshot,
   playbackStats,decodeWaveform,loopPreview,loopPreviewStop,getLoopStats:()=>({...loopStats})};
 }

 return {LIMITS,CATEGORIES,CATEGORY_NAMES,EXT_MIME,DEFAULT_PREFS,DEFAULT_FADE,
  pure:{normalizePrefs,finalVolume,normalizeCue,emptyCue,decodeDataUrl,wavInfo,extOf,classifyError,errorInfo,checkImport,readMeta,formatSeconds,formatBytes,silenceUrl,
   mixVolume,crossfadeGains,loopSpec,duckSpec,audioActionSpec},
  runtime:createRuntime};
}
if(typeof module!=='undefined')module.exports=createPaperAudio;
