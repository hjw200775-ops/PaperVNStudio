'use strict';
const C=createVNCore(),F=createPaperEffects(),$=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const H=window.PaperHost||null; /* desktop adapter; null keeps the original web behaviour */
let p=C.sample(),selected=p.nodes[0].id,selectedLayer=null,playing=false,current=selected,trail=[],db,saveTimer,toastTimer,hideDialogue=false,drag=null;
let effectId=null,effectMode='layout',effectCancel=()=>{},playbackAnimate=true;
let past=[],future=[],group='',groupTime=0,revision=0,slot=null,castSel=null;
const node=()=>p.nodes.find(n=>n.id===selected),active=()=>p.nodes.find(n=>n.id===(playing?current:selected));
const displayed=()=>C.scene(p,playing?current:selected,playing?trail:undefined);
/* 舞台渲染用 C.stage：几何来自图层，素材按本句表情替换，不改写原图层。 */
const staged=()=>C.stage(p,playing?current:selected,playing?trail:undefined);
const layer=()=>displayed().find(l=>l.id===selectedLayer),asset=id=>p.assets.find(a=>a.id===id);
function snapshot(){return {...p,nodes:C.clone(p.nodes),assets:[...p.assets],presets:C.clone(p.presets),characters:C.clone(p.characters||[]),selected,selectedLayer}}
function restore(s){const {selected:sel,selectedLayer:ls,...project}=s;p=project;selected=sel;selectedLayer=ls;playing=false;trail=[];revision++;queueSave();render()}
function checkpoint(key=''){const now=Date.now();if(!key||key!==group||now-groupTime>900){past.push(snapshot());if(past.length>60)past.shift()}group=key;groupTime=now;future=[];}
function edit(fn,key=''){if(playing)return toast('请先退出试玩再编辑');checkpoint(key);fn();revision++;queueSave();render()}
function saveChanged(){revision++;group='';queueSave();render()}
function undo(){if(playing||!past.length)return;future.push(snapshot());const s=past.pop();group='';restore(s)}function redo(){if(playing||!future.length)return;past.push(snapshot());const s=future.pop();group='';restore(s)}
$('#undo').onclick=undo;$('#redo').onclick=redo;
document.addEventListener('keydown',e=>{const typing=e.target.matches('input,textarea,select,[contenteditable=true]');if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!typing){e.preventDefault();e.shiftKey?redo():undo()}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'&&!typing){e.preventDefault();redo()}else if(e.key==='Escape'&&drag){const state=past.pop();drag=null;if(state)restore(state)}else if(e.key==='Escape'&&!typing&&!playing){selectedLayer=null;renderLayerUI();renderCanvas()}});
function toast(t){$('#toast').textContent=t;$('#toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').style.display='none',3800)}
function modal(title,body){$('#modalBody').innerHTML='<h2>'+esc(title)+'</h2>'+body;$('#modal').showModal()}
$('#closeModal').onclick=()=>$('#modal').close();
function queueSave(){$('#saved').textContent='正在保存…';clearTimeout(saveTimer);saveTimer=setTimeout(persist,350)}
function persist(){if(H){H.autoSave(p).then(r=>{$('#saved').textContent=r.ok?'已自动保存':'自动保存失败 · '+(r.message||'')}).catch(e=>{$('#saved').textContent='自动保存失败';toast(e.message||'自动保存失败')});return}if(!db){$('#saved').textContent='请下载工程备份';return}try{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(p,'draft');tx.oncomplete=()=>$('#saved').textContent='已保存在此浏览器';tx.onerror=()=>{$('#saved').textContent='自动保存失败';toast('浏览器空间不足，请保存工程文件备份。')}}catch{$('#saved').textContent='请下载工程备份'}}
async function decodeAsset(a){if(a.width&&a.height)return;await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>{a.width=im.naturalWidth;a.height=im.naturalHeight;resolve()};im.onerror=()=>reject(Error('图片「'+a.name+'」无法解码'));im.src=a.data})}
async function loadProject(raw){C.validate(raw);const x=C.clone(raw);await Promise.all(x.assets.map(decodeAsset));const out=C.migrate(x);C.validate(out);out.nodes.forEach(n=>F.validate(n.effects));return out}
async function initialize(){if(H){const started=revision;try{const s=await H.bootstrap();H.applyState(s);if(s.notice)toast(s.notice);if(s.project){const restored=await loadProject(s.project);if(revision!==started)return;p=restored;selected=p.nodes[0]?.id;selectedLayer=null;render();$('#saved').textContent=s.currentDir?'已打开工程':'已恢复草稿 · 请另存为'}else $('#saved').textContent='准备就绪 · 保存工程以创建目录'}catch(e){toast('启动恢复失败：'+e.message);$('#saved').textContent='请手动保存工程'}return}try{const req=indexedDB.open('paper-vn-studio',1);req.onupgradeneeded=()=>req.result.createObjectStore('projects');req.onsuccess=()=>{db=req.result;const started=revision,r=db.transaction('projects').objectStore('projects').get('draft');r.onsuccess=async()=>{if(!r.result)return;try{const restored=await loadProject(r.result);if(revision!==started)return;p=restored;selected=p.nodes[0]?.id;selectedLayer=null;render();$('#saved').textContent='已恢复本地工程'+(r.result.schema<3?' · 已兼容升级':'')}catch(e){toast('本地工程未覆盖：'+e.message)}}};req.onerror=()=>$('#saved').textContent='请下载工程备份'}catch{$('#saved').textContent='请下载工程备份'}}
function indexLabel(id){const i=p.nodes.findIndex(n=>n.id===id);if(i<0)return '目标已删除';const n=p.nodes[i];return String(i+1).padStart(2,'0')+' · '+(n.type==='end'?'结局':n.type==='choice'?'选择':n.name||'旁白')+' / '+(n.text||'空文本').slice(0,16)}
function targets(value='',auto=true){let out='<option value="">'+(auto?'按顺序继续':'请选择对话 / 主线 / 结局')+'</option>';if(value&&!p.nodes.some(n=>n.id===value))out+='<option selected value="'+esc(value)+'">目标已删除，请重新设置</option>';return out+p.nodes.map(n=>'<option value="'+esc(n.id)+'" '+(n.id===value?'selected':'')+'>'+esc(indexLabel(n.id))+'</option>').join('')}
function renderList(){$('#count').textContent=p.nodes.length+' 个节点';$('#list').innerHTML=p.nodes.map((n,i)=>'<button class="node '+(n.id===selected?'active':'')+'" data-id="'+esc(n.id)+'"><span class="num">'+String(i+1).padStart(2,'0')+'</span><div><b>'+esc(n.name||'旁白')+'</b><em>'+({say:'对话',choice:'分支',end:'结局'}[n.type])+'</em><p>'+esc(n.text||'尚未填写文本')+'</p></div></button>').join('');$('#list').querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>selectNode(b.dataset.id))}
function selectNode(id){playing=false;trail=[];selected=id;selectedLayer=null;effectId=null;effectMode='layout';group='';render()}
function renderFlow(){$('#flow').innerHTML=p.nodes.map((n,i)=>'<div class="flow-row '+(n.id===selected?'active':'')+'"><button class="flow-title" data-go="'+esc(n.id)+'">'+esc(indexLabel(n.id))+'</button>'+ (n.type==='end'?'<p class="hint">终止剧情</p>':(n.type==='choice'?n.options.map(o=>({label:o.text,target:o.target})):[{label:n.next?'跳转 / 汇合':'顺序继续',target:n.next||p.nodes[i+1]?.id}]).map(e=>'<div class="flow-edge"><span>'+esc(e.label||'未命名')+' →</span><button data-go="'+esc(e.target||'')+'">'+esc(e.target?indexLabel(e.target):'未设置')+'</button></div>').join(''))+'</div>').join('');$('#flow').querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{if(p.nodes.some(n=>n.id===b.dataset.go))selectNode(b.dataset.go)})}
function inspector(){const n=node();$('.inspector-body').hidden=!n;if(!n)return;$('#nodeId').textContent='#'+String(p.nodes.indexOf(n)+1).padStart(2,'0');for(const [id,key]of [['type','type'],['name','name'],['body','text']]){if(document.activeElement!==$('#'+id))$('#'+id).value=n[key]}$('#jump').innerHTML=targets(n.next);$('#branchEditor').hidden=n.type!=='choice';$('#jumpEditor').hidden=n.type!=='say';$('#inherit').checked=n.sceneMode==='inherit';renderOptions();renderLayerUI()}
function renderOptions(){const n=node();if(!n)return;$('#options').innerHTML=(n.options||[]).map((o,i)=>'<div class="option"><input aria-label="选项文字 '+(i+1)+'" value="'+esc(o.text)+'" data-opt="'+i+'"><select aria-label="跳转目标 '+(i+1)+'" data-target="'+i+'">'+targets(o.target,false)+'</select><button data-del="'+i+'">移除此选项</button></div>').join('');$('#options').querySelectorAll('[data-opt]').forEach(e=>e.oninput=()=>{checkpoint('option-'+n.id+'-'+e.dataset.opt);n.options[+e.dataset.opt].text=e.value;revision++;queueSave();renderCanvas();renderFlow();updateHistory()});$('#options').querySelectorAll('[data-target]').forEach(e=>e.onchange=()=>edit(()=>n.options[+e.dataset.target].target=e.value));$('#options').querySelectorAll('[data-del]').forEach(e=>e.onclick=()=>edit(()=>n.options.splice(+e.dataset.del,1)))}
function makeOwn(){const n=node();if(n.sceneMode==='inherit'){n.layers=C.clone(displayed());n.sceneMode='own'}return n.layers}
function ownLayer(){const id=selectedLayer;return makeOwn().find(l=>l.id===id)}
function renderLayerUI(){const n=node();if(!n)return;const ls=displayed(),shown=new Map(staged().map(x=>[x.id,x]));if(selectedLayer&&!ls.some(l=>l.id===selectedLayer))selectedLayer=null;$('#layerList').innerHTML=[...ls].reverse().map(l=>'<div class="layer-row '+(l.id===selectedLayer?'active':'')+'"><img class="layer-thumb" alt="" src="'+(asset((shown.get(l.id)||l).asset)?.data||'')+'"><button class="layer-select" data-layer="'+esc(l.id)+'">'+esc(l.name)+'<small>'+layerMeta(l,shown.get(l.id)||l)+' · '+(l.hidden?'已隐藏':l.locked?'已锁定':'可拖动')+'</small></button><button data-visible="'+esc(l.id)+'" aria-label="'+(l.hidden?'显示':'隐藏')+' '+esc(l.name)+'">'+(l.hidden?'显示':'隐藏')+'</button><button data-lock="'+esc(l.id)+'" aria-label="'+(l.locked?'解锁':'锁定')+' '+esc(l.name)+'">'+(l.locked?'解锁':'锁定')+'</button></div>').join('');$('#layerList').querySelectorAll('[data-layer]').forEach(b=>b.onclick=()=>{selectedLayer=b.dataset.layer;renderLayerUI();renderCanvas()});for(const [selector,attr,key]of [['[data-visible]','visible','hidden'],['[data-lock]','lock','locked']])$('#layerList').querySelectorAll(selector).forEach(b=>b.onclick=()=>edit(()=>{const ls=makeOwn(),l=ls.find(l=>l.id===b.dataset[attr]);l[key]=!l[key]}));const l=layer();$('#layerProps').hidden=!l;if(l){for(const [id,key]of [['layerName','name'],['lx','x'],['ly','y'],['lw','w'],['lh','h'],['opacity','opacity'],['motion','motion']]){const e=$('#'+id);if(document.activeElement!==e)e.value=l[key];e.disabled=l.locked}$('#opacityValue').textContent=l.opacity+'%';for(const id of ['fitContain','fitCover','centerLayer','resetLayer','layerDown','layerUp','copyLayer','removeLayer'])$('#'+id).disabled=l.locked
 $('#layerCharLabel').hidden=l.kind!=='char';
 $('#layerChar').innerHTML='<option value="">未绑定角色</option>'+(l.characterId&&!C.characterIn(p,l.characterId)?'<option value="'+esc(l.characterId)+'">角色已删除（保留占位）</option>':'')+chars().map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>').join('');
 $('#layerChar').value=l.characterId||'';$('#layerChar').disabled=l.locked}
$('#inherit').checked=n.sceneMode==='inherit';$('#assetReuse').innerHTML='<option value="">复用已导入素材…</option>'+p.assets.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.name)+'</option>').join('');$('#presets').innerHTML='<option value="">选择场景预设…</option>'+p.presets.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join('');renderEffectUI()}
function drawSelection(){const l=layer(),box=$('#selectionBox');box.hidden=playing||effectMode!=='layout'||!l||l.hidden||l.locked;if(box.hidden)return;Object.assign(box.style,{left:l.x+'%',top:l.y+'%',width:l.w+'%',height:l.h+'%'});box.querySelector('span').textContent=l.name}
function renderCanvas(){const n=active(),ls=staged();$('#layersCanvas').replaceChildren();for(const l of ls){if(l.hidden)continue;const a=asset(l.asset);if(!a)continue;const wrap=document.createElement('div');wrap.className='visual-layer'+(l.locked?' locked':'');wrap.dataset.layer=l.id;Object.assign(wrap.style,{left:l.x+'%',top:l.y+'%',width:l.w+'%',height:l.h+'%',opacity:l.opacity/100});const im=document.createElement('img');im.src=a.data;im.alt=l.name;im.className=l.motion;im.style.objectFit=l.fit;im.draggable=false;wrap.appendChild(im);$('#layersCanvas').appendChild(wrap)}$('#placeholder').hidden=ls.some(l=>!l.hidden&&asset(l.asset));const say=n?C.speakerOf(p,n):{name:'',color:''};$('#speaker').style.color=n&&say.color?say.color:'';$('#speaker').textContent=n?(say.name||(n.type==='end'?'故事结束':'')):'';$('#line').textContent=n?.text||'添加一句对话，故事就从这里开始。';$('#choices').replaceChildren();if(n?.type==='choice')for(const o of n.options){const b=document.createElement('button');b.textContent=o.text||'未命名选项';b.onclick=e=>{e.stopPropagation();if(playing)go(o.target);else toast('从头试玩即可体验分支；目标在右侧设置。')};$('#choices').appendChild(b)}$('#nextHint').textContent=n?.type==='end'?'故事结束':n?.type==='choice'?'选项可进入普通对话，并再次汇合':playing?'点击舞台 / 空格继续 ▸':'编辑模式 · 可隐藏对话框方便拖动';$('#modeLabel').textContent=playing?'试玩中 · 使用实际经过的画面':'编辑模式 · 16:9';$('#sceneStatus').textContent=n?(n.sceneMode==='inherit'?'沿用上一画面'+(playing?'':' · 按脚本顺序预览'):'本节点独立画面'):'空白舞台';$('#selectionTitle').textContent=n?.type==='choice'?'不同的回答，也能汇回同一段故事。':'拖动图层，安排这一幕的演出。';$('#position').textContent=n?String(p.nodes.indexOf(n)+1).padStart(2,'0')+' / '+String(p.nodes.length).padStart(2,'0'):'空白舞台';$('#play').textContent=playing?'↻ 重新试玩':'▷ 从头试玩';$('#prev').disabled=playing?!trail.length:p.nodes.findIndex(n=>n.id===selected)<=0;$('#next').disabled=!n||n.type!=='say'||!C.edges(p,n).length;$('#stop').disabled=!playing;$('#slotSave').disabled=!playing;$('#slotLoad').disabled=!playing;document.body.classList.toggle('playing',playing);document.body.classList.toggle('hide-dialogue',hideDialogue);$('#toggleUI').textContent=hideDialogue?'显示对话框':'隐藏对话框';$('#toggleUI').disabled=playing;$('#flatten').disabled=playing||!ls.some(l=>!l.hidden);drawSelection();runStageEffects()}
function updateHistory(){$('#undo').disabled=playing||!past.length;$('#redo').disabled=playing||!future.length}
function render(){if(document.activeElement!==$('#title'))$('#title').value=p.title;renderList();renderFlow();inspector();renderCanvas();updateHistory();renderCastList();renderCastDetail();renderCastBind()}
function go(id){if(!p.nodes.some(n=>n.id===id))return toast('这个分支尚未设置有效目标');trail.push(current);current=id;playbackAnimate=true;renderCanvas()}
function next(){const n=active();if(n?.type!=='say')return;const id=C.edges(p,n)[0];if(!id)return;if(playing)go(id);else selectNode(id)}
function stop(){playing=false;trail=[];render()}
$('#play').onclick=()=>{if(!p.nodes.length)return toast('请先添加剧情');playing=true;playbackAnimate=true;current=p.nodes[0].id;trail=[];selectedLayer=null;render();$('#stage').focus()};$('#stop').onclick=stop;$('#next').onclick=next;$('#prev').onclick=()=>{if(playing){if(trail.length)current=trail.pop();playbackAnimate=false;renderCanvas()}else{const i=p.nodes.findIndex(n=>n.id===selected);if(i>0)selectNode(p.nodes[i-1].id)}};
$('#stage').onclick=e=>{if(playing&&e.target.tagName!=='BUTTON')next()};$('#stage').onkeydown=e=>{if(playing&&e.target.tagName!=='BUTTON'&&(e.key===' '||e.key==='Enter')){e.preventDefault();next()}};$('#toggleUI').onclick=()=>{hideDialogue=!hideDialogue;renderCanvas()};
$('#title').oninput=e=>{checkpoint('title');p.title=e.target.value;revision++;queueSave();updateHistory()};for(const [id,key]of [['name','name'],['body','text']])$('#'+id).oninput=e=>{const n=node();if(!n||playing)return;checkpoint(n.id+'-'+key);n[key]=e.target.value;revision++;queueSave();renderList();renderFlow();renderCanvas();updateHistory()};$('#type').onchange=e=>edit(()=>{const n=node();n.type=e.target.value;if(n.type==='choice'&&!n.options)n.options=[{text:'选项一',target:''},{text:'选项二',target:''}]});$('#jump').onchange=e=>edit(()=>node().next=e.target.value);$('#addOption').onclick=()=>edit(()=>node().options.push({text:'新选项',target:''}));
function add(type){edit(()=>{const n=C.makeNode(type),i=p.nodes.findIndex(n=>n.id===selected);p.nodes.splice(i+1,0,n);selected=n.id;selectedLayer=null})}$('#add').onclick=()=>add('say');$('#addChoice').onclick=()=>add('choice');$('#addEnd').onclick=()=>add('end');
$('#duplicate').onclick=()=>{if(!node())return;edit(()=>{const n=C.clone(node());n.id=C.id();const mapping=new Map();n.layers.forEach(l=>{const old=l.id;l.id=C.id();mapping.set(old,l.id)});n.effects.forEach(e=>{e.id=C.id();e.layer=mapping.get(e.layer)||e.layer});p.nodes.splice(p.nodes.findIndex(n=>n.id===selected)+1,0,n);selected=n.id;selectedLayer=null})};function moveNode(d){const i=p.nodes.findIndex(n=>n.id===selected);if(i<0||i+d<0||i+d>=p.nodes.length)return;edit(()=>[p.nodes[i],p.nodes[i+d]]=[p.nodes[i+d],p.nodes[i]])}$('#up').onclick=()=>moveNode(-1);$('#down').onclick=()=>moveNode(1);$('#remove').onclick=()=>{if(!node())return;edit(()=>{const i=p.nodes.findIndex(n=>n.id===selected);p.nodes.splice(i,1);selected=p.nodes[Math.min(i,p.nodes.length-1)]?.id;selectedLayer=null});toast('已删除剧情，可撤销。指向它的跳转会在检查中提示。')};
$('#inherit').onchange=e=>{const inherit=e.target.checked;if(inherit&&node().sceneMode==='own'&&node().layers.length&&!confirm('改为沿用上一画面？本节点的独立画面将被替换，可撤销。')){e.target.checked=false;return}edit(()=>{if(inherit){node().sceneMode='inherit';node().layers=[]}else makeOwn();selectedLayer=null})};
function defaultLayer(a){return C.defaultLayer(a)}
function addAssetLayer(a,bind){makeOwn();const l=C.appendAssetLayer(node(),a,bind);selectedLayer=l.id}
function pick(accept,callback,assetKind){if(H){const task=String(accept).includes('image')?H.pickImage(assetKind||'bg'):H.pickText();task.then(async f=>{if(!f)return;try{await callback(f)}catch(e){toast(e.message||'读取失败')}}).catch(e=>toast(e.message||'读取失败'));return}const f=$('#file');f.value='';f.accept=accept;f.onchange=async()=>{if(f.files[0])try{await callback(f.files[0])}catch(e){toast(e.message||'读取失败')}};f.click()}
function upload(kind){if(!node())return toast('请先添加剧情');const target=selected;pick('image/png,image/jpeg,image/webp',async f=>{if(f.size>12*1024*1024)throw Error('请使用小于 12MB 的图片');if(!['image/png','image/jpeg','image/webp'].includes(f.type))throw Error('仅支持 PNG、JPEG、WebP');const data=H?f.dataUrl:await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('图片读取失败'));r.readAsDataURL(f)});if(!data)throw Error('图片读取失败');const picked=C.assetForImport(p,{id:H&&f.id?f.id:C.id(),name:f.name,kind,data});const a=picked.asset;await decodeAsset(a);if(selected!==target||playing)throw Error('当前节点已变化，请重新导入图片');edit(()=>{if(!picked.reused)p.assets.push(a);const nn=node();let bind=null;if(kind==='char'&&nn&&nn.speakerId){const c=C.characterIn(p,nn.speakerId);if(c)bind={characterId:c.id,expressionId:nn.expressionId||((c.expressions||[]).find(e=>e.assetId===a.id)||{}).id||''}}addAssetLayer(a,bind)});toast('已添加图层：拖动画面调整位置，右下角缩放。'+(picked.reused?'（复用已有素材）':''))},kind)}$('#uploadBg').onclick=()=>upload('bg');$('#uploadChar').onclick=()=>upload('char');$('#reuse').onclick=()=>{const a=asset($('#assetReuse').value);if(!a)return toast('请先选择已导入素材');edit(()=>addAssetLayer(a))};
for(const [id,key]of [['layerName','name'],['lx','x'],['ly','y'],['lw','w'],['lh','h'],['opacity','opacity'],['motion','motion']]){const e=$('#'+id);e.addEventListener(id==='motion'?'change':'input',()=>{const l=layer();if(!l||l.locked||playing)return;let v=key==='name'||key==='motion'?e.value:+e.value;if(typeof v==='number'){if(e.value===''||!Number.isFinite(v))return;const min=key==='x'||key==='y'?-500:key==='opacity'?0:1,max=key==='x'||key==='y'?500:key==='opacity'?100:1000;if(v<min||v>max)return}checkpoint('layer-'+l.id+'-'+key);const own=ownLayer();if($('#ratio').checked&&(key==='w'||key==='h')){const other=key==='w'?'h':'w',newOther=own[other]*v/own[key];if(newOther<1||newOther>1000)return;own[other]=newOther}own[key]=v;revision++;queueSave();renderLayerUI();renderCanvas();updateHistory()})}
function layerEdit(fn){if(!layer()||layer().locked)return;edit(()=>fn(ownLayer()))}
function fitLayer(l,cover){const a=asset(l.asset),ratio=(a?.width||1280)/(a?.height||720);let w=100,h=100*16/9/ratio;if((cover&&h<100)||(!cover&&h>100)){h=100;w=100*ratio*9/16}Object.assign(l,{x:(100-w)/2,y:(100-h)/2,w,h,fit:'contain'})}
$('#fitContain').onclick=()=>layerEdit(l=>fitLayer(l,false));$('#fitCover').onclick=()=>layerEdit(l=>fitLayer(l,true));$('#centerLayer').onclick=()=>layerEdit(l=>{l.x=(100-l.w)/2;l.y=(100-l.h)/2});$('#resetLayer').onclick=()=>layerEdit(l=>{const fresh=defaultLayer(asset(l.asset));Object.assign(l,{x:fresh.x,y:fresh.y,w:fresh.w,h:fresh.h,fit:fresh.fit})});
function moveLayer(d){layerEdit(l=>{const ls=node().layers,i=ls.indexOf(l);if(i+d>=0&&i+d<ls.length)[ls[i],ls[i+d]]=[ls[i+d],ls[i]]})}$('#layerDown').onclick=()=>moveLayer(-1);$('#layerUp').onclick=()=>moveLayer(1);$('#copyLayer').onclick=()=>layerEdit(l=>{const c=C.clone(l);c.id=C.id();c.name+=' 副本';c.x=Math.min(500,c.x+2);c.y=Math.min(500,c.y+2);node().layers.splice(node().layers.indexOf(l)+1,0,c);selectedLayer=c.id});$('#removeLayer').onclick=()=>layerEdit(l=>{node().layers.splice(node().layers.indexOf(l),1);selectedLayer=null});
$('#stage').addEventListener('pointerdown',e=>{if(playing||e.button!==0)return;if(effectMode!=='layout'){toast('点击「返回布局」后可拖动素材');return;}const resizing=e.target.closest('.resize-handle'),el=e.target.closest('[data-layer]');if(!resizing&&!el){if(!e.target.closest('#choices')){selectedLayer=null;renderLayerUI();drawSelection()}return}if(el)selectedLayer=el.dataset.layer;const l=layer();if(!l||l.locked)return;renderLayerUI();drawSelection();e.preventDefault();const rect=$('#stage').getBoundingClientRect();drag={pointer:e.pointerId,startX:e.clientX,startY:e.clientY,rect,before:C.clone(l),resize:!!resizing,started:false};$('#stage').setPointerCapture(e.pointerId)});
$('#stage').addEventListener('pointermove',e=>{if(!drag||drag.pointer!==e.pointerId)return;const dx=(e.clientX-drag.startX)/drag.rect.width*100,dy=(e.clientY-drag.startY)/drag.rect.height*100;if(!drag.started&&Math.abs(dx)+Math.abs(dy)<.15)return;if(!drag.started){checkpoint();makeOwn();drag.started=true}const l=ownLayer(),b=drag.before,clamp=(v,a,z)=>Math.max(a,Math.min(z,v));if(drag.resize){const factor=clamp(((b.w+dx)*b.w+(b.h+dy)*b.h)/(b.w*b.w+b.h*b.h),Math.max(1/b.w,1/b.h),Math.min(1000/b.w,1000/b.h));l.w=b.w*factor;l.h=b.h*factor}else{l.x=clamp(b.x+dx,-500,500);l.y=clamp(b.y+dy,-500,500)}const visual=[...$('#layersCanvas').children].find(e=>e.dataset.layer===l.id);if(visual)Object.assign(visual.style,{left:l.x+'%',top:l.y+'%',width:l.w+'%',height:l.h+'%'});for(const [id,key]of [['lx','x'],['ly','y'],['lw','w'],['lh','h']])$('#'+id).value=Math.round(l[key]*10)/10;drawSelection();$('#selectionBox').classList.add('dragging')});
function finishDrag(e){if(!drag||e.pointerId!==drag.pointer)return;const moved=drag.started;drag=null;$('#selectionBox').classList.remove('dragging');if($('#stage').hasPointerCapture(e.pointerId))$('#stage').releasePointerCapture(e.pointerId);if(moved)saveChanged()}$('#stage').addEventListener('pointerup',finishDrag);$('#stage').addEventListener('pointercancel',finishDrag);
$('#savePreset').onclick=()=>{if(!displayed().length)return toast('请先添加图层');const name=prompt('为当前场景预设命名：','我的场景');if(!name?.trim())return;edit(()=>p.presets.push({id:C.id(),name:name.trim(),layers:C.clone(displayed())}));toast('已保存预设，可应用到其他节点')};$('#applyPreset').onclick=()=>{const preset=p.presets.find(t=>t.id===$('#presets').value);if(!preset)return toast('先选择场景预设');edit(()=>{node().sceneMode='own';node().layers=C.clone(preset.layers);node().layers.forEach(l=>l.id=C.id());selectedLayer=null})};
$('#buildBranch').onclick=()=>{const n=node();if(!n||n.type!=='choice')return;if(!n.options.length)return toast('先添加至少一个选项');modal('生成对话分支，并汇回主线','<p>每个选项会获得一段可编辑的对话，结束后跳到你选择的共同节点。现有选项目标将被替换，可撤销。</p><div class="stack"><label>共同主线<select id="mergeTarget">'+targets('',false)+'</select></label><button id="confirmBranches" class="primary">创建 '+n.options.length+' 段分支</button></div>');$('#mergeTarget').querySelector('option[value="'+n.id+'"]').remove();$('#confirmBranches').onclick=()=>{const target=$('#mergeTarget').value;if(!target||target===n.id)return toast('请选择有效的共同主线');edit(()=>{const branches=n.options.map(o=>{const b=C.makeNode();b.name='';b.text='【'+o.text+'】在这里填写这条分支的对话。';b.next=target;o.target=b.id;return b});p.nodes.splice(p.nodes.indexOf(n)+1,0,...branches)});$('#modal').close();toast('分支已建立，每段结尾均已指向共同主线')};};
$('#branchDemo').onclick=()=>{if(!confirm('用三选项汇合示例替换当前工程？可撤销，建议先保存备份。'))return;edit(()=>{p=C.sample();selected=p.nodes[0].id;selectedLayer=null})};
$('.tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('.tabs').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));for(const name of ['nodes','text','flow','cast'])$('#'+name+'-tab').hidden=b.dataset.tab!==name});$('#txtFile').onclick=()=>pick('.txt,text/plain',async f=>{if(f.size>2*1024*1024)throw Error('文本请小于 2MB');$('#importText').value=await f.text();toast('已载入 UTF-8 文本，请检查后解析')});$('#parse').onclick=()=>{const lines=$('#importText').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(!lines.length)return toast('请先输入文本');if(lines.length>5000)return toast('每次最多导入 5000 行');edit(()=>{const ns=lines.map(s=>{const n=C.makeNode(),m=s.match(/^([^：:]{1,30})[：:](.*)$/);n.name=m&&m[1]!=='旁白'?m[1]:'';n.text=m?m[2].trim():s;return n});p.nodes.push(...ns);selected=ns[0].id;selectedLayer=null});toast('已追加 '+lines.length+' 句剧情')};
async function download(data,name,type){const ext=String(name).toLowerCase(),kind=ext.endsWith('.png')?'png':ext.endsWith('.json')?'json':'html';if(H){try{let payload={kind,name};if(data instanceof Blob){const bytes=new Uint8Array(await data.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));payload.base64=btoa(s)}else payload.text=String(data);const r=await H.saveFile(payload);if(r&&!r.cancelled)toast('已保存到：'+r.path)}catch(e){toast('导出失败：'+(e.message||e))}return}const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}const filename=()=>(p.title||'我的故事').replace(/[\\/:*?"<>|]/g,'_');async function applyOpened(r){if(!r||r.cancelled)return;const out=await loadProject(r.project);edit(()=>{p=out;selected=p.nodes[0]?.id;selectedLayer=null});H.applyState(r);$('#saved').textContent='已打开 · '+(r.label||'工程');if(r.imported)toast('旧工程已导入到新目录，原文件未改动');if(r.notice)toast(r.notice)}
$('#save').onclick=()=>{if(H){H.save(p).then(r=>{if(r.cancelled)return;H.applyState(r);$('#saved').textContent='已保存';toast('工程已保存到目录，素材与备份完整')}).catch(e=>{$('#saved').textContent='保存失败';toast('保存失败：'+e.message)});return}download(JSON.stringify(p,null,2),filename()+'.paper.json','application/json');toast('已下载完整 V0.3 工程，包含全部图层与图片')};
$('#open').onclick=()=>{if(H){H.open().then(applyOpened).catch(e=>toast('打开失败：'+e.message));return}pick('.json,application/json',async f=>{if(f.size>80*1024*1024)throw Error('工程请小于 80MB');const out=await loadProject(JSON.parse(await f.text()));if(!confirm('替换当前工程？可撤销，建议先下载当前工程。'))return;edit(()=>{p=out;selected=p.nodes[0]?.id;selectedLayer=null});toast('工程已打开，旧版工程已自动兼容转换')})};
$('#new').onclick=()=>{if(H){H.newProject().then(r=>{if(r.cancelled)return;edit(()=>{p=r.project;selected=p.nodes[0]?.id??null;selectedLayer=null});H.applyState(r);$('#saved').textContent='新建工程';toast('已新建工程目录')}).catch(e=>toast('新建失败：'+e.message));return}if(!confirm('新建空白工程？可撤销，建议先下载当前工程。'))return;edit(()=>{p=C.blank();selected=null;selectedLayer=null})};
if(H){
 $('#saveAs').onclick=()=>H.saveAs(p).then(r=>{if(r.cancelled)return;H.applyState(r);$('#saved').textContent='已另存为';toast('已复制到新工程目录，旧工程未改动')}).catch(e=>toast('另存为失败：'+e.message));
 $('#exportJson').onclick=()=>H.saveFile({kind:'json',name:filename()+'.paper.json',text:JSON.stringify(p,null,2)}).then(r=>{if(r&&!r.cancelled)toast('工程 JSON 备份已保存：'+r.path)}).catch(e=>toast('备份失败：'+e.message));
 $('#recentList').onchange=e=>{if(e.target.value==='')return;H.openRecent(+e.target.value).then(applyOpened).catch(err=>toast('打开最近工程失败：'+err.message))};
 const menuButtons={new:'#new',open:'#open',save:'#save',saveAs:'#saveAs',export:'#export',exportJson:'#exportJson',check:'#check',help:'#help'};
 H.onCommand(cmd=>{if(String(cmd).startsWith('recent:')){H.openRecent(+String(cmd).slice(7)).then(applyOpened).catch(err=>toast('打开最近工程失败：'+err.message));return}const b=menuButtons[cmd];if(b&&$(b))$(b).click()});
 H.onSaveBeforeClose(async token=>{try{const r=await H.save(p);H.finishSaveBeforeClose({token,ok:!r.cancelled,message:r.cancelled?'已取消保存':''})}catch(e){H.finishSaveBeforeClose({token,ok:false,message:e.message||'保存失败'})}});
}
$('#check').onclick=()=>{const report=C.analyze(p),items=[...report.errors.map(x=>'错误：'+x),...report.warnings.map(x=>'提示：'+x)];modal(report.errors.length?'发现 '+report.errors.length+' 项错误':report.warnings.length?'没有阻塞错误，有 '+report.warnings.length+' 项提示':'剧情检查通过',items.length?'<ul>'+items.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul><p class="hint">检查引用、可达性与循环，不判断故事逻辑。循环可能是有意设计。</p>':'<p>跳转、图层引用与可达性有效。请试玩每条路径，确认演出和汇合符合预期。</p>')};
$('#slotSave').onclick=()=>{slot={revision,current,trail:[...trail]};toast('已存档（当前编辑会话）')};$('#slotLoad').onclick=()=>{if(!slot)return toast('暂无试玩存档');if(slot.revision!==revision)return toast('工程已变化，请重新试玩并存档');current=slot.current;trail=[...slot.trail];playbackAnimate=false;renderCanvas();toast('已读取试玩存档')};
$('#flatten').onclick=async()=>{if(effectMode!=='layout')return toast('请先返回布局。PNG 合成导出只包含原始布局；演出效果保留在试玩网页中。');const ls=C.clone(displayed());if(!ls.some(l=>!l.hidden))return;try{const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');for(const l of ls){if(l.hidden)continue;const a=asset(l.asset);if(!a)throw Error('图片丢失');const im=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('图片无法解码'));img.src=a.data});ctx.save();const x=l.x*12.8,y=l.y*7.2,w=l.w*12.8,h=l.h*7.2;ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();ctx.globalAlpha=l.opacity/100;if(l.fit==='fill')ctx.drawImage(im,x,y,w,h);else{const f=l.fit==='cover'?Math.max(w/im.width,h/im.height):Math.min(w/im.width,h/im.height);ctx.drawImage(im,x+(w-im.width*f)/2,y+(h-im.height*f)/2,im.width*f,im.height*f)}ctx.restore()}canvas.toBlob(blob=>{if(blob)download(blob,filename()+'-合成场景.png','image/png')},'image/png');toast('导出 1280×720 场景合成图（透明底，不含对话框）')}catch(e){toast('导出失败：'+e.message)}};
$('#export').onclick=()=>{const report=C.analyze(p);if(report.errors.length){$('#check').click();return}let html;try{html=buildGameHTML(p,{player:paperPlayer,coreFactory:createVNCore,effectFactory:createPaperEffects,css:paperPlayerCSS,esc})}catch(e){toast('导出失败：'+e.message);return}download(html,filename()+'.html','text/html');toast('已导出独立 HTML，包含图层、效果、位置与全部分支')};
$('#help').onclick=()=>modal('V0.3 · 图层与台词演出','<ol><li>在「效果与演出」选择目标图层，添加效果或使用预设。可设置起点、终点、时长、延迟、缓动和缩放中心。点击舞台上方预览、终态或拖动时间条；返回布局后可继续拖动素材。</li><li>持续效果在推进时按目标值结算；本句结束恢复的效果离开即移除；自动恢复效果在播放后回到起点。独立场景重置此前持续效果。读档和后退显示本句终态。</li><li>选中剧情节点，上传背景或角色。支持多个角色和背景素材叠加。</li><li>在舞台拖动图片；选中边框右下角可等比缩放。也可输入 X/Y、宽高，或用「填满画布」。隐藏对话框更方便编辑底部。</li><li>右侧图层从上到下就是前景到背景。可隐藏、锁定、调整层级。锁定底图后更容易选前景。</li><li>新对话默认沿用上一画面；第一次修改会生成独立副本。编辑模式按脚本顺序预览，试玩按实际走过的路径继承。</li><li>选项数量可增加，目标可以是普通对话。使用「生成局部分支并汇合」快速创建各选项的对话，并统一跳回主线。</li><li>撤销／重做支持图层、文本和剧情结构（最多 60 步）。输入框里 Ctrl+Z 使用原生文本撤销；页面按钮撤销工程修改。</li><li>场景可存为预设，也可导出不含对话框的合成 PNG。保存工程包含原始图层，导出试玩生成独立离线 HTML。</li></ol><p class="hint">支持打开 V0.1 / V0.2 工程。旧工程保留原来的两结局结构，不会强制替换。暂无 AI 动作、配音、音乐或 EXE 打包。浏览器数据清理会删除草稿，请下载备份。</p>');
function effectNode(){return node()?.effects?.find(e=>e.id===effectId)}
function effectTargets(){return displayed()}
function renderEffectUI(){const n=node();if(!n)return;const ls=effectTargets(),prev=$('#effectTarget').value;$('#effectTarget').innerHTML='<option value="">选择当前画面的图层…</option>'+ls.map(l=>'<option value="'+esc(l.id)+'">'+esc(l.name)+'（'+(l.kind==='bg'?'背景':'角色')+'）</option>').join('');$('#effectTarget').value=ls.some(l=>l.id===selectedLayer)?selectedLayer:prev;$('#effectCount').textContent=n.effects.length;$('#effectList').innerHTML=n.effects.map(e=>{const l=ls.find(l=>l.id===e.layer);return '<div class="effect-row '+(e.id===effectId?'active':'')+'"><button data-effect="'+esc(e.id)+'"><b>'+esc(F.types[e.type].name)+'</b> · '+esc(l?.name||'图层不在当前预览中')+'<small>'+e.delay+'s 延迟 / '+e.duration+'s · '+({hold:'持续',sentence:'本句结束恢复',auto:'自动恢复'}[e.policy])+'</small></button><button data-enable-effect="'+esc(e.id)+'" aria-label="'+(e.enabled?'停用':'启用')+'效果">'+(e.enabled?'停用':'启用')+'</button></div>'}).join('');$('#effectList').querySelectorAll('[data-effect]').forEach(b=>b.onclick=()=>{effectId=b.dataset.effect;renderEffectUI()});$('#effectList').querySelectorAll('[data-enable-effect]').forEach(b=>b.onclick=()=>edit(()=>{const e=node().effects.find(e=>e.id===b.dataset.enableEffect);e.enabled=!e.enabled}));let e=effectNode();$('#effectProps').hidden=!e;if(!e)return;$('#effectName').textContent=F.types[e.type].name+' · '+F.types[e.type].unit;$('#effectTarget').value=e.layer;$('#effectAutoFrom').checked=e.from===null;$('#effectMoveY').hidden=e.type!=='move';$('#effectPivot').hidden=!['scale','rotate'].includes(e.type);$('#effectReturnLabel').hidden=e.policy!=='auto';const base=F.before(p,C,n.id)[e.layer]||F.neutral(),key=e.type==='move'?'x':e.type;const values={effectFrom:e.from??base[key],effectTo:e.to,effectFromY:e.fromY??base.y,effectToY:e.toY,effectOriginX:e.originX,effectOriginY:e.originY,effectDuration:e.duration,effectDelay:e.delay,effectReturn:e.returnDuration,effectPolicy:e.policy,effectEasing:e.easing};for(const [id,v]of Object.entries(values))if(document.activeElement!==$('#'+id))$('#'+id).value=v;for(const id of ['effectFrom','effectTo']){const meta=F.types[e.type];$('#'+id).min=meta.min;$('#'+id).max=meta.max;$('#'+id).step='0.1'}$('#effectFrom').disabled=e.from===null;$('#effectFromY').disabled=e.fromY===null;}
function runStageEffects(){effectCancel();const n=active(),ls=displayed(),total=F.duration(n);$('#cueTime').max=Math.max(total,.01);$('#cueDuration').textContent=total.toFixed(2)+'s';$('#previewCue').disabled=playing||!n;$('#effectEnd').disabled=playing||!n;$('#layoutOnly').disabled=playing;if(!n)return;const path=playing?trail:undefined;function clock(t){$('#cueTime').value=t;$('#cueDuration').textContent=t.toFixed(2)+' / '+total.toFixed(2)+'s'}if(playing||effectMode!=='layout'){document.body.classList.add('effect-preview');drawSelection();if((playing&&playbackAnimate)||(!playing&&effectMode==='animate')){effectCancel=F.animate(p,C,n.id,path,$('#layersCanvas'),ls,(t)=>clock(t));$('#cueStatus').textContent=playing?'试玩演出 · 进入本句时播放':'正在预览本句 · 可拖动时间条'}else{const time=effectMode==='scrub'&&!playing?+$('#cueTime').value:Infinity;F.apply($('#layersCanvas'),ls,F.frame(p,C,n.id,path,time));clock(Number.isFinite(time)?time:total);$('#cueStatus').textContent='效果终态 · 返回布局后可拖动'}playbackAnimate=false}else{document.body.classList.remove('effect-preview');$('#cueStatus').textContent='布局模式 · 原始位置与尺寸（效果不烘焙进布局）';$('#cueTime').value=0;F.apply($('#layersCanvas'),ls,{});clock(0)}}
$('#effectType').innerHTML=Object.entries(F.types).map(([v,t])=>'<option value="'+v+'">'+t.name+'</option>').join('');
function putEffect(lid,type,props={}){const list=node().effects;let e=list.find(e=>e.layer===lid&&e.type===type);if(!e){e=F.make(C.id(),lid,type);list.push(e)}Object.assign(e,props);e.enabled=true;effectId=e.id;return e}
$('#addEffect').onclick=()=>{const lid=$('#effectTarget').value,type=$('#effectType').value;if(!displayed().some(l=>l.id===lid))return toast('请先选择目标图层');edit(()=>putEffect(lid,type));toast('效果已添加：可在下方调整并预览')};
$('#deleteEffect').onclick=()=>{const e=effectNode();if(e)edit(()=>{node().effects=node().effects.filter(x=>x.id!==e.id);effectId=null})};
$('#effectAutoFrom').onchange=()=>{const e=effectNode();if(!e)return;const checked=$('#effectAutoFrom').checked;edit(()=>{const s=F.before(p,C,node().id)[e.layer]||F.neutral();e.from=checked?null:s[e.type==='move'?'x':e.type];e.fromY=checked?null:s.y})};
for(const [id,key]of [['effectFrom','from'],['effectTo','to'],['effectFromY','fromY'],['effectToY','toY'],['effectOriginX','originX'],['effectOriginY','originY'],['effectDuration','duration'],['effectDelay','delay'],['effectReturn','returnDuration'],['effectPolicy','policy'],['effectEasing','easing']]){const input=$('#'+id);input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{const e=effectNode();if(!e||playing)return;const val=input.tagName==='SELECT'?input.value:+input.value;if(input.tagName!=='SELECT'&&(input.value===''||!Number.isFinite(val)||val<+input.min||val>+input.max))return;checkpoint('effect-'+e.id+'-'+key);e[key]=val;revision++;queueSave();renderEffectUI();renderCanvas();updateHistory()})}
$('#previewCue').onclick=()=>{effectMode='animate';renderCanvas()};$('#effectEnd').onclick=()=>{effectMode='end';renderCanvas()};$('#layoutOnly').onclick=()=>{effectMode='layout';renderCanvas()};$('#cueTime').oninput=()=>{if(playing)return;effectCancel();effectMode='scrub';const t=+$('#cueTime').value;F.apply($('#layersCanvas'),displayed(),F.frame(p,C,selected,undefined,t));$('#cueStatus').textContent='时间预览 · 返回布局后可拖动';$('#cueDuration').textContent=t.toFixed(2)+' / '+F.duration(node()).toFixed(2)+'s';document.body.classList.add('effect-preview');drawSelection()};
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{const kind=b.dataset.preset,ls=displayed(),target=ls.find(l=>l.id===$('#effectTarget').value)||layer();if(kind==='closeup'){const char=target?.kind==='char'?target:ls.find(l=>l.kind==='char'),backgrounds=ls.filter(l=>l.kind==='bg');if(!char)return toast('请先导入角色图层');edit(()=>{putEffect(char.id,'scale',{from:null,to:120,originX:50,originY:25,policy:'sentence',duration:.4});for(const bg of backgrounds)putEffect(bg.id,'blur',{from:null,to:8,policy:'sentence',duration:.4})});toast('已添加角色特写'+(backgrounds.length?'与背景虚化':'；添加背景后可单独设置模糊'));return}if(!target)return toast('先选择要应用预设的图层');edit(()=>{if(kind==='fadeIn')putEffect(target.id,'opacity',{from:0,to:100,policy:'hold'});else if(kind==='fadeOut')putEffect(target.id,'opacity',{from:null,to:0,policy:'hold'});else if(kind==='memory'){putEffect(target.id,'saturation',{from:null,to:15,policy:'sentence'});putEffect(target.id,'brightness',{from:null,to:110,policy:'sentence'})}else if(kind==='reset'){for(const type of Object.keys(F.types))putEffect(target.id,type,{from:null,fromY:null,to:type==='move'?0:F.neutral()[type],toY:0,policy:'hold'})}});toast('预设已添加，可继续调整参数')});

/* ================= 角色与表情（V0.4.1） ================= */
/* 角色 = 稳定 ID + 名字 + 姓名颜色 + 表情列表。表情只是「名字 → 素材 ID」，
   图层与台词都通过 ID 引用，所以改名不会断开任何一句已录入的台词。 */
function chars(){return p.characters||[]}
function castChar(){return chars().find(c=>c.id===castSel)||null}
function assetById(id){return p.assets.find(a=>a.id===id)}
function exprNameOf(c,id){const e=c&&(c.expressions||[]).find(x=>x.id===id);return e?e.name:'未设表情'}
function layerMeta(l,shown){if(l.kind==='bg')return '背景';const c=l.characterId?C.characterIn(p,l.characterId):null;if(!c)return '角色';const e=(c.expressions||[]).find(x=>x.id===((shown||l).expressionId||l.expressionId));return '角色 · '+c.name+(e?' · '+e.name:'')}
function renderCastList(){
 const box=$('#castList'),list=chars();
 box.innerHTML=list.length?list.map(c=>{
  const def=(c.expressions||[]).find(e=>e.id===c.defaultExpressionId);
  return '<button class="cast-row '+(c.id===castSel?'active':'')+'" data-char="'+esc(c.id)+'">'
   +'<span class="cast-dot" style="background:'+esc(/^#[0-9a-fA-F]{6}$/.test(c.color||'')?c.color:'#829087')+'"></span>'
   +'<span class="cast-info"><b>'+esc(c.name)+'</b><small>'+(c.expressions||[]).length+' 个表情 · 默认 '+esc(def?def.name:'未设置')+'</small></span></button>';
 }).join(''):'<p class="hint empty">还没有角色。新建「林悠」「林澈」这样的角色，再为每人添加表情。</p>';
 box.querySelectorAll('[data-char]').forEach(b=>b.onclick=()=>{castSel=b.dataset.char;renderCastList();renderCastDetail()});
}
function renderCastDetail(){
 const c=castChar();
 $('#castDetail').hidden=!c;
 if(!c)return;
 if(document.activeElement!==$('#charName'))$('#charName').value=c.name;
 if(document.activeElement!==$('#charColor'))$('#charColor').value=/^#[0-9a-fA-F]{6}$/.test(c.color||'')?c.color:'#3f6753';
 if(document.activeElement!==$('#charColorText'))$('#charColorText').value=c.color||'';
 $('#charDefault').innerHTML='<option value="">（未设置）</option>'+(c.expressions||[]).map(e=>'<option value="'+esc(e.id)+'">'+esc(e.name)+'</option>').join('');
 $('#charDefault').value=c.defaultExpressionId||'';
 $('#exprList').innerHTML=(c.expressions||[]).map(e=>{
  const a=assetById(e.assetId);
  return '<div class="expr-row'+(e.id===c.defaultExpressionId?' active':'')+'">'
   +'<img alt="" src="'+(a?a.data:'')+'">'
   +'<div class="expr-meta"><b>'+esc(e.name)+'</b><small>'+(e.id===c.defaultExpressionId?'默认表情':'表情')+(a?'':' · 图片缺失')+'</small></div>'
   +'<div class="expr-actions"><button data-def="'+esc(e.id)+'">设为默认</button><button data-rename-expr="'+esc(e.id)+'">改名</button><button class="danger" data-del-expr="'+esc(e.id)+'">删除</button></div></div>';
 }).join('')||'<p class="hint empty">还没有表情。添加一张透明立绘作为这个角色的表情。</p>';
 const use=C.characterUsage(p,c.id);
 $('#charUsage').textContent='引用：'+use.lines.length+' 句台词，'+use.layers.length+' 个图层。';
 $('#exprList').querySelectorAll('[data-def]').forEach(b=>b.onclick=()=>{edit(()=>{const cc=castChar();if(cc)cc.defaultExpressionId=b.dataset.def});toast('默认表情已更新')});
 $('#exprList').querySelectorAll('[data-rename-expr]').forEach(b=>b.onclick=()=>{
  const cc=castChar(),e=cc&&cc.expressions.find(x=>x.id===b.dataset.renameExpr);
  if(!e)return;
  modal('给表情改名','<p>改名只影响显示名称，已录入的台词仍然指向这个表情。</p><label>表情名称<input id="exprNewName" value="'+esc(e.name)+'"></label><div class="stack"><button id="confirmExprName" class="primary">保存名称</button></div>');
  $('#confirmExprName').onclick=()=>{
   const v=$('#exprNewName').value.trim();
   if(!v)return toast('表情名称不能为空');
   edit(()=>{const t=castChar();const x=t&&t.expressions.find(y=>y.id===e.id);if(x)x.name=v});
   $('#modal').close();toast('表情已改名，引用不变');
  };
 });
 $('#exprList').querySelectorAll('[data-del-expr]').forEach(b=>b.onclick=()=>deleteExpression(castChar(),b.dataset.delExpr));
}
function renderCastBind(){
 const n=node(),list=chars(),sel=$('#speakerChar');
 sel.innerHTML='<option value="">自由填写 / 旁白</option>'+list.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>').join('')
  +(n&&n.speakerId&&!list.some(c=>c.id===n.speakerId)?'<option value="'+esc(n.speakerId)+'">角色已删除（保留占位）</option>':'');
 sel.value=n?(n.speakerId||''):'';
 const c=n&&n.speakerId?C.characterIn(p,n.speakerId):null;
 const eff=n&&n.speakerId?C.castAlong(p,n.id,playing?trail:undefined)[n.speakerId]:'';
 const es=$('#speakerExpr');
 es.innerHTML='<option value="">沿用画面上的表情</option>'
  +(c&&n&&n.expressionId&&!c.expressions.some(e=>e.id===n.expressionId)?'<option value="'+esc(n.expressionId)+'">表情已删除（保留占位）</option>':'')
  +(c?c.expressions.map(e=>'<option value="'+esc(e.id)+'">'+esc(e.name)+'</option>').join(''):'');
 es.value=n?(n.expressionId||''):'';
 es.disabled=!c;
 $('#name').disabled=!!c;
 $('#name').title=c?'本句由角色「'+c.name+'」说话；要自由填写请把说话角色设为「自由填写 / 旁白」':'';
 let status;
 if(!n)status='选择一个剧情节点后可绑定角色。';
 else if(!n.speakerId)status='当前：自由文本说话人 / 旁白。';
 else if(!c)status='绑定的角色已删除，本句退回自由文本；请重新选择角色，或保留占位后修正。';
 else{
  const effE=(c.expressions||[]).find(e=>e.id===eff);
  status='当前：<b style="color:'+esc(c.color||'inherit')+'">'+esc(c.name)+'</b>'+(effE?' · '+esc(effE.name)+(n.expressionId?'':'（沿用上一句）'):' · 沿用画面表情');
 }
 const rows=$('#castRows'),onStage=[],seen=new Set();
 for(const l of staged()){if(l.kind!=='char'||!l.characterId||seen.has(l.characterId))continue;const cc=C.characterIn(p,l.characterId);if(cc){seen.add(l.characterId);onStage.push(cc)}}
 const others=onStage.filter(x=>!(n&&x.id===n.speakerId));
 rows.innerHTML=others.map(x=>{
  const cur=(n&&(n.cast||[]).find(y=>y.characterId===x.id)||{}).expressionId||'';
  return '<label>'+esc(x.name)+'（同场）<select data-cast="'+esc(x.id)+'"><option value="">沿用上一句</option>'+x.expressions.map(e=>'<option value="'+esc(e.id)+'"'+(e.id===cur?' selected':'')+'>'+esc(e.name)+'</option>').join('')+'</select></label>';
 }).join('');
 rows.querySelectorAll('[data-cast]').forEach(sel=>sel.onchange=()=>{
  const cid=sel.dataset.cast,v=sel.value;
  edit(()=>{const nn=node();if(!nn)return;nn.cast=(nn.cast||[]).filter(x=>x.characterId!==cid);if(v)nn.cast.push({characterId:cid,expressionId:v})});
 });
 $("#castStatus").innerHTML=status;
}
$('#speakerChar').onchange=e=>{
 const v=e.target.value;
 edit(()=>{const n=node();if(!n)return;n.speakerId=v;
  if(!v){n.expressionId='';return}
  const c=C.characterIn(p,v);if(!c)return;
  n.name=c.name;
  if(n.expressionId&&!c.expressions.some(x=>x.id===n.expressionId))n.expressionId='';
 });
};
$('#speakerExpr').onchange=e=>{
 const v=e.target.value;
 edit(()=>{const n=node();if(!n)return;const c=C.characterIn(p,n.speakerId);if(!c)return;n.expressionId=v;if(v)n.name=c.name});
};
$('#name').oninput=e=>{
 const n=node();if(!n||playing||n.speakerId)return;
 checkpoint(n.id+'-name');n.name=e.target.value;revision++;queueSave();renderList();renderFlow();renderCanvas();updateHistory();
};
$('#openCast').onclick=()=>{
 const tab=document.querySelector('.tabs [data-tab="cast"]');
 if(tab)tab.click();
 const n=node();
 if(n&&n.speakerId&&chars().some(c=>c.id===n.speakerId)){castSel=n.speakerId;renderCastList();renderCastDetail()}
};
$('#addChar').onclick=()=>{
 edit(()=>{const c={id:'ch_'+C.id(),name:'角色 '+(chars().length+1),color:'#3f6753',defaultExpressionId:'',expressions:[]};p.characters.push(c);castSel=c.id});
 toast('已新建角色：填写名字与姓名颜色，再添加表情');
};
$('#charName').oninput=e=>{
 const c=castChar();if(!c)return;
 checkpoint('char-name-'+c.id);c.name=e.target.value;revision++;queueSave();renderCanvas();renderCastList();renderCastBind();updateHistory();
};
$('#charName').onblur=()=>{
 const c=castChar();if(!c||c.name.trim())return;
 edit(()=>{const t=castChar();if(t)t.name='未命名角色'});
};
function setCharColor(value,key){
 if(!/^#[0-9a-fA-F]{6}$/.test(String(value)))return;
 edit(()=>{const c=castChar();if(c)c.color=value},key);
}
$('#charColor').oninput=e=>setCharColor(e.target.value,'char-color');
$('#charColorText').onchange=e=>{setCharColor(e.target.value,'char-color');if(!/^#[0-9a-fA-F]{6}$/.test(e.target.value))toast('颜色请使用 #RRGGBB，例如 #3f6753')};
$('#charDefault').onchange=e=>edit(()=>{const c=castChar();if(c)c.defaultExpressionId=e.target.value});
function readImageFile(f){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('图片读取失败'));r.readAsDataURL(f)})}
$('#addExpr').onclick=()=>{
 const c=castChar();if(!c)return toast('请先选择角色');
 const target=c.id;
 pick('image/png,image/jpeg,image/webp',async f=>{
  if(f.size>12*1024*1024)throw Error('请使用小于 12MB 的图片');
  if(!['image/png','image/jpeg','image/webp'].includes(f.type))throw Error('仅支持 PNG、JPEG、WebP');
  const data=H?f.dataUrl:await readImageFile(f);
  if(!data)throw Error('图片读取失败');
  const picked=C.assetForImport(p,{id:H&&f.id?f.id:C.id(),name:f.name,kind:'char',data});
  const a=picked.asset;
  await decodeAsset(a);
  edit(()=>{
   const cc=p.characters.find(x=>x.id===target);
   if(!cc)throw Error('角色已变化，请重新选择后再添加表情');
   if(!picked.reused)p.assets.push(a);
   const base=String(f.name||'表情').replace(/\.[^.]+$/,'').slice(0,20)||'表情';
   const e={id:'ex_'+C.id(),name:cc.expressions.some(x=>x.name===base)?base+' 2':base,assetId:a.id};
   cc.expressions.push(e);
   if(!cc.defaultExpressionId)cc.defaultExpressionId=e.id;
   castSel=cc.id;
  });
  toast('已添加表情：素材与角色身份分开保存'+(picked.reused?'（复用已有图片）':''));
 },'char');
};
function deleteExpression(c,exprId){
 if(!c)return;
 const e=(c.expressions||[]).find(x=>x.id===exprId);
 if(!e)return;
 const use=C.expressionUsage(p,c.id,exprId);
 const others=(c.expressions||[]).filter(x=>x.id!==exprId);
 if(!use.lines.length&&!use.layers.length&&!use.isDefault){
  if(!confirm('删除表情「'+e.name+'」？图片素材仍保留在工程里，可撤销。'))return;
  edit(()=>{const t=castChar();if(t){t.expressions=t.expressions.filter(x=>x.id!==exprId);if(t.defaultExpressionId===exprId)t.defaultExpressionId=(t.expressions[0]||{}).id||''}});
  toast('已删除表情，可撤销');
  return;
 }
 modal('删除表情「'+esc(e.name)+'」','<p>该表情被 <b>'+use.lines.length+'</b> 句台词、<b>'+use.layers.length+'</b> 个图层引用'+(use.isDefault?'，并且是默认表情':'')+'。引用不会被静默丢弃，请选择处理方式。</p>'
  +'<label>引用的台词与图层<select id="exprReplace">'+others.map(x=>'<option value="'+esc(x.id)+'">替换为「'+esc(x.name)+'」</option>').join('')+'<option value="__keep">保留占位（之后检查会提示表情丢失）</option></select></label>'
  +'<div class="stack"><button id="confirmExprDelete" class="danger">删除表情</button></div>');
 $('#confirmExprDelete').onclick=()=>{
  const v=$('#exprReplace')?$('#exprReplace').value:'__keep';
  edit(()=>{
   const cc=p.characters.find(x=>x.id===c.id);
   if(!cc)return;
   const map=v==='__keep'?'':v;
   for(const n of p.nodes)if(n.speakerId===c.id&&n.expressionId===exprId&&map)n.expressionId=map;
   for(const n of p.nodes)for(const l of n.layers||[])if(l.characterId===c.id&&l.expressionId===exprId&&map)l.expressionId=map;
   if(cc.defaultExpressionId===exprId)cc.defaultExpressionId=map||(others[0]||{}).id||'';
   cc.expressions=cc.expressions.filter(x=>x.id!==exprId);
  });
  $('#modal').close();
  toast(v==='__keep'?'已删除表情，引用保留为占位':'已删除表情，引用已替换');
 };
}
$('#deleteChar').onclick=()=>{
 const c=castChar();if(!c)return;
 const use=C.characterUsage(p,c.id);
 const others=chars().filter(x=>x.id!==c.id);
 modal('删除角色「'+esc(c.name)+'」','<p>该角色被 <b>'+use.lines.length+'</b> 句台词、<b>'+use.layers.length+'</b> 个图层引用。删除后不会静默丢失这些引用。</p>'
  +'<label>引用处理<select id="charAction">'
  +(others.length?others.map(x=>'<option value="'+esc(x.id)+'">替换为「'+esc(x.name)+'」（同名表情自动对应）</option>').join(''):'')
  +'<option value="__keep">保留占位（之后检查会提示角色丢失）</option>'
  +'<option value="__clear">解除绑定，保留原说话人文字</option></select></label>'
  +'<div class="stack"><button id="confirmCharDelete" class="danger">删除角色</button></div>');
 $('#confirmCharDelete').onclick=()=>{
  const v=$('#charAction')?$('#charAction').value:'__keep';
  edit(()=>{
   const target=v.startsWith('ch_')?C.characterIn(p,v):null;
   const mapExpr=(exprId)=>{const name=(c.expressions.find(x=>x.id===exprId)||{}).name;const t=target&&(target.expressions||[]).find(x=>x.name===name);return t?t.id:''};
   for(const n of p.nodes){
    if(n.speakerId===c.id){
     if(target){n.speakerId=target.id;n.name=target.name;n.expressionId=mapExpr(n.expressionId)}
     else if(v==='__clear'){n.speakerId='';n.expressionId='';if(!n.name)n.name=c.name}
    }
    for(const l of n.layers||[])if(l.characterId===c.id){
     if(target){l.characterId=target.id;l.expressionId=mapExpr(l.expressionId)}
     else if(v==='__clear'){l.characterId='';l.expressionId=''}
    }
   }
   p.characters=p.characters.filter(x=>x.id!==c.id);
   castSel=null;
  });
  $('#modal').close();
  toast(v==='__keep'?'已删除角色，引用保留为占位':'角色已删除，引用已按选择处理');
 };
};
$('#layerChar').onchange=e=>{
 const v=e.target.value;
 layerEdit(l=>{l.characterId=v;const c=v?C.characterIn(p,v):null;
  l.expressionId=c?((c.expressions||[]).find(x=>x.assetId===l.asset)||{}).id||'':''});
};

render();initialize();
