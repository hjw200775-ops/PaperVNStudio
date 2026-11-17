/* Shared data/scene logic for editor and exported games. */
function createVNCore(){
 const clone=x=>JSON.parse(JSON.stringify(x));
 const id=()=>globalThis.crypto?.randomUUID?.()||'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
 const finite=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
 /* Schema 4 adds characters/expressions. Migration is additive: every older
    工程 keeps its nodes, layers and effects exactly as they are, and simply
    gains empty character fields. Nothing is guessed from the speaker text. */
 /* V0.5 音频不改变 schema 版本号：audioAssets / node.audio 都是可选增量字段，
    旧工程缺这些字段就等价于「无音频」，画面、剧情、分支与存档行为完全不变。
    迁移只把缺省补齐，不猜测、不生成任何播放任务。 */
 function toAudio(p){if(!Array.isArray(p.audioAssets))p.audioAssets=[];for(const n of p.nodes||[]){if(n.audio===undefined)n.audio=null;if(n.audio&&!Array.isArray(n.audio.sfx))n.audio.sfx=[]}return p}
 function migrate(input){const p=clone(input);if(p.schema===5)return toAudio(p);if(p.schema===4)return toAudio(toV5(p));if(p.schema===2){p.schema=3;for(const n of p.nodes)n.effects=[];return toAudio(toV5(toV4(p)))}if(p.schema===3)return toAudio(toV5(toV4(p)));if(p.schema!==1)throw Error('不支持的工程版本');p.schema=2;p.id=id();p.presets=[];for(const n of p.nodes){n.sceneMode='own';n.layers=[];if(n.bg)n.layers.push({id:id(),asset:n.bg,name:'背景',kind:'bg',x:0,y:0,w:100,h:100,fit:'cover',opacity:100,hidden:false,locked:false,motion:'none'});if(n.char){const a=p.assets.find(a=>a.id===n.char);let h=n.scale||85,w=Math.min(90,h*9/16*((a?.width&&a?.height)?a.width/a.height:.65));n.layers.push({id:id(),asset:n.char,name:'角色立绘',kind:'char',x:n.align==='left'?4:n.align==='right'?96-w:50-w/2,y:100-h,w,h,fit:'contain',opacity:100,hidden:false,locked:false,motion:n.motion||'none',legacy:true})}delete n.bg;delete n.char;delete n.align;delete n.scale;delete n.motion;n.effects=[]}p.schema=3;return toAudio(toV5(toV4(p)))}
 function upgradeLayer(l){if(!l||typeof l!=='object')return l;if(typeof l.characterId!=='string')l.characterId='';if(typeof l.expressionId!=='string')l.expressionId='';return l}
 function toV4(p){p.schema=4;if(!Array.isArray(p.characters))p.characters=[];for(const n of p.nodes||[]){if(typeof n.speakerId!=='string')n.speakerId='';if(typeof n.expressionId!=='string')n.expressionId='';if(!Array.isArray(n.cast))n.cast=[];for(const l of n.layers||[])upgradeLayer(l)}for(const t of p.presets||[])for(const l of t.layers||[])upgradeLayer(l);return p}
 /* Schema 5 增加章节/段落分组。分组只补充「归属」与「显示结构」，不改 p.nodes
    的播放顺序：旧工程整体进入一个默认章节与默认段落，节点顺序、分支与演出原样保留。 */
 function toV5(p){p.schema=5;if(!Array.isArray(p.chapters))p.chapters=[];if(!p.chapters.length){p.chapters=[{id:'ch_'+id(),title:'第一章',collapsed:false,paragraphs:[{id:'pg_'+id(),title:'默认段落',collapsed:false}]}]}for(const c of p.chapters){if(typeof c.collapsed!=='boolean')c.collapsed=false;if(!Array.isArray(c.paragraphs))c.paragraphs=[]}const known=new Set(paragraphIds(p));const first=known.size?[...known][0]:'';for(const n of p.nodes||[]){if(typeof n.paragraphId!=='string'||!known.has(n.paragraphId))n.paragraphId=first}return p}
 function paragraphIds(p){const out=[];for(const c of p.chapters||[])for(const g of c.paragraphs||[])out.push(g.id);return out}
 function validate(p){if(!p||![1,2,3,4,5].includes(p.schema)||typeof p.title!=='string'||!Array.isArray(p.nodes)||!Array.isArray(p.assets))throw Error('不是有效的纸间工程');if(p.nodes.length>20000||p.assets.length>1000)throw Error('工程超过体验版限制');const ids=new Set();for(const n of p.nodes){if(!n||typeof n.id!=='string'||ids.has(n.id)||!['say','choice','end'].includes(n.type)||typeof n.name!=='string'||typeof n.text!=='string')throw Error('剧情节点格式错误');ids.add(n.id);if(n.next!=null&&typeof n.next!=='string')throw Error('跳转目标格式错误');if(n.type==='choice'&&(!Array.isArray(n.options)||n.options.length>100||n.options.some(o=>!o||typeof o.text!=='string'||typeof o.target!=='string')))throw Error('选项格式错误');if(p.schema>=3&&!Array.isArray(n.effects))throw Error('缺少演出列表');if(p.schema>=4&&(typeof n.speakerId!=='string'||typeof n.expressionId!=='string'||!Array.isArray(n.cast)||n.cast.length>20))throw Error('说话人绑定格式错误');if(p.schema>=5&&typeof n.paragraphId!=='string')throw Error('段落归属格式错误');if(p.schema>=2){if(!['own','inherit'].includes(n.sceneMode)||!Array.isArray(n.layers)||n.layers.length>100)throw Error('场景格式错误');checkLayers(n.layers)}}const aids=new Set();for(const a of p.assets){if(!a||typeof a.id!=='string'||aids.has(a.id)||typeof a.name!=='string'||!['bg','char'].includes(a.kind)||typeof a.data!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(a.data))throw Error('图片素材格式错误');aids.add(a.id)}if(p.schema>=2){if(typeof p.id!=='string'||!Array.isArray(p.presets)||p.presets.length>200)throw Error('工程信息格式错误');for(const t of p.presets){if(!t||typeof t.id!=='string'||typeof t.name!=='string'||!Array.isArray(t.layers)||t.layers.length>100)throw Error('预设格式错误');checkLayers(t.layers)}}if(p.schema>=4)checkCharacters(p);if(p.schema>=5)checkChapters(p);checkAudio(p);return true}
 function checkLayers(ls){const ids=new Set();for(const l of ls){if(!l||typeof l.id!=='string'||ids.has(l.id)||typeof l.asset!=='string'||typeof l.name!=='string'||!['bg','char'].includes(l.kind)||!finite(l.x,-500,500)||!finite(l.y,-500,500)||!finite(l.w,1,1000)||!finite(l.h,1,1000)||!finite(l.opacity,0,100)||typeof l.hidden!=='boolean'||typeof l.locked!=='boolean'||!['contain','cover','fill'].includes(l.fit)||!['none','breathe','sway'].includes(l.motion))throw Error('图层设置格式错误');if(l.characterId!=null&&typeof l.characterId!=='string')throw Error('图层角色绑定格式错误');if(l.expressionId!=null&&typeof l.expressionId!=='string')throw Error('图层表情绑定格式错误');ids.add(l.id)}}
 /* ---------- V0.5 基础音频：数据校验与纯状态推导 ----------
    音频与图片完全分表：audioAssets 用 data:audio/... 内嵌，磁盘另存 assets/audio/。
    图片专用的 kind/data 校验不会作用到音频素材上。 */
 const AUDIO_CATS=['bgm','sfx','voice'];
 const AUDIO_DATA_RE=/^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/i;
 const AUDIO_MAX_BYTES=16*1024*1024;
 const okNum=(x,a,b)=>Number.isFinite(x)&&x>=a&&x<=b;
 function checkNodeAudio(a,where){
  if(a==null)return;
  if(!a||typeof a!=='object'||Array.isArray(a))throw Error(where+'音频设置格式错误');
  const b=a.bgm;
  if(b!=null){
   if(!b||typeof b!=='object'||!['play','stop'].includes(b.action))throw Error(where+'背景音乐指令格式错误');
   if(b.action==='play'){
    if(typeof b.audioId!=='string'||!b.audioId)throw Error(where+'背景音乐未指定素材');
    if(!okNum(b.volume,0,1)||typeof b.loop!=='boolean'||!okNum(b.fadeIn,0,10)||!okNum(b.fadeOut,0,10))throw Error(where+'背景音乐参数格式错误');
   }else if(!okNum(b.fadeOut,0,10))throw Error(where+'停止音乐参数格式错误');
  }
  if(a.sfx!=null){
   if(!Array.isArray(a.sfx)||a.sfx.length>16)throw Error(where+'音效列表格式错误');
   const ids=new Set();
   for(const s of a.sfx){
    if(!s||typeof s.id!=='string'||!s.id||ids.has(s.id)||typeof s.audioId!=='string'||!s.audioId||!okNum(s.volume,0,1)||!okNum(s.delay,0,20))throw Error(where+'音效参数格式错误');
    ids.add(s.id);
   }
  }
  if(a.voice!=null){
   const v=a.voice;
   if(!v||typeof v!=='object'||typeof v.audioId!=='string'||!v.audioId||!okNum(v.volume,0,1))throw Error(where+'台词语音格式错误');
  }
 }
 function checkAudio(p){
  if(p.audioAssets===undefined)return;               /* 旧工程：完全无音频 */
  if(!Array.isArray(p.audioAssets)||p.audioAssets.length>200)throw Error('音频素材列表格式错误');
  const ids=new Set();
  for(const a of p.audioAssets){
   if(!a||typeof a.id!=='string'||!a.id||ids.has(a.id)||typeof a.name!=='string'||
    !Array.isArray(a.categories)||!a.categories.length||a.categories.some(c=>!AUDIO_CATS.includes(c))||
    typeof a.mime!=='string'||typeof a.ext!=='string'||!AUDIO_DATA_RE.test(a.data)||
    !Number.isInteger(a.bytes)||a.bytes<0||a.bytes>AUDIO_MAX_BYTES||
    !(a.duration===null||okNum(a.duration,0,86400)))throw Error('音频素材格式错误');
   ids.add(a.id);
  }
  for(const [i,n]of p.nodes.entries())checkNodeAudio(n.audio,'第 '+(i+1)+' 节：');
 }
 /* 逐句音频指令：缺省 / null 都表示「沿用」，绝不按节点数组顺序推断。 */
 function audioCue(p,n){
  const a=n&&n.audio;
  if(!a)return {bgm:null,sfx:[],voice:null};
  return {bgm:a.bgm||null,sfx:Array.isArray(a.sfx)?a.sfx:[],voice:a.voice||null};
 }
 function hasBgmInstruction(n){const c=audioCue(null,n);return !!(c.bgm&&(c.bgm.action==='play'||c.bgm.action==='stop'))}
 /* 沿真实路线结算 BGM。与 scene/castAlong 不同：sceneMode:'own' 不重置音乐，
    只有显式 play / stop 才改变状态。返回的是「状态」，不是播放任务。 */
 function audioStateAlong(p,ids){
  let state=null;
  for(const nid of ids||[]){
   const n=p.nodes.find(x=>x.id===nid);if(!n)continue;
   const c=audioCue(p,n);
   if(!c.bgm)continue;
   if(c.bgm.action==='stop')state=null;
   else state={audioId:c.bgm.audioId,volume:c.bgm.volume,loop:!!c.bgm.loop,
    fadeIn:c.bgm.fadeIn,fadeOut:c.bgm.fadeOut,at:nid};
  }
  return state;
 }
 function bgmAt(p,nodeId,trail){
  const ids=Array.isArray(trail)?[...trail]:p.nodes.slice(0,p.nodes.findIndex(n=>n.id===nodeId)).map(n=>n.id);
  return audioStateAlong(p,[...ids,nodeId]);
 }
 function audioUsage(p,audioId){
  const uses=[];
  for(const [i,n]of p.nodes.entries()){
   const c=audioCue(p,n),at='第 '+(i+1)+' 句 · '+(n.name||'旁白')+'：'+(n.text||'').slice(0,14);
   if(c.bgm&&c.bgm.action==='play'&&c.bgm.audioId===audioId)uses.push({nodeId:n.id,index:i,where:'背景音乐',label:at});
   for(const s of c.sfx)if(s.audioId===audioId)uses.push({nodeId:n.id,index:i,where:'音效',label:at});
   if(c.voice&&c.voice.audioId===audioId)uses.push({nodeId:n.id,index:i,where:'台词语音',label:at});
  }
  return uses;
 }
 /* 同内容文件复用底层资源，不产生重复素材 ID；分类只是「用途」标签，可合并，
    引用端只按 audioId，因此同一文件可以同时被 BGM / 音效 / 语音使用。 */
 function assetForAudioImport(p,{id:newId,name,categories,data,mime,ext,bytes,duration,durationNote}){
  const same=(p.audioAssets||[]).find(a=>a.data===data);
  if(same){
   const merged=[...new Set([...(same.categories||[]),...(categories||[])])];
   return {asset:same,reused:true,categories:merged};
  }
  const a={id:newId,name,categories:[...new Set(categories||[])],data,mime,ext,bytes,
   duration:Number.isFinite(duration)?duration:null};
  if(durationNote)a.durationNote=durationNote;
  return {asset:a,reused:false,categories:a.categories};
 }
 function audioAsset(p,id){return (p.audioAssets||[]).find(a=>a.id===id)||null}
 /* 角色身份、表情身份、素材用途和场景图层是四个不同层次：同一个 ID 只表达
    一件事。校验只保证引用自洽，不回头按名字猜测或合并两个人。 */
 function checkCharacters(p){if(!Array.isArray(p.characters)||p.characters.length>80)throw Error('角色列表格式错误');const byId=new Map();for(const c of p.characters){if(!c||typeof c.id!=='string'||!c.id||byId.has(c.id)||typeof c.name!=='string'||!c.name.trim())throw Error('角色格式错误');if(typeof c.color!=='string'||(c.color&&!/^#[0-9a-fA-F]{6}$/.test(c.color)))throw Error('姓名颜色格式错误');if(!Array.isArray(c.expressions)||c.expressions.length>60)throw Error('角色表情列表格式错误');const eids=new Set();for(const e of c.expressions){if(!e||typeof e.id!=='string'||!e.id||eids.has(e.id)||typeof e.name!=='string'||!e.name.trim()||typeof e.assetId!=='string'||!e.assetId)throw Error('表情格式错误');eids.add(e.id)}if(typeof c.defaultExpressionId!=='string'||(c.defaultExpressionId&&!eids.has(c.defaultExpressionId)))throw Error('默认表情无效');byId.set(c.id,{character:c,expressions:eids})}
  const bind=(l,where)=>{if(!l.characterId)return;const entry=byId.get(l.characterId);if(!entry)throw Error(where+'引用的角色不存在');if(l.expressionId&&!entry.expressions.has(l.expressionId))throw Error(where+'引用的表情不存在')};
  for(const [i,n]of p.nodes.entries()){const at='第 '+(i+1)+' 节：';if(n.speakerId){const entry=byId.get(n.speakerId);if(!entry)throw Error(at+'说话人角色不存在');if(n.expressionId&&!entry.expressions.has(n.expressionId))throw Error(at+'说话人表情不存在')}else if(n.expressionId)throw Error(at+'选择了表情却没有指定角色');const used=new Set();for(const x of n.cast||[]){if(!x||typeof x.characterId!=='string'||!x.characterId||typeof x.expressionId!=='string')throw Error(at+'同场角色表情格式错误');if(used.has(x.characterId))throw Error(at+'同一个角色的表情重复指定');used.add(x.characterId);const entry=byId.get(x.characterId);if(!entry)throw Error(at+'同场角色表情引用的角色不存在');if(!entry.expressions.has(x.expressionId))throw Error(at+'同场角色表情引用的表情不存在')}for(const l of n.layers||[])bind(l,at+'图层「'+l.name+'」')}
  for(const t of p.presets||[])for(const l of t.layers||[])bind(l,'场景预设「'+(t.name||'')+'」图层「'+l.name+'」')}
 function scene(p,nodeId,trail){const n=p.nodes.find(n=>n.id===nodeId);if(!n)return [];if(n.sceneMode==='own')return n.layers;const before=trail||p.nodes.slice(0,p.nodes.indexOf(n)).map(n=>n.id);for(let i=before.length-1;i>=0;i--){const prev=p.nodes.find(n=>n.id===before[i]);if(prev?.sceneMode==='own')return prev.layers}return []}
 /* 沿实际经过的路径结算表情：每句只声明「谁、什么表情」，不改写别人的图层，
    因此同一条台词在别的分支上不会留下副作用。独立场景重置，与场景继承一致。 */
 function castAlong(p,nodeId,trail){const node=p.nodes.find(n=>n.id===nodeId);if(!node)return {};const route=trail||p.nodes.slice(0,p.nodes.indexOf(node)).map(n=>n.id);const state={};const apply=n=>{for(const x of n.cast||[])if(x&&x.characterId&&x.expressionId)state[x.characterId]=x.expressionId;if(n.speakerId&&n.expressionId)state[n.speakerId]=n.expressionId};for(const nid of route){const n=p.nodes.find(n=>n.id===nid);if(!n)continue;if(n.sceneMode==='own')for(const k of Object.keys(state))delete state[k];apply(n)}if(node.sceneMode==='own')for(const k of Object.keys(state))delete state[k];apply(node);return state}
 function characterIn(p,charId){return (p.characters||[]).find(c=>c.id===charId)||null}
 function expressionIn(p,charId,exprId){const c=characterIn(p,charId);return c?(c.expressions||[]).find(e=>e.id===exprId)||null:null}
 /* 舞台使用的图层：几何、ID、层级、透明度、效果目标都沿用原图层，只有素材
    关联按表情替换，所以切表情不会跳位、不会累计缩放、不会新增图层。 */
 function stage(p,nodeId,trail){const layers=scene(p,nodeId,trail);const node=p.nodes.find(n=>n.id===nodeId);if(!node||!(p.characters||[]).length)return layers;const cast=castAlong(p,nodeId,trail);const out=[];for(const l of layers){const ex=cast[l.characterId];if(!ex){out.push(l);continue}const e=expressionIn(p,l.characterId,ex);if(!e||e.assetId===l.asset){out.push(l);continue}out.push(Object.assign({},l,{asset:e.assetId,expressionId:e.id}))}return out}
 /* 说话人是「谁在说」，画面人物是「谁站在台上」，两者可以不同。 */
 function speakerOf(p,n){const c=n&&n.speakerId?characterIn(p,n.speakerId):null;return c?{name:c.name,color:c.color||'',character:c}:{name:(n&&n.name)||'',color:'',character:null}}
 function characterUsage(p,charId){const lines=[],layers=[];for(const [i,n]of p.nodes.entries()){if(n.speakerId===charId)lines.push(i);for(const l of n.layers||[])if(l.characterId===charId)layers.push({index:i,layerId:l.id,name:l.name})}return {lines,layers}}
 function expressionUsage(p,charId,exprId){const lines=[],layers=[];let isDefault=false;const c=characterIn(p,charId);if(c&&c.defaultExpressionId===exprId)isDefault=true;for(const [i,n]of p.nodes.entries()){if(n.speakerId===charId&&n.expressionId===exprId)lines.push(i);if((n.cast||[]).some(x=>x.characterId===charId&&x.expressionId===exprId))lines.push(i);for(const l of n.layers||[])if(l.characterId===charId&&l.expressionId===exprId)layers.push({index:i,layerId:l.id,name:l.name})}return {lines,layers,isDefault}}
 function edges(p,n){if(n.type==='end')return [];if(n.type==='choice')return(n.options||[]).map(o=>o.target).filter(Boolean);return [n.next||p.nodes[p.nodes.indexOf(n)+1]?.id].filter(Boolean)}
 function analyze(p){
  /* 结构化问题：界面靠 nodeId 定位，测试仍可用 errors/warnings 字符串数组。 */
  const issues=[],add=(level,text,extra)=>issues.push(Object.assign({level,text},extra||{}));
  const ids=new Set(p.nodes.map(n=>n.id)),aids=new Set(p.assets.map(a=>a.id));
  if(!p.nodes.length)add('error','还没有剧情节点。');
  for(const [i,n]of p.nodes.entries()){
   const at='第 '+(i+1)+' 节：';
   if(!n.text.trim())add('warn',at+'文本为空。',{nodeId:n.id,kind:'text'});
   if(n.type==='choice'){
    if(!n.options?.length)add('error',at+'没有选项。',{nodeId:n.id,kind:'options'});
    for(const o of n.options||[])if(!o.text.trim()||!ids.has(o.target))add('error',at+'选项文字为空或跳转目标无效。',{nodeId:n.id,kind:'target'});
   }
   if(n.next&&!ids.has(n.next))add('error',at+'跳转目标无效。',{nodeId:n.id,kind:'target'});
   for(const l of n.layers)if(!aids.has(l.asset))add('error',at+'图层「'+l.name+'」缺少图片。',{nodeId:n.id,kind:'asset',layerId:l.id});
   if(n.type==='say'&&!edges(p,n).length)add('warn',at+'对话在此结束，建议添加结局节点。',{nodeId:n.id,kind:'end'});
  }
  const layerIds=new Set(p.nodes.flatMap(n=>n.layers.map(l=>l.id)));
  for(const [i,n]of p.nodes.entries())for(const e of n.effects||[])if(!layerIds.has(e.layer))add('error','第 '+(i+1)+' 节：演出引用的图层已删除或被预设替换，请移除或重新添加该效果。',{nodeId:n.id,kind:'effect'});
  /* 角色/表情引用出错时必须说出来：静默回退会让作者以为画面已经改好。 */
  const chars=new Map((p.characters||[]).map(c=>[c.id,c]));
  for(const [i,n]of p.nodes.entries()){
   const at='第 '+(i+1)+' 节：';
   if(n.speakerId){
    const c=chars.get(n.speakerId);
    if(!c)add('error',at+'说话人角色已删除或丢失，请重新选择角色，或改为自由填写说话人。',{nodeId:n.id,kind:'cast'});
    else if(n.expressionId&&!c.expressions.some(e=>e.id===n.expressionId))add('error',at+'本句的表情在角色「'+c.name+'」中已删除，请重新选择或保留占位。',{nodeId:n.id,kind:'cast'});
   }else if(n.expressionId)add('error',at+'选择了表情但没有指定角色。',{nodeId:n.id,kind:'cast'});
   for(const x of n.cast||[]){
    const c=chars.get(x.characterId);
    if(!c)add('error',at+'同场角色已删除，请重新选择或清除该表情。',{nodeId:n.id,kind:'cast'});
    else if(!c.expressions.some(e=>e.id===x.expressionId))add('error',at+'同场角色「'+c.name+'」的表情已删除，请重新选择或清除。',{nodeId:n.id,kind:'cast'});
   }
   for(const l of n.layers||[]){
    if(!l.characterId)continue;
    const c=chars.get(l.characterId);
    if(!c){add('error',at+'图层「'+l.name+'」绑定的角色已删除。',{nodeId:n.id,kind:'cast'});continue}
    if(l.expressionId&&!c.expressions.some(e=>e.id===l.expressionId))add('error',at+'图层「'+l.name+'」绑定的表情已删除。',{nodeId:n.id,kind:'cast'});
   }
  }
  for(const c of p.characters||[]){
   if(!c.expressions.length)add('warn','角色「'+c.name+'」还没有表情，无法在台词里切换。',{kind:'cast'});
   else if(!c.defaultExpressionId)add('warn','角色「'+c.name+'」没有设置默认表情。',{kind:'cast'});
   for(const e of c.expressions)if(!aids.has(e.assetId))add('error','角色「'+c.name+'」的表情「'+e.name+'」缺少图片，请重新导入或删除该表情。',{kind:'cast'});
  }
  /* 音频引用失效必须说出来：静默跳过会让作者以为这一句已经配好音。 */
  const audioIds=new Set((p.audioAssets||[]).map(a=>a.id));
  for(const [i,n]of p.nodes.entries()){
   const at='第 '+(i+1)+' 节：',cue=audioCue(p,n);
   const need=(audioId,what)=>{if(audioId&&!audioIds.has(audioId))add('error',at+what+'引用的音频素材已删除或丢失，请重新选择或清除。',{nodeId:n.id,kind:'audio'})};
   if(cue.bgm&&cue.bgm.action==='play')need(cue.bgm.audioId,'背景音乐');
   for(const s of cue.sfx)need(s.audioId,'音效');
   if(cue.voice)need(cue.voice.audioId,'台词语音');
  }
  const visited=new Set(),queue=p.nodes.length?[p.nodes[0].id]:[];
  while(queue.length){const at=queue.pop();if(visited.has(at))continue;visited.add(at);const n=p.nodes.find(n=>n.id===at);if(n)queue.push(...edges(p,n))}
  p.nodes.forEach((n,i)=>{if(!visited.has(n.id))add('warn','第 '+(i+1)+' 节：无法从开头到达。',{nodeId:n.id,kind:'reach'})});
  const indegree=new Map([...visited].map(x=>[x,0]));
  for(const n of p.nodes)if(visited.has(n.id))for(const e of edges(p,n))if(indegree.has(e))indegree.set(e,indegree.get(e)+1);
  const q=[...indegree].filter(([,v])=>v===0).map(([k])=>k);let count=0;
  while(q.length){const at=q.pop();count++;const n=p.nodes.find(n=>n.id===at);if(n)for(const e of edges(p,n))if(indegree.has(e)){indegree.set(e,indegree.get(e)-1);if(indegree.get(e)===0)q.push(e)}}
  if(count<visited.size)add('warn','剧情存在可达循环；请确认玩家有退出循环的路径。');
  if(p.schema>=5){const known=new Set(paragraphIds(p));const loose=p.nodes.filter(n=>!known.has(n.paragraphId));if(loose.length)add('warn','有 '+loose.length+' 句不在任何段落里（未分组），可以用「移动到…」放进段落。',{nodeId:loose[0].id,kind:'group'})}
  return {
   errors:issues.filter(x=>x.level==='error').map(x=>x.text),
   warnings:issues.filter(x=>x.level==='warn').map(x=>x.text),
   issues
  };
 }

 /* ---------- 章节 / 段落 ---------- */
 /* 章节只是「归属」与显示结构：p.nodes 仍是播放顺序的唯一依据。节点用 paragraphId
    指向段落，段落用稳定 ID 指向章节，二者都不用名字或数组下标做引用。 */
 function checkChapters(p){
  if(!Array.isArray(p.chapters)||p.chapters.length>200)throw Error('章节列表格式错误');
  const pids=new Set();
  for(const c of p.chapters){
   if(!c||typeof c.id!=='string'||!c.id||typeof c.title!=='string')throw Error('章节格式错误');
   if(c.collapsed!=null&&typeof c.collapsed!=='boolean')throw Error('章节折叠状态格式错误');
   if(!Array.isArray(c.paragraphs)||c.paragraphs.length>200)throw Error('段落列表格式错误');
   for(const g of c.paragraphs){
    if(!g||typeof g.id!=='string'||!g.id||pids.has(g.id)||typeof g.title!=='string')throw Error('段落格式错误');
    if(g.collapsed!=null&&typeof g.collapsed!=='boolean')throw Error('段落折叠状态格式错误');
    pids.add(g.id);
   }
  }
  for(const [i,n]of p.nodes.entries())if(n.paragraphId&&!pids.has(n.paragraphId))throw Error('第 '+(i+1)+' 节：段落归属已失效');
 }
 function paragraphMap(p){const m=new Map();for(const c of p.chapters||[])for(const g of c.paragraphs||[])m.set(g.id,{chapter:c,paragraph:g});return m}
 function chapterOf(p,paragraphId){const e=paragraphMap(p).get(paragraphId);return e?e.chapter:null}
 /* 树只在渲染时按 p.nodes 的相对顺序归并，不维护第二份节点顺序。 */
 function tree(p){
  const byPg=new Map();
  for(const n of p.nodes){if(!byPg.has(n.paragraphId))byPg.set(n.paragraphId,[]);byPg.get(n.paragraphId).push(n.id)}
  const chapters=(p.chapters||[]).map(c=>({id:c.id,title:c.title,collapsed:!!c.collapsed,
   paragraphs:(c.paragraphs||[]).map(g=>({id:g.id,title:g.title,collapsed:!!g.collapsed,nodes:(byPg.get(g.id)||[]).slice()}))}));
  const known=new Set(paragraphIds(p));
  const ungrouped=p.nodes.filter(n=>!known.has(n.paragraphId)).map(n=>n.id);
  return {chapters,ungrouped};
 }
 /* 「按顺序继续」的实际去向：显式 next 优先，否则数组里的下一句。 */
 function orderSuccessor(p,n){if(!n||n.type==='choice')return '';if(n.next)return n.next;const i=p.nodes.indexOf(n);return p.nodes[i+1]?.id||''}
 function applyOrder(p,order){const map=new Map(p.nodes.map(n=>[n.id,n]));const next=[];for(const id of order){const n=map.get(id);if(n){next.push(n);map.delete(id)}}for(const n of map.values())next.push(n);p.nodes=next}
 function flattenOrder(p){
  const known=new Set(paragraphIds(p)),byPg=new Map();
  for(const n of p.nodes){if(!byPg.has(n.paragraphId))byPg.set(n.paragraphId,[]);byPg.get(n.paragraphId).push(n.id)}
  const out=[];
  for(const c of p.chapters||[])for(const g of c.paragraphs||[])for(const id of byPg.get(g.id)||[])out.push(id);
  for(const n of p.nodes)if(!known.has(n.paragraphId))out.push(n.id);
  return out;
 }
 /* 把节点放进目标段落：默认落到该段落最后一句之后，指定 beforeNodeId 时插在它前面。 */
 function moveNodeToParagraph(p,nodeId,paragraphId,beforeNodeId){
  const from=p.nodes.findIndex(n=>n.id===nodeId);if(from<0)return null;
  const node=p.nodes[from],fromParagraph=node.paragraphId;
  p.nodes.splice(from,1);
  let index=p.nodes.length;
  if(beforeNodeId){const at=p.nodes.findIndex(n=>n.id===beforeNodeId);if(at>=0)index=at}
  else{let last=-1;p.nodes.forEach((n,i)=>{if(n.paragraphId===paragraphId)last=i});if(last>=0)index=last+1}
  node.paragraphId=paragraphId;
  p.nodes.splice(index,0,node);
  return {nodeId,fromIndex:from,toIndex:index,fromParagraph,toParagraph:paragraphId};
 }
 /* 移动前先算出「哪些句子的顺序继续目标会变」，用于界面提示。显式 next/选项不受影响。 */
 function moveImpact(p,nodeId,paragraphId,beforeNodeId){
  const sim=clone(p);
  moveNodeToParagraph(sim,nodeId,paragraphId,beforeNodeId);
  const watch=new Set([nodeId]);
  for(const arr of [p,sim]){const i=arr.nodes.findIndex(n=>n.id===nodeId);for(const j of [i-1,i+1]){const n=arr.nodes[j];if(n)watch.add(n.id)}}
  const diffs=[];
  for(const id of watch){
   const a=p.nodes.find(n=>n.id===id),b=sim.nodes.find(n=>n.id===id);
   if(!a||!b)continue;
   const before=orderSuccessor(p,a),after=orderSuccessor(sim,b);
   if(before!==after)diffs.push({nodeId:id,before,after});
  }
  return {diffs,moved:p.nodes.indexOf(p.nodes.find(n=>n.id===nodeId))!==sim.nodes.findIndex(n=>n.id===nodeId)};
 }
 function orderDiff(before,after){
  const a=new Map(before.map((x,i)=>[x,i])),b=new Map(after.map((x,i)=>[x,i])),out=[];
  for(const id of before){const i=a.get(id),j=b.get(id);if(i==null||j==null||i===j)continue;const nb=before[i+1],na=after[j+1];if(nb!==na)out.push({nodeId:id,before:nb||'',after:na||''})}
  return out;
 }
 /* 按树顺序重排节点，但「未分组」的句子留在原位：删除分组不会因为后续整理被搬到最后。 */
 function applyTreeOrder(p){
  const groups=new Set(paragraphIds(p));
  const byGroup=new Map();
  for(const n of p.nodes){if(!byGroup.has(n.paragraphId))byGroup.set(n.paragraphId,[]);byGroup.get(n.paragraphId).push(n.id)}
  const out=[],emitted=new Set();
  for(const n of p.nodes){
   if(!groups.has(n.paragraphId)){out.push(n.id);continue}
   if(emitted.has(n.paragraphId))continue;
   emitted.add(n.paragraphId);
   for(const id of byGroup.get(n.paragraphId)||[])out.push(id);
  }
  applyOrder(p,out);
  return out;
 }
 function moveParagraph(p,paragraphId,targetChapterId,beforeParagraphId){
  const entry=paragraphMap(p).get(paragraphId);if(!entry)return null;
  const target=(p.chapters||[]).find(c=>c.id===targetChapterId)||entry.chapter;
  entry.chapter.paragraphs=entry.chapter.paragraphs.filter(g=>g.id!==paragraphId);
  let index=target.paragraphs.length;
  if(beforeParagraphId){const at=target.paragraphs.findIndex(g=>g.id===beforeParagraphId);if(at>=0)index=at}
  target.paragraphs.splice(index,0,entry.paragraph);
  const before=p.nodes.map(n=>n.id);
  applyTreeOrder(p);
  return {diffs:orderDiff(before,p.nodes.map(n=>n.id)),chapterId:target.id};
 }
 function moveChapter(p,chapterId,beforeChapterId){
  const i=(p.chapters||[]).findIndex(c=>c.id===chapterId);if(i<0)return null;
  const [c]=p.chapters.splice(i,1);
  let index=p.chapters.length;
  if(beforeChapterId){const at=p.chapters.findIndex(x=>x.id===beforeChapterId);if(at>=0)index=at}
  p.chapters.splice(index,0,c);
  const before=p.nodes.map(n=>n.id);
  applyTreeOrder(p);
  return {diffs:orderDiff(before,p.nodes.map(n=>n.id))};
 }
 /* 删除分组默认保留剧情：节点变成「未分组」，播放顺序完全不动。 */
 function removeParagraph(p,paragraphId){
  const entry=paragraphMap(p).get(paragraphId);if(!entry)return null;
  const ids=p.nodes.filter(n=>n.paragraphId===paragraphId).map(n=>n.id);
  entry.chapter.paragraphs=entry.chapter.paragraphs.filter(g=>g.id!==paragraphId);
  for(const n of p.nodes)if(n.paragraphId===paragraphId)n.paragraphId='';
  return {paragraphId,keptNodeIds:ids,chapterId:entry.chapter.id};
 }
 function removeChapter(p,chapterId){
  const c=(p.chapters||[]).find(x=>x.id===chapterId);if(!c)return null;
  const pids=(c.paragraphs||[]).map(g=>g.id),known=new Set(pids);
  const ids=p.nodes.filter(n=>known.has(n.paragraphId)).map(n=>n.id);
  p.chapters=p.chapters.filter(x=>x.id!==chapterId);
  for(const n of p.nodes)if(known.has(n.paragraphId))n.paragraphId='';
  return {chapterId,keptNodeIds:ids};
 }
 function addParagraph(p,chapterId,title){
  const c=(p.chapters||[]).find(x=>x.id===chapterId)||(p.chapters||[])[0];
  if(!c)throw Error('还没有章节');
  const g={id:'pg_'+id(),title:title||'新段落',collapsed:false};
  c.paragraphs.push(g);
  return g;
 }
 function addChapter(p,title){
  const c={id:'ch_'+id(),title:title||'新章节',collapsed:false,paragraphs:[{id:'pg_'+id(),title:'新段落',collapsed:false}]};
  p.chapters.push(c);
  return c;
 }

/* ---------- 从指定位置试玩 ---------- */
/* 目标句的前置状态由「进入点 → 目标句」的实际路径决定。这里做三件事：
   1) 有真实试玩路径就直接用；
   2) 否则从所有可能的进入点枚举到目标句的路径，按「最后一个独立场景 + 之后的尾巴」
      归一化——独立场景会重置图层、表情与持续效果，所以只有尾巴不同才算状态不同；
   3) 尾巴唯一才算确定，否则把候选路线交给界面让作者选择，绝不把各分支状态拼在一起。 */
function followGraph(p){
 const index=new Map(p.nodes.map((n,i)=>[n.id,i]));
 const next=new Map(),prev=new Map();
 for(const [i,n]of p.nodes.entries()){
  const targets=n.type==='end'?[]:n.type==='choice'
   ?(n.options||[]).map(o=>o.target).filter(t=>index.has(t))
   :[n.next||p.nodes[i+1]?.id].filter(t=>t&&index.has(t));
  next.set(n.id,targets);
  for(const t of targets){if(!prev.has(t))prev.set(t,[]);prev.get(t).push(n.id)}
 }
 return {index,next,prev};
}
/* 从 from 前进到 to 的所有简单路径（不重复节点），最多 limit 条，避免分支爆炸。 */
/* 枚举路径要设上限：分支多或结构异常时宁可停下来提示，也不能卡住窗口，
   更不能把「没枚举完」当成「只有一条路」。 */
const WALK_MAX_STEPS=4000,WALK_MAX_ROUTES=24,WALK_PER_ANCHOR=8;
function walkPaths(g,from,to,limit,budget){
 const out=[];
 const stack=[{at:from,path:[from],seen:new Set([from])}];
 while(stack.length&&out.length<limit){
  if(budget.steps++>=budget.maxSteps){budget.truncated=true;break}
  const {at,path,seen}=stack.pop();
  if(at===to){out.push(path);budget.routes++;continue}
  for(const nx of g.next.get(at)||[]){
   if(seen.has(nx))continue;
   const s2=new Set(seen);s2.add(nx);
   stack.push({at:nx,path:[...path,nx],seen:s2});
  }
 }
 return out;
}
/* 归一化：画面看最后一个独立场景，音频看最后一个显式音乐指令，两者取更早的起点。
   画面独立（sceneMode:'own'）不代表音乐独立：同一个画面入口前的不同路线可能播放过
   不同的 BGM，因此绝不能遇到 own 就把音频历史丢掉。trail 从更早的锚点开始，
   既保证 scene/effects/cast 能还原，也保证 audioStateAlong 能拿到完整音乐指令。 */
function normalizeRoute(p,path){
 let last=0,audioAt=-1;
 for(let i=0;i<path.length-1;i++){
  const n=p.nodes.find(x=>x.id===path[i]);
  if(n&&n.sceneMode==='own')last=i;
 }
 for(let i=0;i<path.length;i++){
  const n=p.nodes.find(x=>x.id===path[i]);
  if(n&&hasBgmInstruction(n))audioAt=i;
 }
 const start=audioAt>=0?Math.min(last,audioAt):last;
 const bgm=audioStateAlong(p,path);
 const bgmKey=bgm?[bgm.audioId,bgm.volume,bgm.loop?1:0,bgm.at].join('@'):'none';
 /* trail 必须包含画面进入点本身；判定等价时同时比较画面尾巴与音乐状态。 */
 const suffix=path.slice(last+1,path.length-1);
 return {anchorId:path[last],audioAnchorId:audioAt>=0?path[audioAt]:'',
  trail:path.slice(start,path.length-1),suffix,
  key:path[last]+'|'+suffix.join('>')+'#'+bgmKey,path,bgm,bgmKey,start};
}
function hasAnyAudio(p){return (p.audioAssets||[]).length>0||p.nodes.some(hasBgmInstruction)}
function entryPlan(p,nodeId,actualTrail){
 const node=p.nodes.find(n=>n.id===nodeId);
 if(!node)return null;
 /* 正在试玩并且就在这一句：真实走过的路径优先。用「路径最后一句确实通向本句」校验，
    分支路线长度和节点下标不一定相等，不能拿下标比。 */
 if(Array.isArray(actualTrail)&&actualTrail.length){
  const last=p.nodes.find(n=>n.id===actualTrail[actualTrail.length-1]);
  const succ=last?(last.type==='end'?[]:last.type==='choice'
   ?(last.options||[]).map(o=>o.target)
   :[last.next||p.nodes[p.nodes.indexOf(last)+1]?.id]):[];
  if(succ.includes(nodeId))return {trail:[...actualTrail],anchorId:'',source:'actual',ambiguous:false,options:[],fromOwn:node.sceneMode==='own',bgm:audioStateAlong(p,[...actualTrail,nodeId])};
 }
 /* 无音频工程保持原来的独立场景快速路径；只要工程里有音频，即使目标句是 own，
    也要枚举路线，否则会丢掉画面入口之前播放过的音乐。 */
 if(node.sceneMode==='own'&&!hasAnyAudio(p)){
  return {trail:[],anchorId:node.id,source:'scene',ambiguous:false,options:[],fromOwn:true,bgm:null};
 }
 const g=followGraph(p);
 const firstId=p.nodes[0]?.id||'';
 /* 锚点只用独立画面入口与故事开头。把「有音乐指令的节点」也当锚点会造出
    音频历史不完整的短路径，反而会把生效音乐判错。 */
 const anchors=p.nodes.filter(n=>n.sceneMode==='own').map(n=>n.id);
 if(firstId&&!anchors.includes(firstId))anchors.push(firstId);
 const budget={steps:0,routes:0,maxSteps:WALK_MAX_STEPS,truncated:false};
 const routes=[];
 for(const a of anchors){
  if(a===nodeId&&a!==firstId)continue;         /* 以目标句自身为起点不构成前置路线 */
  for(const path of walkPaths(g,a,nodeId,WALK_PER_ANCHOR,budget)){
   if(path.length<2&&a!==firstId)continue;
   routes.push(Object.assign(normalizeRoute(p,path),{fromStart:a===firstId}));
   if(routes.length>=WALK_MAX_ROUTES){budget.truncated=true;break}
  }
  if(budget.truncated)break;
 }
 /* 只有「从故事开头可达」的路线带有完整音乐历史；有完整路线时优先采用，
    否则不把不完整的短路径当成确定状态。 */
 const complete=routes.filter(r=>r.fromStart);
 const usable=complete.length?complete:routes;
 const unique=new Map();
 for(const r of usable){
  if(!unique.has(r.key))unique.set(r.key,{...r,count:0});
  unique.get(r.key).count++;
 }
 const options=[...unique.values()];
 if(!complete.length&&options.length){
  return {trail:[...options[0].trail],anchorId:options[0].anchorId,source:'incomplete',ambiguous:true,options,
   fromOwn:false,truncated:budget.truncated,audioAgrees:false,bgm:null,
   reason:'无法从故事开头还原这句之前播放过的音乐。请从更靠前的入口（开始播放音乐的那句）试玩，或在下面选择一条路线。'};
 }
 if(!options.length){
  return {trail:[],anchorId:'',source:'none',ambiguous:true,options:[],fromOwn:false,bgm:null,
   reason:'找不到从任何入口到这句的路径；请从更靠前的场景入口开始试玩。'};
 }
 /* 枚举被预算截断时，即使只看到一条也不能断言唯一 */
 if(options.length===1&&!budget.truncated){
  const only=options[0];
  return {trail:[...only.trail],anchorId:only.anchorId,source:'graph',ambiguous:false,options:[],fromOwn:false,path:only.path,bgm:only.bgm};
 }
 if(options.length===1&&budget.truncated){
  return {trail:[...options[0].trail],anchorId:options[0].anchorId,source:'truncated',ambiguous:true,options,fromOwn:false,truncated:true,bgm:null,
   reason:'这句之前的路线太多或存在循环，已停止枚举。请从更明确的入口（独立场景第一句或开始播放音乐的那句）开始试玩。'};
 }
 /* 路线可能因为画面/表情不唯一而有歧义，但各条路线的音乐可能相同：
    这时仍要让作者选画面路线，同时明确告诉他当前生效的是哪首音乐。 */
 const keys=options.map(o=>{const b=o.bgm;return b?[b.audioId,b.volume,b.loop].join('@'):'none'});
 const audioAgrees=keys.every(k=>k===keys[0]);
 return {trail:[...options[0].trail],anchorId:options[0].anchorId,source:'ambiguous',ambiguous:true,options,
  fromOwn:false,truncated:budget.truncated,audioAgrees,bgm:audioAgrees?options[0].bgm:null};
}
/* 兼容旧调用：只返回一条路径与是否确定。 */
function entryPath(p,nodeId,actualTrail){
 const plan=entryPlan(p,nodeId,actualTrail);
 if(!plan)return null;
 return {trail:plan.trail,anchorId:plan.anchorId,fromOwn:plan.fromOwn,uncertain:plan.ambiguous,reasons:[]};
}
 /* ---------- 批量编辑（V0.4.3） ---------- */
/* 一切批量写入先生成计划，再整体应用：计划里带每个目标的「改前/改后」与跳过原因，
   界面据此预览；应用时用深拷贝写回，一次 edit() 只有一条撤销记录。 */
function sceneFor(p,nodeId){
 const plan=entryPlan(p,nodeId);
 if(!plan)return {ok:false,reason:'这句已经不存在'};
 if(plan.ambiguous)return {ok:false,ambiguous:true,reason:'这句的前置路线不唯一，无法确定画面'};
 return {ok:true,layers:scene(p,nodeId,plan.trail)};
}
function exprNameOfChar(c,exprId){const e=c&&(c.expressions||[]).find(x=>x.id===exprId);return e?e.name:''}
function sceneForCast(p,nodeId,characterId){
 const info=sceneFor(p,nodeId);
 if(!info.ok)return info;
 const layers=info.layers.filter(l=>l.characterId===characterId);
 if(!layers.length)return {ok:false,reason:'这句的画面里没有这个角色'};
 if(layers.length>1)return {ok:false,reason:'这个角色在这句里对应多个图层，无法确定改哪一张'};
 return {ok:true,layer:layers[0],layers:info.layers};
}
/* fields：
   speaker:            { characterId }   '' 表示清空为自由文本
   speakerExpression:  { expressionId }  '' 表示沿用画面表情
   cast:               { characterId, expressionId }  expressionId '' 表示清除该角色在本句的表情
   未出现的字段表示「不修改」。 */
function planBatch(p,nodeIds,fields){
 const f=fields||{};
 const plan={total:0,changes:[],skipped:[],conflicts:[],fields:{}};
 const seen=new Set();
 for(const id of nodeIds||[]){
  if(seen.has(id))continue;
  seen.add(id);
  plan.total++;
  const node=p.nodes.find(n=>n.id===id);
  if(!node){plan.skipped.push({nodeId:id,reason:'这句已经不存在'});continue}
  if(node.type!=='say'){plan.skipped.push({nodeId:id,reason:node.type==='choice'?'选项节点不参与批量修改（避免改动结构）':'结局节点不参与批量修改（避免改动结构）'});continue}
  const before={speakerId:node.speakerId||'',expressionId:node.expressionId||'',cast:clone(node.cast||[]),name:node.name||''};
  const after={speakerId:before.speakerId,expressionId:before.expressionId,cast:clone(before.cast),name:before.name};
  const notes=[];
  let bad=false;
  const skip=reason=>{plan.skipped.push({nodeId:id,reason});bad=true};
  const conflict=reason=>{plan.conflicts.push({nodeId:id,reason});bad=true};
  /* 1) 说话角色 */
  if(f.speaker){
   const cid=f.speaker.characterId||'';
   if(cid){
    const c=characterIn(p,cid);
    if(!c)conflict('要设置的角色已经不存在');
    else{
     after.speakerId=cid;after.name=c.name;
     if(after.expressionId&&!c.expressions.some(e=>e.id===after.expressionId)){
      const def=c.defaultExpressionId||'';
      notes.push('原表情不属于「'+c.name+'」，已'+(def?'改为默认表情「'+exprNameOfChar(c,def)+'」':'清空为沿用画面表情'));
      after.expressionId=def;
     }
    }
   }else{
    after.speakerId='';after.expressionId='';
    notes.push('改为自由文本说话人，保留原来的名字文字：'+(before.name||'旁白'));
   }
  }
  /* 2) 说话角色的表情 */
  if(f.speakerExpression){
   const want=f.speakerExpression.expressionId||'';
   if(!after.speakerId)skip('这句没有说话角色，先设置说话角色');
   else if(want){
    const c=characterIn(p,after.speakerId);
    if(!c||!c.expressions.some(e=>e.id===want))conflict('表情不属于这句的说话角色');
    else{after.expressionId=want;notes.push('说话表情改为「'+exprNameOfChar(c,want)+'」')}
   }else{after.expressionId='';notes.push('说话表情清空为沿用画面表情')}
  }
  /* 3) 在场角色的表情（只改本句的绑定，不动图层几何与其他角色） */
  if(f.cast){
   const cid=f.cast.characterId||'';
   const want=f.cast.expressionId||'';
   if(!cid)skip('没有选择在场的角色');
   else if(after.speakerId===cid&&f.speakerExpression){
    conflict('同一个角色既设了说话人表情又设了在场表情，只能保留一个');
   }else{
    const info=sceneForCast(p,id,cid);
    if(!info.ok)skip(info.reason);
    else{
     const c=characterIn(p,cid);
     if(!c)conflict('要设置的角色已经不存在');
     else if(want&&!c.expressions.some(e=>e.id===want))conflict('表情不属于这个角色');
     else{
      const idx=after.cast.findIndex(x=>x.characterId===cid);
      if(want){
       if(idx>=0)after.cast[idx]={characterId:cid,expressionId:want};
       else after.cast.push({characterId:cid,expressionId:want});
       notes.push('在场「'+c.name+'」的表情改为「'+exprNameOfChar(c,want)+'」');
      }else if(idx>=0){after.cast.splice(idx,1);notes.push('清除「'+c.name+'」在本句的表情绑定')}
     }
    }
   }
  }
  if(bad)continue;
  if(JSON.stringify(before)===JSON.stringify(after)){plan.skipped.push({nodeId:id,reason:'这句已经是目标状态'});continue}
  plan.changes.push({nodeId:id,before,after,notes,index:p.nodes.findIndex(n=>n.id===id)});
 }
 plan.fields=Object.keys(f).length;
 return plan;
}
function applyBatch(p,plan){
 for(const change of plan.changes||[]){
  const node=p.nodes.find(n=>n.id===change.nodeId);
  if(!node)continue;
  node.speakerId=change.after.speakerId;
  node.expressionId=change.after.expressionId;
  node.name=change.after.name;
  node.cast=clone(change.after.cast);
 }
 return (plan.changes||[]).map(c=>c.nodeId);
}
/* ---------- 复制 / 粘贴场景 ---------- */
/* 只复制源句自己保存的独立场景：继承场景不推断，提示作者先建立独立场景。 */
function planPasteScene(p,sourceId,targetIds){
 const source=p.nodes.find(n=>n.id===sourceId);
 if(!source)return {ok:false,reason:'源句已经不存在',targets:[]};
 if(source.sceneMode!=='own')return {ok:false,reason:'源句沿用了上一画面，没有自己的场景布局。请先用「独立画面」把它变成独立场景再复制。',targets:[]};
 const layers=clone(source.layers||[]);
 const targets=[];
 for(const id of targetIds||[]){
  const node=p.nodes.find(n=>n.id===id);
  if(!node){targets.push({nodeId:id,ok:false,reason:'这句已经不存在'});continue}
  if(id===sourceId){targets.push({nodeId:id,ok:false,reason:'源句就是目标句，已跳过'});continue}
  const issues=[];
  const newIds=new Set(layers.map(l=>l.id));
  for(const e of node.effects||[])if(!newIds.has(e.layer))issues.push('原有演出指向的图层在粘贴后不存在（'+(e.type)+'）');
  for(const l of layers){
   if(l.characterId&&!characterIn(p,l.characterId))issues.push('图层「'+l.name+'」绑定的角色已删除');
   else if(l.characterId&&l.expressionId){
    const c=characterIn(p,l.characterId);
    if(c&&!c.expressions.some(x=>x.id===l.expressionId))issues.push('图层「'+l.name+'」绑定的表情已删除');
   }
  }
  targets.push({nodeId:id,ok:issues.length===0,issues,layers:clone(layers),beforeSceneMode:node.sceneMode,beforeLayerCount:(node.layers||[]).length});
 }
 return {ok:true,sourceId,layers,targets};
}
function applyPasteScene(p,plan,onlySafe){
 for(const t of plan.targets||[]){
  if(!t.ok&&!onlySafe)continue;
  if(!t.ok)continue;
  const node=p.nodes.find(n=>n.id===t.nodeId);
  if(!node)continue;
  node.sceneMode='own';
  node.layers=clone(plan.layers);
 }
 return (plan.targets||[]).filter(t=>t.ok).map(t=>t.nodeId);
}
/* ---------- 复制 / 粘贴演出 ---------- */
function planPasteEffects(p,sourceId,targetIds,mode){
 const makeId=id;                    /* 循环变量 id 会遮住生成器，这里先留一份 */
 const source=p.nodes.find(n=>n.id===sourceId);
 if(!source)return {ok:false,reason:'源句已经不存在',targets:[]};
 const effects=clone(source.effects||[]);
 if(!effects.length)return {ok:false,reason:'源句没有演出可以复制',targets:[]};
 const srcScene=sceneFor(p,sourceId);
 const targets=[];
 for(const id of targetIds||[]){
  const node=p.nodes.find(n=>n.id===id);
  if(!node){targets.push({nodeId:id,ok:false,reason:'这句已经不存在'});continue}
  if(id===sourceId){targets.push({nodeId:id,ok:false,reason:'源句就是目标句，已跳过'});continue}
  const sceneInfo=sceneFor(p,id);
  if(!sceneInfo.ok){targets.push({nodeId:id,ok:false,reason:sceneInfo.reason+'（不按某条路线猜图层）'});continue}
  const targetLayers=sceneInfo.layers;
  const mapping={},issues=[];
  for(const e of effects){
   const srcLayer=(srcScene.ok?srcScene.layers:[]).find(l=>l.id===e.layer)||(source.layers||[]).find(l=>l.id===e.layer);
   const byId=targetLayers.find(l=>l.id===e.layer);
   if(byId&&(!srcLayer||!srcLayer.characterId||byId.characterId===srcLayer.characterId)){mapping[e.id]=byId.id;continue}
   const charId=srcLayer&&srcLayer.characterId;
   if(charId){
    const same=targetLayers.filter(l=>l.characterId===charId);
    if(same.length===1){mapping[e.id]=same[0].id;continue}
    if(!same.length)issues.push('这句的画面里没有「'+(srcLayer.name||e.layer)+'」这一层');
    else issues.push('「'+(srcLayer.name||e.layer)+'」在这句里对应 '+same.length+' 个图层，需要指定映射');
    continue;
   }
   issues.push('这句的画面里没有「'+(srcLayer?srcLayer.name:e.layer)+'」这一层');
  }
  if(mode==='append'&&!issues.length){
   const keys=new Set((node.effects||[]).map(e=>e.layer+'/'+e.type));
   for(const e of effects){
    const lid=mapping[e.id];
    if(keys.has(lid+'/'+e.type))issues.push('这句在这一层已经有同类演出（'+(e.type)+'），追加会冲突；请改用「替换」或先删掉原有演出');
   }
  }
  targets.push({
   nodeId:id,ok:issues.length===0,issues,
   mapping,
   effects:effects.map(e=>Object.assign(clone(e),{id:makeId(),layer:mapping[e.id]||e.layer})),
   removed:(mode==='replace'?(node.effects||[]).length:0)
  });
 }
 return {ok:true,sourceId,mode:mode==='append'?'append':'replace',effects,targets};
}
function applyPasteEffects(p,plan,onlySafe){
 const makeId=id;
 const applied=[];
 for(const t of plan.targets||[]){
  if(!t.ok)continue;
  const node=p.nodes.find(n=>n.id===t.nodeId);
  if(!node)continue;
  node.effects=plan.mode==='append'
   ?[...(node.effects||[]),...t.effects.map(e=>Object.assign(clone(e),{id:id()}))]
   :t.effects.map(e=>clone(e));
  applied.push(t.nodeId);
 }
 return applied;
}

/* ---------- TXT 文本解析（纯函数，导入前预览用） ---------- */
 /* 只认 # 章节、## 段落、以及「名字：台词」。不推断选项、结局或分支。 */
 function parseScript(text,characters){
  const lines=String(text==null?'':text).replace(/\r\n?/g,'\n').split('\n');
  const chapters=[],unrecognized=[];
  const byName=new Map(),dupNames=new Set();
  for(const c of characters||[]){
   if(!c||typeof c.name!=='string')continue;
   if(byName.has(c.name))dupNames.add(c.name);else byName.set(c.name,c);
  }
  let chapter=null,paragraph=null;
  const ensure=()=>{
   if(!chapter){chapter={title:'导入内容',paragraphs:[]};chapters.push(chapter)}
   if(!paragraph){paragraph={title:'默认段落',nodes:[]};chapter.paragraphs.push(paragraph)}
  };
  for(const [i,raw]of lines.entries()){
   const line=String(raw).trim();
   if(!line)continue;
   let m;
   if((m=/^#\s+(.*)$/.exec(line))){
    chapter={title:m[1].trim()||'未命名章节',paragraphs:[]};
    paragraph=null;                      /* 段落由下面的 ## 或第一句按需创建 */
    chapters.push(chapter);
    continue;
   }
   if((m=/^##\s+(.*)$/.exec(line))){
    if(!chapter){chapter={title:'导入内容',paragraphs:[]};chapters.push(chapter)}
    paragraph={title:m[1].trim()||'未命名段落',nodes:[]};
    chapter.paragraphs.push(paragraph);
    continue;
   }
   if(/^#/.test(line)){unrecognized.push({lineNo:i+1,text:line,reason:'无法识别的标题格式'});continue}
   ensure();
   if(/^[：:]/.test(line)){unrecognized.push({lineNo:i+1,text:line,reason:'说话人为空'});continue}
   const dm=/^([^：:]{1,20})[：:]\s*(.*)$/.exec(line);
   let name='',body=line,speakerId='',note='';
   if(dm){name=dm[1].trim();body=dm[2].trim()}
   if(dm&&!name){unrecognized.push({lineNo:i+1,text:line,reason:'说话人为空'});continue}
   if(name==='旁白')name='';          /* 「旁白：」是合法的旁白写法，不是空说话人 */
   if(!body){unrecognized.push({lineNo:i+1,text:line,reason:'台词内容为空'});continue}
   if(name){
    if(dupNames.has(name))note='角色重名，保留自由文本说话人';
    else if(byName.has(name))speakerId=byName.get(name).id;
   }
   paragraph.nodes.push({name,speakerId,text:body,lineNo:i+1,note});
  }
  const all=chapters.flatMap(c=>c.paragraphs.flatMap(g=>g.nodes));
  return {
   chapters,unrecognized,
   stats:{chapters:chapters.length,paragraphs:chapters.reduce((s,c)=>s+c.paragraphs.length,0),nodes:all.length,
    bound:all.filter(n=>n.speakerId).length,free:all.filter(n=>!n.speakerId&&n.name).length,narration:all.filter(n=>!n.name).length}
  };
 }
 /* 把预览结果一次性写进工程：一次 edit() 即可整体撤销。 */
 function applyScriptPlan(p,plan,options){
  const opts=options||{};
  const created={chapters:[],paragraphs:[],nodes:[]};
  const pushNodes=(paragraphId,list)=>{
   for(const item of list){
    const n=makeNode('say');
    const who=item.speakerId?characterIn(p,item.speakerId):null;
    n.name=who?who.name:(item.name||'');
    n.speakerId=who?who.id:'';          /* 预览后角色被删掉时退回自由文本，不留悬空引用 */
    n.text=item.text;
    n.paragraphId=paragraphId;
    p.nodes.push(n);
    created.nodes.push(n.id);
   }
  };
  if(opts.mode==='paragraph'){
   const pid=opts.paragraphId;
   if(!paragraphMap(p).get(pid))throw Error('目标段落不存在');
   pushNodes(pid,plan.chapters.flatMap(c=>c.paragraphs.flatMap(g=>g.nodes)));
   return created;
  }
  for(const pc of plan.chapters){
   const c={id:'ch_'+id(),title:pc.title,collapsed:false,paragraphs:[]};
   p.chapters.push(c);created.chapters.push(c.id);
   for(const pg of pc.paragraphs){
    const g={id:'pg_'+id(),title:pg.title,collapsed:false};
    c.paragraphs.push(g);created.paragraphs.push(g.id);
    pushNodes(g.id,pg.nodes);
   }
  }
  return created;
 }
 function makeNode(type='say'){return {id:id(),type,name:'',text:'',next:'',sceneMode:'inherit',layers:[],effects:[],speakerId:'',expressionId:'',cast:[],paragraphId:'',audio:null,...(type==='choice'?{options:[{text:'选项一',target:''},{text:'选项二',target:''}]}:{})}}
 function blank(){const p={schema:5,id:id(),title:'未命名的故事',assets:[],audioAssets:[],nodes:[],presets:[],characters:[],chapters:[]};const g={id:'pg_'+id(),title:'默认段落',collapsed:false};p.chapters.push({id:'ch_'+id(),title:'第一章',collapsed:false,paragraphs:[g]});return p}
 function sample(){const p=blank();p.title='晚风来信 · 局部分支示例';const a=makeNode(),b=makeNode('choice'),c=makeNode(),d=makeNode(),e=makeNode(),merge=makeNode(),end=makeNode('end');a.sceneMode='own';a.name='旁白';a.text='放学后的走廊，风把书页轻轻翻开。';b.name='澪';b.text='要不要一起走一段？';c.name='我';c.text='先去图书馆吧。我想给你看一本书。';d.name='我';d.text='绕操场走走？今天的晚风很舒服。';e.name='我';e.text='我们到门口等一等，看看天边的云。';merge.name='旁白';merge.text='聊着不同的话题，我们还是并肩走出了校门。';end.name='结局';end.text='这一次，选择改变了沿途的谈话，却没有改变共同的约定。';b.options=[{text:'去图书馆',target:c.id},{text:'绕操场走走',target:d.id},{text:'在门口看云',target:e.id}];c.next=d.next=e.next=merge.id;p.nodes=[a,b,c,d,e,merge,end];const pid=p.chapters[0].paragraphs[0].id;for(const n of p.nodes)n.paragraphId=pid;return p}
 /* 素材查重按「图片数据 + 用途」而不是只看图片数据：同一张图既能当背景也能当角色，
    只按 data 复用会把先导入那一次的 kind 带回新图层，用途就错了。 */
 function assetForImport(p,{id:newId,name,kind,data,width,height}){
  const same=(p.assets||[]).find(a=>a.data===data&&a.kind===kind);
  if(same)return {asset:same,reused:true};
  const a={id:newId,name,kind,data};
  if(Number.isFinite(width)&&Number.isFinite(height)){a.width=width;a.height=height}
  return {asset:a,reused:false};
 }
 /* 新图层的初始几何：背景铺满画面，角色站在底部并按原图比例收窄。 */
 function defaultLayer(a,bind){
  const ratio=(a.width||1280)/(a.height||720);let w,h;
  if(a.kind==='bg'){if(ratio>16/9){h=100;w=100*ratio/(16/9)}else{w=100;h=100*(16/9)/ratio}}
  else{h=85;w=h*9/16*ratio;if(w>90){h*=90/w;w=90}}
  const l={id:id(),asset:a.id,name:a.name,kind:a.kind,x:(100-w)/2,y:a.kind==='bg'?(100-h)/2:100-h,w,h,fit:'contain',opacity:100,hidden:false,locked:false,motion:'none',characterId:'',expressionId:''};
  if(bind&&bind.characterId){l.characterId=bind.characterId;l.expressionId=bind.expressionId||''}
  return l;
 }
 /* 追加图层：背景插在角色下面，角色压在背景上面。同素材可被多个图层复用。 */
 function appendAssetLayer(node,asset,bind){
  const l=defaultLayer(asset,bind);
  if(asset.kind==='bg'){const i=node.layers.findIndex(x=>x.kind==='char');node.layers.splice(i<0?node.layers.length:i,0,l)}
  else node.layers.push(l);
  return l;
 }
 return {clone,id,validate,migrate,scene,castAlong,stage,characterIn,expressionIn,speakerOf,characterUsage,expressionUsage,edges,analyze,makeNode,blank,sample,assetForImport,defaultLayer,appendAssetLayer,
  tree,checkChapters,paragraphMap,chapterOf,paragraphIds,orderSuccessor,orderDiff,flattenOrder,
  moveNodeToParagraph,moveImpact,moveParagraph,moveChapter,applyTreeOrder,removeParagraph,removeChapter,addParagraph,addChapter,
  entryPath,entryPlan,followGraph,sceneFor,sceneForCast,planBatch,applyBatch,planPasteScene,applyPasteScene,planPasteEffects,applyPasteEffects,parseScript,applyScriptPlan,
  checkAudio,checkNodeAudio,audioCue,hasBgmInstruction,hasAnyAudio,audioStateAlong,bgmAt,audioUsage,assetForAudioImport,audioAsset,AUDIO_CATS,AUDIO_MAX_BYTES};
}
if(typeof module!=='undefined')module.exports=createVNCore;
