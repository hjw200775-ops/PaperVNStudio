'use strict';
const C=createVNCore(),F=createPaperEffects(),A=createPaperAudio(),$=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const H=window.PaperHost||null; /* desktop adapter; null keeps the original web behaviour */
let p=C.sample(),selected=p.nodes[0].id,selectedLayer=null,playing=false,current=selected,trail=[],db,saveTimer,toastTimer,hideDialogue=false,drag=null;
let effectId=null,effectMode='layout',effectCancel=()=>{},playbackAnimate=true;
let past=[],future=[],group='',groupTime=0,revision=0,slot=null,castSel=null;
const node=()=>p.nodes.find(n=>n.id===selected),active=()=>p.nodes.find(n=>n.id===(playing?current:selected));
const displayed=()=>C.scene(p,playing?current:selected,playing?trail:undefined);
/* 舞台渲染用 C.stage：几何来自图层，素材按本句表情替换，不改写原图层。 */
const staged=()=>C.stage(p,playing?current:selected,playing?trail:undefined);
const layer=()=>displayed().find(l=>l.id===selectedLayer),asset=id=>p.assets.find(a=>a.id===id);
function snapshot(){return {...p,nodes:C.clone(p.nodes),assets:[...p.assets],audioAssets:C.clone(p.audioAssets||[]),presets:C.clone(p.presets),characters:C.clone(p.characters||[]),chapters:C.clone(p.chapters||[]),selected,selectedLayer}}
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
async function initialize(){if(H){const started=revision;try{const s=await H.bootstrap();H.applyState(s);if(s.notice)toast(s.notice);if(s.project){const restored=await loadProject(s.project);if(revision!==started)return;p=restored;selected=p.nodes[0]?.id;selectedLayer=null;audioStopAll();render();$('#saved').textContent=s.currentDir?'已打开工程':'已恢复草稿 · 请另存为'}else $('#saved').textContent='准备就绪 · 保存工程以创建目录'}catch(e){toast('启动恢复失败：'+e.message);$('#saved').textContent='请手动保存工程'}return}try{const req=indexedDB.open('paper-vn-studio',1);req.onupgradeneeded=()=>req.result.createObjectStore('projects');req.onsuccess=()=>{db=req.result;const started=revision,r=db.transaction('projects').objectStore('projects').get('draft');r.onsuccess=async()=>{if(!r.result)return;try{const restored=await loadProject(r.result);if(revision!==started)return;p=restored;selected=p.nodes[0]?.id;selectedLayer=null;audioStopAll();render();$('#saved').textContent='已恢复本地工程'+(r.result.schema<3?' · 已兼容升级':'')}catch(e){toast('本地工程未覆盖：'+e.message)}}};req.onerror=()=>$('#saved').textContent='请下载工程备份'}catch{$('#saved').textContent='请下载工程备份'}}
function indexLabel(id){const i=p.nodes.findIndex(n=>n.id===id);if(i<0)return '目标已删除';const n=p.nodes[i];return String(i+1).padStart(2,'0')+' · '+(n.type==='end'?'结局':n.type==='choice'?'选择':n.name||'旁白')+' / '+(n.text||'空文本').slice(0,16)}
function targets(value='',auto=true){let out='<option value="">'+(auto?'按顺序继续':'请选择对话 / 主线 / 结局')+'</option>';if(value&&!p.nodes.some(n=>n.id===value))out+='<option selected value="'+esc(value)+'">目标已删除，请重新设置</option>';return out+p.nodes.map(n=>'<option value="'+esc(n.id)+'" '+(n.id===value?'selected':'')+'>'+esc(indexLabel(n.id))+'</option>').join('')}
/* ---------- 章节 / 段落树 ---------- */
let treeDrag=null;
function treeNodeRow(id){
 const idx=p.nodes.findIndex(n=>n.id===id);const n=p.nodes[idx];if(!n)return '';
 const kind={say:'对话',choice:'分支',end:'结局'}[n.type];
 const picked=batch.on&&batch.ids.has(id);
 return '<button class="node '+(n.id===selected?'active':'')+(batch.on?' batch':'')+(picked?' picked':'')+'" data-id="'+esc(n.id)+'" draggable="'+(!batch.on)+'" title="'+esc((n.name||'旁白')+'：'+(n.text||'尚未填写文本'))+'">'
  +(batch.on?'<span class="pick'+(picked?' on':'')+'" data-pick="'+esc(id)+'" role="checkbox" aria-checked="'+picked+'"></span>':'')
  +'<span class="num">'+String(idx+1).padStart(2,'0')+'</span>'
  +'<span class="node-main"><b>'+esc(n.name||'旁白')+'</b><em>'+kind+'</em>'
  +'<span class="node-text">'+esc(n.text||'尚未填写文本')+'</span></span></button>';
}
function paragraphBlock(g){
 const count=g.nodes.length;
 return '<div class="paragraph" data-paragraph="'+esc(g.id)+'">'
  +'<div class="paragraph-head" data-paragraph-head="'+esc(g.id)+'" draggable="true">'
  +'<button class="caret" data-toggle-paragraph="'+esc(g.id)+'" aria-label="'+(g.collapsed?'展开':'折叠')+'段落">'+(g.collapsed?'▸':'▾')+'</button>'
  +'<span class="paragraph-title" title="'+esc(g.title)+'">'+esc(g.title)+'</span>'
  +'<span class="count-pill">'+count+'</span>'
  +(batch.on?'<span class="pick-badge'+(g.nodes.filter(id=>batch.ids.has(id)).length?' on':'')+'">已选 '+g.nodes.filter(id=>batch.ids.has(id)).length+'</span>':'')
  +'<span class="mini-actions">'
  +(batch.on?'<button data-pick-paragraph="'+esc(g.id)+'" title="选中/取消本段全部句子">全选</button>':'')
  +'<button data-rename-paragraph="'+esc(g.id)+'" title="重命名段落">改名</button>'
  +'<button data-move-paragraph="'+esc(g.id)+'" title="移动到其他章节">移动</button>'
  +'<button data-del-paragraph="'+esc(g.id)+'" class="danger" title="删除段落（保留剧情）">删</button>'
  +'</span></div>'
  +(g.collapsed?'':'<div class="paragraph-body" data-drop-paragraph="'+esc(g.id)+'">'
   +((batch.on&&count)?'<p class="hint pick-hint">本段已选 '+g.nodes.filter(id=>batch.ids.has(id)).length+' / '+count+' 句</p>':'')
   +(count?g.nodes.map(treeNodeRow).join(''):'<p class="empty-hint">这个段落还没有台词。把句子拖进来，或用「移动到…」。</p>')
   +'</div>')
  +'</div>';
}
function renderList(){
 const t=C.tree(p);
 batchPrune();
 $('#count').textContent=p.nodes.length+' 句 · '+t.chapters.length+' 章';
 $('#batchBar').hidden=!batch.on;
 $('#batchToggle').classList.toggle('primary',batch.on);
 $('#batchToggle').textContent=batch.on?'退出批量':'批量编辑';
 if(batch.on){$('#batchCount').textContent=batchInfoText();$('#batchPasteScene').disabled=!batch.scene;$('#batchPasteFx').disabled=!batch.effects}
 let html=t.chapters.map(c=>{
  const total=c.paragraphs.reduce((s,g)=>s+g.nodes.length,0);
  return '<div class="chapter" data-chapter="'+esc(c.id)+'">'
   +'<div class="chapter-head'+(c.collapsed?' collapsed':'')+'" data-chapter-head="'+esc(c.id)+'" draggable="true">'
   +'<button class="caret" data-toggle-chapter="'+esc(c.id)+'" aria-label="'+(c.collapsed?'展开':'折叠')+'章节">'+(c.collapsed?'▸':'▾')+'</button>'
   +'<span class="chapter-title" title="'+esc(c.title)+'">'+esc(c.title)+'</span>'
   +'<span class="count-pill">'+total+'</span>'
   +'<span class="mini-actions">'
   +'<button data-add-paragraph="'+esc(c.id)+'" title="在这个章节里新建段落">＋段</button>'
   +'<button data-rename-chapter="'+esc(c.id)+'" title="重命名章节">改名</button>'
   +'<button data-up-chapter="'+esc(c.id)+'" title="章节上移">↑</button>'
   +'<button data-down-chapter="'+esc(c.id)+'" title="章节下移">↓</button>'
   +'<button data-del-chapter="'+esc(c.id)+'" class="danger" title="删除章节（保留剧情）">删</button>'
   +'</span></div>'
   +(c.collapsed?'':'<div class="chapter-body" data-drop-chapter="'+esc(c.id)+'">'
    +(c.paragraphs.length?c.paragraphs.map(paragraphBlock).join(''):'<p class="empty-hint">这个章节还没有段落，点「＋段」新建。</p>')
    +'</div>')
   +'</div>';
 }).join('');
 if(t.ungrouped.length){
  html+='<div class="chapter ungrouped"><div class="chapter-head"><span class="chapter-title">未分组</span>'
   +'<span class="count-pill">'+t.ungrouped.length+'</span></div>'
   +'<div class="chapter-body" data-drop-paragraph="">'
   +'<p class="hint ungrouped-note">此处仅集中显示，实际播放位置保持原样。</p>'
   +t.ungrouped.map(treeNodeRow).join('')+'</div></div>';
 }
 $('#list').innerHTML=html||'<p class="empty-hint">还没有剧情。点下面的「＋ 对话」开始，或到「文本导入」预览粘贴的稿子。</p>';
}
function locateNode(id){
 const target=p.nodes.find(n=>n.id===id);if(!target)return;
 const entry=C.paragraphMap(p).get(target.paragraphId);
 if(entry){entry.chapter.collapsed=false;entry.paragraph.collapsed=false}
 selectNode(id);
 const row=$('#list').querySelector('.node[data-id="'+String(id).replace(/"/g,'')+'"]');
 if(row&&row.scrollIntoView)row.scrollIntoView({block:'nearest'});
 const body=$('#body');if(body&&body.focus)body.focus();
}
function askName(title,value,onOk){
 modal(title,'<label>名称<input id="nameInput" value="'+esc(value||'')+'" maxlength="40"></label><div class="stack"><button id="confirmName" class="primary">保存</button></div>');
 $('#nameInput').focus();$('#nameInput').select();
 $('#confirmName').onclick=()=>{
  const v=$('#nameInput').value.trim();
  if(!v)return toast('名称不能为空');
  $('#modal').close();onOk(v);
 };
}
/* 移动会改变「按顺序继续」时先解释清楚，再决定是否继续。 */
function runMove(diffs,apply){
 if(!diffs||!diffs.length){edit(apply);return}
 modal('这次移动会改变「按顺序继续」的去向',
  '<p>显式跳转和选项不受影响；下面这些句子会顺着新顺序继续：</p><ul class="issue-list">'
  +diffs.map(d=>'<li>'+esc(indexLabel(d.nodeId))+'：原来到 '+esc(d.before?indexLabel(d.before):'（没有下一句）')+'，移动后到 '+esc(d.after?indexLabel(d.after):'（没有下一句）')+'</li>').join('')
  +'</ul><p class="hint">想保持原样可以取消，再换个位置。</p><div class="stack"><button id="applyMove" class="primary">继续移动</button></div>');
 $('#applyMove').onclick=()=>{$('#modal').close();edit(apply)};
}
function moveNodeTo(nodeId,paragraphId,beforeNodeId){
 const impact=C.moveImpact(p,nodeId,paragraphId,beforeNodeId);
 runMove(impact.diffs,()=>{
  C.moveNodeToParagraph(p,nodeId,paragraphId,beforeNodeId);
  selected=nodeId;
  const g=C.paragraphMap(p).get(paragraphId);
  if(g)g.paragraph.collapsed=false;
 });
}
function moveParagraphTo(paragraphId,chapterId,beforeParagraphId){
 const sim=C.clone(p);
 const res=C.moveParagraph(sim,paragraphId,chapterId,beforeParagraphId);
 if(!res)return;
 runMove(res.diffs,()=>{
  C.moveParagraph(p,paragraphId,chapterId,beforeParagraphId);
  const c=p.chapters.find(x=>x.id===chapterId);if(c)c.collapsed=false;
 });
}
function moveChapterTo(chapterId,beforeChapterId){
 const res=C.moveChapter(C.clone(p),chapterId,beforeChapterId);
 if(!res)return;
 runMove(res.diffs,()=>{C.moveChapter(p,chapterId,beforeChapterId)});
}
function openMoveDialog(kind,id){
 if(kind==='node'){
  const t=C.tree(p);
  const rows=t.chapters.map(c=>'<optgroup label="'+esc(c.title)+'">'
   +c.paragraphs.map(g=>'<option value="'+esc(g.id)+'">'+esc(c.title)+' / '+esc(g.title)+'</option>').join('')+'</optgroup>').join('');
  modal('把这句话移动到…','<label>目标段落<select id="moveTarget">'+rows+'</select></label>'
   +'<p class="hint">换段落会同时改变它在播放顺序里的位置；影响「按顺序继续」时会先提示。</p>'
   +'<div class="stack"><button id="confirmMove" class="primary">移动</button></div>');
  const cur=p.nodes.find(n=>n.id===id);if(cur&&cur.paragraphId&&$('#moveTarget').querySelector('option[value="'+cur.paragraphId+'"]'))$('#moveTarget').value=cur.paragraphId;
  $('#confirmMove').onclick=()=>{const pid=$('#moveTarget').value;$('#modal').close();moveNodeTo(id,pid,null)};
  return;
 }
 modal('把这段移动到…','<label>目标章节<select id="moveTarget">'+p.chapters.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.title)+'</option>').join('')+'</select></label>'
  +'<p class="hint">整段移动，段内句子顺序不变；如果因此改变「按顺序继续」，会先提示。</p>'
  +'<div class="stack"><button id="confirmMove" class="primary">移动</button></div>');
 const g=C.paragraphMap(p).get(id);if(g)$('#moveTarget').value=g.chapter.id;
 $('#confirmMove').onclick=()=>{const cid=$('#moveTarget').value;$('#modal').close();moveParagraphTo(id,cid,null)};
}
function removeParagraphConfirm(id){
 const g=C.paragraphMap(p).get(id);if(!g)return;
 const count=p.nodes.filter(n=>n.paragraphId===id).length;
 modal('删除段落「'+g.paragraph.title+'」','<p>段落里的 <b>'+count+'</b> 句剧情会保留，放到「未分组」，播放顺序不变。可以撤销。</p>'
  +'<div class="stack"><button id="confirmRemoveParagraph" class="danger">删除段落</button></div>');
 $('#confirmRemoveParagraph').onclick=()=>{$('#modal').close();edit(()=>{C.removeParagraph(p,id)});toast('段落已删除，剧情保留在「未分组」')};
}
function removeChapterConfirm(id){
 const c=p.chapters.find(x=>x.id===id);if(!c)return;
 const pids=new Set((c.paragraphs||[]).map(g=>g.id));
 const count=p.nodes.filter(n=>pids.has(n.paragraphId)).length;
 modal('删除章节「'+c.title+'」','<p>章节和它的 <b>'+(c.paragraphs||[]).length+'</b> 个段落会被移除；<b>'+count+'</b> 句剧情保留到「未分组」，播放顺序不变。可以撤销。</p>'
  +'<div class="stack"><button id="confirmRemoveChapter" class="danger">删除章节</button></div>');
 $('#confirmRemoveChapter').onclick=()=>{$('#modal').close();edit(()=>{C.removeChapter(p,id)});toast('章节已删除，剧情保留在「未分组」')};
}
$('#list').addEventListener('click',e=>{
 const hit=e.target.closest('[data-pick],[data-pick-paragraph],[data-id],[data-toggle-chapter],[data-toggle-paragraph],[data-add-paragraph],[data-rename-chapter],[data-rename-paragraph],[data-move-paragraph],[data-del-chapter],[data-del-paragraph],[data-up-chapter],[data-down-chapter]');
 if(!hit)return;
 const d=hit.dataset;
 if(d.pick){if(e.shiftKey)batchRangeTo(d.pick);else batchToggle(d.pick);return}
 if(d.pickParagraph){batchPickParagraph(d.pickParagraph);return}
 if(d.id){
  if(batch.on){
   if(e.shiftKey){selectNode(d.id);batchRangeTo(d.id)}
   else{selectNode(d.id);batchToggle(d.id)}
  }else selectNode(d.id);
  return;
 }
 if(d.toggleChapter){const c=p.chapters.find(x=>x.id===d.toggleChapter);if(c){c.collapsed=!c.collapsed;revision++;queueSave();render()}return}
 if(d.toggleParagraph){const g=C.paragraphMap(p).get(d.toggleParagraph);if(g){g.paragraph.collapsed=!g.paragraph.collapsed;revision++;queueSave();render()}return}
 if(d.addParagraph){
  let g;edit(()=>{g=C.addParagraph(p,d.addParagraph,'新段落');const c=p.chapters.find(x=>x.id===d.addParagraph);if(c)c.collapsed=false});
  askName('重命名段落',g.title,v=>edit(()=>{const t=C.paragraphMap(p).get(g.id);if(t)t.paragraph.title=v}));
  return;
 }
 if(d.renameChapter){const c=p.chapters.find(x=>x.id===d.renameChapter);if(!c)return;askName('重命名章节',c.title,v=>edit(()=>{const t=p.chapters.find(x=>x.id===c.id);if(t)t.title=v}));return}
 if(d.renameParagraph){const g=C.paragraphMap(p).get(d.renameParagraph);if(!g)return;askName('重命名段落',g.paragraph.title,v=>edit(()=>{const t=C.paragraphMap(p).get(g.paragraph.id);if(t)t.paragraph.title=v}));return}
 if(d.moveParagraph){openMoveDialog('paragraph',d.moveParagraph);return}
 if(d.delParagraph){removeParagraphConfirm(d.delParagraph);return}
 if(d.delChapter){removeChapterConfirm(d.delChapter);return}
 if(d.upChapter||d.downChapter){
  const id=d.upChapter||d.downChapter,i=p.chapters.findIndex(c=>c.id===id),j=i+(d.upChapter?-1:1);
  if(i<0||j<0||j>=p.chapters.length)return;
  moveChapterTo(id,p.chapters[j].id);
 }
});
/* 拖动：句子可在段落间移动，段落可在章节间移动，章节可调整先后。 */
function clearDropMarks(){for(const x of $('#list').querySelectorAll('.drop-before,.drop-after,.drop-into'))x.classList.remove('drop-before','drop-after','drop-into')}
$('#list').addEventListener('dragstart',e=>{
 const head=e.target.closest('[data-chapter-head]'),para=e.target.closest('[data-paragraph-head]'),row=e.target.closest('.node');
 if(batch.on){e.preventDefault();return}
 treeDrag=head?{kind:'chapter',id:head.dataset.chapterHead}:para?{kind:'paragraph',id:para.dataset.paragraphHead}:row?{kind:'node',id:row.dataset.id}:null;
 if(!treeDrag){e.preventDefault();return}
 if(e.dataTransfer){e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',treeDrag.kind+':'+treeDrag.id)}catch{}}
 document.body.classList.add('tree-dragging');
});
$('#list').addEventListener('dragend',()=>{treeDrag=null;clearDropMarks();document.body.classList.remove('tree-dragging')});
$('#list').addEventListener('dragover',e=>{
 if(!treeDrag)return;
 const t=dropTarget(e);if(!t)return;
 e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';
 clearDropMarks();t.el.classList.add(t.where==='before'?'drop-before':t.where==='after'?'drop-after':'drop-into');
});
$('#list').addEventListener('dragleave',e=>{if(!$('#list').contains(e.relatedTarget))clearDropMarks()});
$('#list').addEventListener('drop',e=>{
 if(!treeDrag)return;
 const t=dropTarget(e);if(!t)return;
 e.preventDefault();clearDropMarks();
 const drag=treeDrag;treeDrag=null;document.body.classList.remove('tree-dragging');
 if(drag.kind==='node'){
  if(t.paragraphId===undefined)return;
  const before=(t.where==='before'||t.where==='after')?t.anchorId:null;
  if(before===drag.id)return;
  moveNodeTo(drag.id,t.paragraphId,before);
  return;
 }
 if(drag.kind==='paragraph'){
  if(!t.chapterId)return;
  const before=(t.where==='before'||t.where==='after')?t.anchorId:null;
  if(before===drag.id)return;
  moveParagraphTo(drag.id,t.chapterId,before);
  return;
 }
 if(!t.chapterId||t.anchorId===drag.id)return;
 moveChapterTo(drag.id,(t.where==='before'||t.where==='after')?t.anchorId:null);
});
/* 把鼠标位置翻译成「放进某个段落 / 插到某段或某章前后」。 */
function dropTarget(e){
 const d=treeDrag;if(!d)return null;
 const el=e.target.closest('.node,[data-paragraph-head],[data-drop-paragraph],[data-chapter-head],[data-drop-chapter]');
 if(!el)return null;
 const r=el.getBoundingClientRect(),half=(e.clientY-r.top)<r.height/2?'before':'after';
 if(d.kind==='node'){
  if(el.classList.contains('node')){
   const body=el.closest('[data-drop-paragraph]');
   const paragraphId=body?body.dataset.dropParagraph:'';
   if(half==='before')return {el,where:'before',paragraphId,anchorId:el.dataset.id};
   const next=el.nextElementSibling&&el.nextElementSibling.classList.contains('node')?el.nextElementSibling:null;
   return {el,where:next?'before':'after',paragraphId,anchorId:next?next.dataset.id:null};
  }
  if(el.dataset.paragraphHead)return {el,where:'into',paragraphId:el.dataset.paragraphHead,anchorId:null};
  if(el.dataset.dropParagraph!==undefined)return {el,where:'into',paragraphId:el.dataset.dropParagraph,anchorId:null};
  if(el.dataset.dropChapter!==undefined){
   const bodies=[...el.querySelectorAll('[data-drop-paragraph]')];
   const last=bodies[bodies.length-1];
   if(!last)return null;
   return {el:last,where:'into',paragraphId:last.dataset.dropParagraph,anchorId:null};
  }
  return null;
 }
 if(d.kind==='paragraph'){
  const chapterOf=node=>{const c=node.closest('[data-chapter]');return c?c.dataset.chapter:''};
  if(el.dataset.paragraphHead)return {el,where:half,chapterId:chapterOf(el),anchorId:el.dataset.paragraphHead};
  if(el.dataset.dropParagraph!==undefined)return {el,where:'into',chapterId:chapterOf(el),anchorId:null};
  if(el.dataset.dropChapter!==undefined)return {el,where:'into',chapterId:el.dataset.dropChapter,anchorId:null};
  if(el.dataset.chapterHead)return {el,where:'into',chapterId:el.dataset.chapterHead,anchorId:null};
  return null;
 }
 const chapterOf=node=>{const c=node.closest('[data-chapter]');return c?c.dataset.chapter:''};
 if(el.dataset.chapterHead)return {el,where:half,chapterId:el.dataset.chapterHead,anchorId:el.dataset.chapterHead};
 if(el.dataset.dropChapter!==undefined)return {el,where:'after',chapterId:el.dataset.dropChapter,anchorId:null};
 const fallback=chapterOf(el);
 return fallback?{el,where:'after',chapterId:fallback,anchorId:null}:null;
}
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
function render(){if(document.activeElement!==$('#title'))$('#title').value=p.title;renderList();renderFlow();inspector();renderCanvas();updateHistory();renderCastList();renderCastDetail();renderCastBind();renderAudioUI()}
function go(id){if(!p.nodes.some(n=>n.id===id))return toast('这个分支尚未设置有效目标');trail.push(current);current=id;playbackAnimate=true;renderCanvas();if(playing)enterAudioInto(id,'enter')}
function next(){const n=active();if(n?.type!=='say')return;const id=C.edges(p,n)[0];if(!id)return;if(playing)go(id);else selectNode(id)}
function stop(){playing=false;trail=[];$('#entryNotice').hidden=true;audioStopAll();render()}
function describeNode(id){const n=p.nodes.find(x=>x.id===id);if(!n)return '这句';const i=p.nodes.indexOf(n);const g=C.paragraphMap(p).get(n.paragraphId);return (g?g.paragraph.title+' · ':'')+'第 '+(i+1)+' 句'}
/* 前置状态沿用现有 scene/effects/cast 解析：把「到本句为止的脚本顺序」当作路径。
   前面出现分支或跳转时明确告诉作者这是近似还原，而不是假装走了真实路径。 */
function routeLabel(o){
 const names=(o.trail||[]).filter(id=>id!==o.anchorId).slice(-3).map(id=>indexLabel(id));
 return '从「'+describeNode(o.anchorId)+'」出发'+(names.length?'，经过 '+names.join(' → '):'，直接进入本句');
}
function startPlayAt(nodeId,pathIds,note){
 /* 参数不能命名成 trail：会遮住同名全局变量，导致试玩路径被丢掉。 */
 playing=true;current=nodeId;trail=[...pathIds];selectedLayer=null;effectId=null;effectMode='layout';playbackAnimate=true;
 audioStopAll();
 render();
 enterAudioInto(nodeId,'rebuild');          /* 定点试玩：按选定路线结算 BGM，从曲首启动 */
 const notice=$('#entryNotice');
 notice.hidden=false;notice.textContent=note;
 if($('#stage').focus)$('#stage').focus();
}
/* 前置状态只按「进入点 → 本句」的实际路线还原；路线不唯一时让作者选，不拼合分支状态。 */
function playFrom(nodeId){
 if(!nodeId)return toast('请先选中一句剧情');
 const actual=(playing&&current===nodeId&&trail.length)?trail:null;
 const plan=C.entryPlan(p,nodeId,actual);
 if(!plan)return toast('找不到这句剧情');
 const head='从「'+describeNode(nodeId)+'」开始：';
 if(plan.ambiguous){
  if(!plan.options.length){
   toast(plan.reason||'无法确定这句之前的状态');
   return;
  }
   modal('这句前面有多条路线',
   '<p>「'+esc(describeNode(nodeId))+'」之前有分支，不同路线可能播放过不同的背景音乐，也会带来不同的表情与持续演出。请选择一条路线，或从更早的音乐入口 / 独立场景第一句重新开始。</p>'
   +'<ul class="issue-list">'+plan.options.map((o,i)=>'<li><button data-route="'+i+'" class="issue"><em>路线 '+(i+1)+'</em>'+esc(routeLabel(o))+'</button></li>').join('')+'</ul>'
   +'<p class="hint">所选路线只影响这次试玩，不会改动剧情。</p>');
  $('#modalBody').querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>{
   const i=+b.dataset.route,o=plan.options[i];
   $('#modal').close();
   startPlayAt(nodeId,o.trail,head+'按所选路线还原（'+routeLabel(o).replace(/^从/,'从')+'）。');
   toast('已按所选路线开始试玩');
  });
  return;
 }
 const notes={
  actual:head+'沿用刚才实际走过的路径还原背景、表情与持续演出。',
  scene:head+'这一句是独立场景，舞台与演出从这一句开始。',
  graph:head+'前面只有一条路线，背景、表情与持续演出按这条路线还原。'
 };
 startPlayAt(nodeId,plan.trail,notes[plan.source]||notes.graph);
 toast(plan.source==='actual'?'已按实际路径从这句开始试玩':'已从这句开始试玩');
}
$('#playHere').onclick=()=>playFrom(node()?.id);
$('#playPara').onclick=()=>{
 const n=node();if(!n)return toast('请先选中一句剧情');
 const t=C.tree(p);
 for(const c of t.chapters)for(const g of c.paragraphs)if(g.nodes.includes(n.id)){
  if(!g.nodes.length)return toast('这个段落还没有剧情');
  return playFrom(g.nodes[0]);
 }
 toast('这句还不在任何段落里，先用「移动到…」放进段落');
};
$('#play').onclick=()=>{if(!p.nodes.length)return toast('请先添加剧情');playing=true;playbackAnimate=true;current=p.nodes[0].id;trail=[];selectedLayer=null;audioStopAll();render();enterAudioInto(current,'rebuild');$('#stage').focus()};$('#stop').onclick=stop;$('#next').onclick=next;$('#prev').onclick=()=>{if(playing){if(trail.length)current=trail.pop();playbackAnimate=false;renderCanvas();enterAudioInto(current,'rebuild')}else{const i=p.nodes.findIndex(n=>n.id===selected);if(i>0)selectNode(p.nodes[i-1].id)}};
$('#stage').onclick=e=>{if(playing&&e.target.tagName!=='BUTTON')next()};$('#stage').onkeydown=e=>{if(playing&&e.target.tagName!=='BUTTON'&&(e.key===' '||e.key==='Enter')){e.preventDefault();next()}};$('#toggleUI').onclick=()=>{hideDialogue=!hideDialogue;renderCanvas()};
$('#title').oninput=e=>{checkpoint('title');p.title=e.target.value;revision++;queueSave();updateHistory()};for(const [id,key]of [['name','name'],['body','text']])$('#'+id).oninput=e=>{const n=node();if(!n||playing)return;checkpoint(n.id+'-'+key);n[key]=e.target.value;revision++;queueSave();renderList();renderFlow();renderCanvas();updateHistory()};$('#type').onchange=e=>edit(()=>{const n=node();n.type=e.target.value;if(n.type==='choice'&&!n.options)n.options=[{text:'选项一',target:''},{text:'选项二',target:''}]});$('#jump').onchange=e=>edit(()=>node().next=e.target.value);$('#addOption').onclick=()=>edit(()=>node().options.push({text:'新选项',target:''}));
function add(type){edit(()=>{const cur=node();const pid=cur&&cur.paragraphId?cur.paragraphId:(p.chapters[0]&&p.chapters[0].paragraphs[0]?p.chapters[0].paragraphs[0].id:'');const n=C.makeNode(type);n.paragraphId=pid;const i=p.nodes.findIndex(x=>x.id===selected);p.nodes.splice(i+1,0,n);selected=n.id;selectedLayer=null})}$('#add').onclick=()=>add('say');$('#addChoice').onclick=()=>add('choice');$('#addEnd').onclick=()=>add('end');
$('#duplicate').onclick=()=>{if(!node())return;edit(()=>{const n=C.clone(node());n.id=C.id();const mapping=new Map();n.layers.forEach(l=>{const old=l.id;l.id=C.id();mapping.set(old,l.id)});n.effects.forEach(e=>{e.id=C.id();e.layer=mapping.get(e.layer)||e.layer});p.nodes.splice(p.nodes.findIndex(n=>n.id===selected)+1,0,n);selected=n.id;selectedLayer=null})};function moveNode(d){
 const n=node();if(!n)return;
 const siblings=p.nodes.filter(x=>x.paragraphId===n.paragraphId);
 const i=siblings.indexOf(n),j=i+d;
 if(i<0||j<0||j>=siblings.length)return toast(d<0?'已经是这段的第一句':'已经是这段的最后一句');
 const before=d<0?siblings[j].id:(siblings[j+1]?siblings[j+1].id:null);
 moveNodeTo(n.id,n.paragraphId,before);
}$('#up').onclick=()=>moveNode(-1);$('#down').onclick=()=>moveNode(1);$('#remove').onclick=()=>{
 if(!node())return;
 const id=selected,idx=p.nodes.findIndex(n=>n.id===id);
 const refs=p.nodes.filter(n=>n.id!==id&&(n.next===id||(n.options||[]).some(o=>o.target===id)));
 const inside=p.nodes.filter(n=>n.id!==id&&(n.next===id||(n.options||[]).some(o=>o.target===id)));
 modal('删除这句剧情？','<p>第 '+(idx+1)+' 句：'+esc((node().name||'旁白')+'：'+(node().text||'（空）').slice(0,40))+'</p>'
  +'<p>有 <b>'+inside.length+'</b> 处跳转指向它'+(inside.length?'（'+inside.slice(0,4).map(n=>'第 '+(p.nodes.indexOf(n)+1)+' 句').join('、')+(inside.length>4?' 等':'')+'）':'')+'。删除后这些跳转会失效，剧情检查会提示。可以撤销。</p>'
  +'<div class="stack"><button id="confirmRemoveNode" class="danger">删除这句</button></div>');
 $('#confirmRemoveNode').onclick=()=>{$('#modal').close();edit(()=>{p.nodes.splice(idx,1);selected=p.nodes[Math.min(idx,p.nodes.length-1)]?.id;selectedLayer=null});toast('已删除 1 句剧情，可撤销')};
};
$('#inherit').onchange=e=>{const inherit=e.target.checked;if(inherit&&node().sceneMode==='own'&&node().layers.length&&!confirm('改为沿用上一画面？本节点的独立画面将被替换，可撤销。')){e.target.checked=false;return}edit(()=>{if(inherit){node().sceneMode='inherit';node().layers=[]}else makeOwn();selectedLayer=null})};
function defaultLayer(a){return C.defaultLayer(a)}
function addAssetLayer(a,bind){makeOwn();const l=C.appendAssetLayer(node(),a,bind);selectedLayer=l.id}
function pick(accept,callback,assetKind){if(H){const task=accept==='audio'?H.pickAudio():String(accept).includes('image')?H.pickImage(assetKind||'bg'):H.pickText();task.then(async f=>{if(!f)return;try{await callback(f)}catch(e){toast(e.message||'读取失败')}}).catch(e=>toast(e.message||'读取失败'));return}const f=$('#file');f.value='';f.accept=accept==='audio'?'audio/*,.wav,.wave,.mp3,.ogg,.oga,.m4a,.aac,.flac,.webm':accept;f.onchange=async()=>{if(f.files[0])try{await callback(f.files[0])}catch(e){toast(e.message||'读取失败')}};f.click()}
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
$('.tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('.tabs').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));for(const name of ['nodes','text','flow','cast','audio'])$('#'+name+'-tab').hidden=b.dataset.tab!==name});$('#txtFile').onclick=()=>pick('.txt,text/plain',async f=>{if(f.size>2*1024*1024)throw Error('文本请小于 2MB');$('#importText').value=await f.text();toast('已载入 UTF-8 文本，请检查后解析')});function defaultParagraphId(){const n=node();if(n&&n.paragraphId)return n.paragraphId;const c=p.chapters[0];return c&&c.paragraphs[0]?c.paragraphs[0].id:''}
function previewImport(){
 const text=$('#importText').value;
 if(!text.trim())return toast('请先输入文本');
 if(text.length>2*1024*1024)return toast('文本请小于 2MB');
 const plan=C.parseScript(text,p.characters||[]);
 if(!plan.stats.nodes)return toast('没有识别到可导入的台词');
 const cur=defaultParagraphId(),entry=C.paragraphMap(p).get(cur);
 const curLabel=entry?entry.chapter.title+' / '+entry.paragraph.title:'（还没有段落）';
 const treeHtml=plan.chapters.map(c=>'<li><b>'+esc(c.title)+'</b><ul>'+c.paragraphs.map(g=>'<li>'+esc(g.title)+'（'+g.nodes.length+' 句）</li>').join('')+'</ul></li>').join('');
 const unrec=plan.unrecognized.length
  ?'<p class="hint">'+plan.unrecognized.length+' 行无法识别，会被跳过：</p><ul class="issue-list">'
   +plan.unrecognized.slice(0,8).map(u=>'<li>第 '+u.lineNo+' 行：'+esc(String(u.text).slice(0,40))+'（'+esc(u.reason)+'）</li>').join('')
   +(plan.unrecognized.length>8?'<li>…还有 '+(plan.unrecognized.length-8)+' 行</li>':'')+'</ul>':'';
 const notes=[...new Set(plan.chapters.flatMap(c=>c.paragraphs.flatMap(g=>g.nodes.map(n=>n.note))).filter(Boolean))];
 const noteHtml=notes.length?'<p class="hint">'+notes.map(esc).join('；')+'</p>':'';
 const canCurrent=!!entry;
 modal('导入预览',
  '<p>识别到 <b>'+plan.stats.chapters+'</b> 章 / <b>'+plan.stats.paragraphs+'</b> 段 / <b>'+plan.stats.nodes+'</b> 句：'
  +'已绑定角色 '+plan.stats.bound+' 句，保留自由文本说话人 '+plan.stats.free+' 句，旁白 '+plan.stats.narration+' 句。</p>'
  +'<div class="import-target"><label class="check-label"><input type="radio" name="impTarget" value="chapters" checked>按文本里的章节标题新建章节和段落</label>'
  +(canCurrent?'<label class="check-label"><input type="radio" name="impTarget" value="paragraph">全部导入当前段落「'+esc(curLabel)+'」</label>':'<p class="hint">当前没有可用段落，只能按标题新建。</p>')
  +'</div>'
  +'<div class="import-tree"><p class="hint">将要新建的结构：</p><ul>'+treeHtml+'</ul></div>'
  +unrec+noteHtml
  +'<p class="hint">确认后会一次写入，可以整体撤销；取消不会改动工程。</p>'
  +'<div class="stack"><button id="confirmImport" class="primary">确认导入 '+plan.stats.nodes+' 句</button></div>');
 $('#confirmImport').onclick=()=>{
  const picked=$('input[name="impTarget"]:checked');
  const mode=picked?picked.value:'chapters';
  let created;
  edit(()=>{
   created=C.applyScriptPlan(p,plan,mode==='paragraph'?{mode:'paragraph',paragraphId:cur}:{mode:'chapters'});
  });
  $('#modal').close();
  if(created.nodes.length){selected=created.nodes[0];selectedLayer=null;locateNode(selected)}
  toast('已导入 '+created.nodes.length+' 句，可一次撤销');
 };
}
$('#parse').onclick=()=>previewImport();
async function download(data,name,type){const ext=String(name).toLowerCase(),kind=ext.endsWith('.png')?'png':ext.endsWith('.json')?'json':'html';if(H){try{let payload={kind,name};if(data instanceof Blob){const bytes=new Uint8Array(await data.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));payload.base64=btoa(s)}else payload.text=String(data);const r=await H.saveFile(payload);if(r&&!r.cancelled)toast('已保存到：'+r.path)}catch(e){toast('导出失败：'+(e.message||e))}return}const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}const filename=()=>(p.title||'我的故事').replace(/[\\/:*?"<>|]/g,'_');async function applyOpened(r){if(!r||r.cancelled)return;const out=await loadProject(r.project);batch={on:false,ids:new Set(),anchor:null,scene:null,effects:null};audioStopAll();edit(()=>{p=out;selected=p.nodes[0]?.id;selectedLayer=null});H.applyState(r);$('#saved').textContent='已打开 · '+(r.label||'工程');if(r.imported)toast('旧工程已导入到新目录，原文件未改动');if(r.notice)toast(r.notice)}
$('#save').onclick=()=>{if(H){H.save(p).then(r=>{if(r.cancelled)return;H.applyState(r);$('#saved').textContent='已保存';toast('工程已保存到目录，素材与备份完整')}).catch(e=>{$('#saved').textContent='保存失败';toast('保存失败：'+e.message)});return}download(JSON.stringify(p,null,2),filename()+'.paper.json','application/json');toast('已下载完整 V0.3 工程，包含全部图层与图片')};
$('#open').onclick=()=>{if(H){H.open().then(applyOpened).catch(e=>toast('打开失败：'+e.message));return}pick('.json,application/json',async f=>{if(f.size>80*1024*1024)throw Error('工程请小于 80MB');const out=await loadProject(JSON.parse(await f.text()));if(!confirm('替换当前工程？可撤销，建议先下载当前工程。'))return;audioStopAll();edit(()=>{p=out;selected=p.nodes[0]?.id;selectedLayer=null});toast('工程已打开，旧版工程已自动兼容转换')})};
$('#new').onclick=()=>{if(H){H.newProject().then(r=>{if(r.cancelled)return;audioStopAll();edit(()=>{p=r.project;selected=p.nodes[0]?.id??null;selectedLayer=null});H.applyState(r);$('#saved').textContent='新建工程';toast('已新建工程目录')}).catch(e=>toast('新建失败：'+e.message));return}if(!confirm('新建空白工程？可撤销，建议先下载当前工程。'))return;edit(()=>{p=C.blank();selected=null;selectedLayer=null})};
if(H){
 $('#saveAs').onclick=()=>H.saveAs(p).then(r=>{if(r.cancelled)return;H.applyState(r);$('#saved').textContent='已另存为';toast('已复制到新工程目录，旧工程未改动')}).catch(e=>toast('另存为失败：'+e.message));
 $('#exportJson').onclick=()=>H.saveFile({kind:'json',name:filename()+'.paper.json',text:JSON.stringify(p,null,2)}).then(r=>{if(r&&!r.cancelled)toast('工程 JSON 备份已保存：'+r.path)}).catch(e=>toast('备份失败：'+e.message));
 $('#recentList').onchange=e=>{if(e.target.value==='')return;H.openRecent(+e.target.value).then(applyOpened).catch(err=>toast('打开最近工程失败：'+err.message))};
 const menuButtons={new:'#new',open:'#open',save:'#save',saveAs:'#saveAs',export:'#export',exportJson:'#exportJson',check:'#check',help:'#help'};
 H.onCommand(cmd=>{if(String(cmd).startsWith('recent:')){H.openRecent(+String(cmd).slice(7)).then(applyOpened).catch(err=>toast('打开最近工程失败：'+err.message));return}const b=menuButtons[cmd];if(b&&$(b))$(b).click()});
 H.onSaveBeforeClose(async token=>{try{const r=await H.save(p);H.finishSaveBeforeClose({token,ok:!r.cancelled,message:r.cancelled?'已取消保存':''})}catch(e){H.finishSaveBeforeClose({token,ok:false,message:e.message||'保存失败'})}});
}
$('#check').onclick=()=>{
 const report=C.analyze(p),items=report.issues;
 const blocking=items.filter(x=>x.level==='error').length,notes=items.length-blocking;
 if(!items.length)return modal('剧情检查通过','<p>跳转、图层、角色与段落引用都有效。请逐条试玩，确认演出和汇合符合预期。</p><p class="hint">检查不判断故事逻辑；有意的循环不会报错。</p>');
 const list='<ul class="issue-list">'+items.map((it,i)=>'<li><button data-issue="'+i+'" class="issue '+(it.level==='error'?'error':'note')+'"><em>'+(it.level==='error'?'错误':'提示')+'</em>'+esc(it.text)+(it.nodeId?'<span class="jump">定位 →</span>':'')+'</button></li>').join('')+'</ul>';
 modal(blocking?'发现 '+blocking+' 项错误，导出前需要处理':(notes?'没有阻塞错误，有 '+notes+' 项提示':'剧情检查通过'),
  list+'<p class="hint">点一条结果可以跳到对应的句子；错误会阻止导出，提示只是提醒。</p>');
 $('#modalBody').querySelectorAll('[data-issue]').forEach(b=>b.onclick=()=>{
  const it=items[+b.dataset.issue];if(!it)return;
  if(it.nodeId){$('#modal').close();locateNode(it.nodeId);toast('已定位到这句')}
  else toast('这条问题不对应具体句子，请按文字说明处理');
 });
};
$('#slotSave').onclick=()=>{slot={revision,current,trail:[...trail]};toast('已存档（当前编辑会话）')};$('#slotLoad').onclick=()=>{if(!slot)return toast('暂无试玩存档');if(slot.revision!==revision)return toast('工程已变化，请重新试玩并存档');current=slot.current;trail=[...slot.trail];playbackAnimate=false;renderCanvas();enterAudioInto(current,'rebuild');toast('已读取试玩存档')};
$('#flatten').onclick=async()=>{if(effectMode!=='layout')return toast('请先返回布局。PNG 合成导出只包含原始布局；演出效果保留在试玩网页中。');const ls=C.clone(displayed());if(!ls.some(l=>!l.hidden))return;try{const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');for(const l of ls){if(l.hidden)continue;const a=asset(l.asset);if(!a)throw Error('图片丢失');const im=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('图片无法解码'));img.src=a.data});ctx.save();const x=l.x*12.8,y=l.y*7.2,w=l.w*12.8,h=l.h*7.2;ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();ctx.globalAlpha=l.opacity/100;if(l.fit==='fill')ctx.drawImage(im,x,y,w,h);else{const f=l.fit==='cover'?Math.max(w/im.width,h/im.height):Math.min(w/im.width,h/im.height);ctx.drawImage(im,x+(w-im.width*f)/2,y+(h-im.height*f)/2,im.width*f,im.height*f)}ctx.restore()}canvas.toBlob(blob=>{if(blob)download(blob,filename()+'-合成场景.png','image/png')},'image/png');toast('导出 1280×720 场景合成图（透明底，不含对话框）')}catch(e){toast('导出失败：'+e.message)}};
$('#export').onclick=()=>{
 const report=C.analyze(p);if(report.errors.length){$('#check').click();return}
 const doExport=()=>{
  let html;
  try{html=buildGameHTML(p,{player:paperPlayer,coreFactory:createVNCore,effectFactory:createPaperEffects,audioFactory:createPaperAudio,css:paperPlayerCSS,esc})}
  catch(e){toast('导出失败：'+e.message);return}
  download(html,filename()+'.html','text/html');
  toast('已导出独立 HTML，含图层、演出、分支'+(p.audioAssets?.length?'与内嵌音频':''));
 };
 const size=audioExportSize(p);
 if(!size.count){doExport();return}
 modal('导出含音频的离线 HTML',
  '<p>本工程包含 <b>'+size.count+'</b> 个音频素材，内嵌后约增加 <b>'+esc(size.label)+'</b>（原始 '+esc(A.pure.formatBytes(size.bytes))+'）。</p>'
  +'<p class="hint">音频会以 data: 内嵌，断网后也能播放；文件较大时生成会稍慢，请耐心等待，不要反复点击。</p>'
  +'<div class="stack"><button id="confirmAudioExport" class="primary">继续导出自包含 HTML</button></div>');
 $('#confirmAudioExport').onclick=()=>{$('#modal').close();doExport()};
};
$('#help').onclick=()=>modal('V0.5 · 基础音频、批量编辑与章节','<ol><li>左栏「音频」导入背景音乐 / 音效 / 语音：选好分类再导入，同一文件重复导入会复用素材，也能同时用于不同用途。列表显示名称、分类、时长、大小与引用处数；「试听」再点一次停止。被句子引用的素材不能直接删除，会先列出引用位置。</li><li>右侧「音频」分区给每句配音：音乐三种状态要分清——「沿用音乐」不重启正在播的曲子，「播放 / 切换音乐」一律从曲首开始（同一首也是），「停止音乐」淡出后停止。独立画面不会自动停止音乐。音效可加多条并设触发延迟，台词语音每句最多一条、手动选择，不按角色自动配音。</li><li>总音量、音乐 / 音效 / 语音音量与静音属于本机播放偏好，不写进工程；每句里的音量属于工程内容。浏览器第一次播放需要点「启用声音」，播放失败会在音频状态栏用中文说明原因。</li><li>左栏「批量编辑」可一次勾选多句（Shift 连选、点段落「全选」），折叠的段落不会丢掉已选，段落标题上会显示已选数量。勾选不会误触拖动排序。</li><li>「角色 / 表情…」只改勾选的字段：说话角色、本句说话表情、指定在场角色的表情。没勾的字段保持原样，预览里会先列出前后变化、跳过与冲突的句子。</li><li>「复制场景 / 粘贴场景」只替换画面布局，台词、跳转与演出都不动；「复制演出 / 粘贴演出」可以选择替换或追加，追加遇到同图层同类型会先告诉你冲突。</li><li>每次批量写入只产生一条撤销记录，撤销一次退回整批，重做一次恢复整批。取消预览不会改动工程。</li><li>左栏是章节树：章节 → 段落 → 句子。拖动句子可以换段落，拖动段落可以换章节；也可以用「移动到…」「↑↓」按钮。章节顺序就是播放顺序，改动「按顺序继续」时会先列出受影响的句子。</li><li>删除章节或段落默认保留剧情，句子会进入「未分组」；删除单句会先告诉你有多少跳转指向它。都可以撤销。</li><li>「文本导入」先出预览：识别 # 章节、## 段落、「角色：台词」，列出新增句数、识别到的章节段落和读不懂的行；取消不改工程，确认后一次撤销即可还原。</li><li>在左侧「角色」建立林悠、林澈这样的角色：填名字、姓名颜色，逐个添加表情（透明立绘）。表情只是替换现有角色图层的图片，不会移动位置或复制图层。</li><li>录入台词时在「角色与表情」选择谁在说话、本句用哪个表情；同场的另一个角色也可以单独设表情。留空则沿用上一句，自由填写说话人和旁白仍然可用。</li><li>上传角色立绘后可在图层属性里指定「图片属于角色」，让这张图跟随角色表情切换。</li><li>在「效果与演出」选择目标图层，添加效果或使用预设。可设置起点、终点、时长、延迟、缓动和缩放中心。点击舞台上方预览、终态或拖动时间条；返回布局后可继续拖动素材。</li><li>持续效果在推进时按目标值结算；本句结束恢复的效果离开即移除；自动恢复效果在播放后回到起点。独立场景重置此前持续效果。读档和后退显示本句终态。</li><li>「▶ 从本句 / ▶ 从本段」可以从指定位置试玩，背景、表情和持续演出按前面的句子还原；前面有分支时会提示这是近似还原。选中剧情节点，上传背景或角色。支持多个角色和背景素材叠加。</li><li>在舞台拖动图片；选中边框右下角可等比缩放。也可输入 X/Y、宽高，或用「填满画布」。隐藏对话框更方便编辑底部。</li><li>右侧图层从上到下就是前景到背景。可隐藏、锁定、调整层级。锁定底图后更容易选前景。</li><li>新对话默认沿用上一画面；第一次修改会生成独立副本。编辑模式按脚本顺序预览，试玩按实际走过的路径继承。</li><li>选项数量可增加，目标可以是普通对话。使用「生成局部分支并汇合」快速创建各选项的对话，并统一跳回主线。</li><li>撤销／重做支持图层、文本和剧情结构（最多 60 步）。输入框里 Ctrl+Z 使用原生文本撤销；页面按钮撤销工程修改。</li><li>场景可存为预设，也可导出不含对话框的合成 PNG。保存工程包含原始图层，导出试玩生成独立离线 HTML。</li></ol><p class="hint">支持打开 V0.1 / V0.2 工程。旧工程保留原来的两结局结构，不会强制替换。本版音频为基础功能：不做 TTS、自动配音、口型同步、音频剪辑、复杂叠轨与批量音频绑定；导出的离线 HTML 会内嵌音频，导出前会提示体积。浏览器数据清理会删除草稿，请下载备份。</p>');
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

$('#addChapter').onclick=()=>{
 let c;edit(()=>{c=C.addChapter(p,'新章节')});
 askName('重命名章节',c.title,v=>edit(()=>{const t=p.chapters.find(x=>x.id===c.id);if(t)t.title=v}));
};
$('#addPara').onclick=()=>{
 const n=node(),entry=n?C.paragraphMap(p).get(n.paragraphId):null;
 const cid=entry?entry.chapter.id:(p.chapters[0]?p.chapters[0].id:'');
 if(!cid)return toast('请先新建一个章节');
 let g;edit(()=>{g=C.addParagraph(p,cid,'新段落');const c=p.chapters.find(x=>x.id===cid);if(c)c.collapsed=false});
 askName('重命名段落',g.title,v=>edit(()=>{const t=C.paragraphMap(p).get(g.id);if(t)t.paragraph.title=v}));
};
$('#moveNode').onclick=()=>{if(!node())return toast('请先选中一句剧情');openMoveDialog('node',selected)};

/* ---------- V0.4.3 批量编辑 ---------- */
let batch={on:false,ids:new Set(),anchor:null,scene:null,effects:null};

function batchNodes(){return p.nodes.filter(n=>batch.ids.has(n.id))}
function batchPrune(){for(const id of [...batch.ids])if(!p.nodes.some(n=>n.id===id))batch.ids.delete(id);if(batch.anchor&&!p.nodes.some(n=>n.id===batch.anchor))batch.anchor=null}
function batchParagraphs(){return new Set(batchNodes().map(n=>n.paragraphId)).size}
function batchInfoText(){
 const n=batch.ids.size;
 return n?('已选 '+n+' 句 · 跨 '+batchParagraphs()+' 段'):'还没有选择句子';
}
function batchToggle(id){if(batch.ids.has(id))batch.ids.delete(id);else batch.ids.add(id);batch.anchor=id;render()}
function batchRangeTo(id){
 const order=p.nodes.map(n=>n.id),a=order.indexOf(batch.anchor==null?selected:batch.anchor),b=order.indexOf(id);
 if(a<0||b<0)return;
 const [lo,hi]=a<b?[a,b]:[b,a];
 for(let i=lo;i<=hi;i++)batch.ids.add(order[i]);
 batch.anchor=id;render();
}
function batchPickParagraph(gid){
 const ids=p.nodes.filter(n=>n.paragraphId===gid).map(n=>n.id);
 const all=ids.length&&ids.every(id=>batch.ids.has(id));
 for(const id of ids){if(all)batch.ids.delete(id);else batch.ids.add(id)}
 batch.anchor=ids[0]||batch.anchor;render();
}
function batchClear(){batch.ids.clear();batch.anchor=null;render()}
function batchSetOn(on){
 batch.on=on;if(!on){batch.ids.clear();batch.anchor=null}
 render();toast(on?'批量编辑：勾选句子，或用 Shift 连选、点段落「全选」':'已退出批量编辑');
}
function optionHtml(list,selected){return list.map(o=>'<option value="'+esc(o.value)+'"'+(o.value===selected?' selected':'')+'>'+esc(o.label)+'</option>').join('')}
function uniqueBy(list,key){const seen=new Set();return list.filter(x=>{const k=key(x);if(seen.has(k))return false;seen.add(k);return true})}

/* ---------- 批量字段面板 ---------- */
function openBatchFields(){
 const nodes=batchNodes();
 if(!nodes.length)return toast('先勾选要修改的句子');
 const say=nodes.filter(n=>n.type==='say');
 if(!say.length)return toast('选中的句子都是选项或结局，批量修改只作用于对话/旁白');
 const speakers=(p.characters||[]).map(c=>({value:c.id,label:c.name}));
 const speakerValues=uniqueBy(say.map(n=>n.speakerId||''),x=>x);
 const exprValues=uniqueBy(say.map(n=>n.expressionId||''),x=>x);
 const speakerMixed=speakerValues.length>1;
 const exprMixed=exprValues.length>1;
 const curSpeaker=speakerMixed?'__mixed':(speakerValues[0]||'');
 const curExpr=exprMixed?'__mixed':(exprValues[0]||'');
 modal('批量设置角色与表情',
  '<p class="hint">只有勾选的字段会被修改；没勾选的字段保持原样。选项与结局节点会自动跳过。</p>'
  +'<div class="batch-field"><label class="check-label"><input type="checkbox" id="fSpeaker">说话角色</label>'
  +'<select id="vSpeaker">'+ (speakerMixed?'<option value="__mixed" selected>多种值</option>':'')
  +optionHtml([{value:'',label:'旁白 / 自由文本（清空角色）'},...speakers],curSpeaker)+'</select></div>'
  +'<div class="batch-field"><label class="check-label"><input type="checkbox" id="fSpeakerExpr">本句说话角色的表情</label>'
  +'<select id="vSpeakerExpr">'+ (exprMixed?'<option value="__mixed" selected>多种值</option>':'')
  +'<option value="">沿用画面表情（清空）</option></select></div>'
  +'<div class="batch-field"><label class="check-label"><input type="checkbox" id="fCast">指定在场角色的表情</label>'
  +'<select id="vCastChar">'+optionHtml(speakers,'')+'</select>'
  +'<select id="vCastExpr"><option value="">清除该角色在本句的表情</option></select></div>'
  +'<p class="hint">「在场角色」只更新这句里该角色已有图层对应的绑定，不新增图层、不动位置与其他角色。</p>'
  +'<div class="stack"><button id="batchPreview" class="primary">预览修改</button></div>');
 const exprFor=c=>{
  const e=document.querySelector('#vSpeakerExpr');
  const keep=e.value==='__mixed'?'__mixed':'';
  e.innerHTML=(exprMixed?'<option value="__mixed">多种值</option>':'')+'<option value="">沿用画面表情（清空）</option>'
   +(c&&c.expressions?c.expressions.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join(''):'');
  e.value=keep;
 };
 const castCharSel=document.querySelector('#vCastChar');
 const castExprSel=document.querySelector('#vCastExpr');
 const fillCastExpr=()=>{
  const c=(p.characters||[]).find(x=>x.id===castCharSel.value);
  castExprSel.innerHTML='<option value="">清除该角色在本句的表情</option>'
   +(c?c.expressions.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join(''):'');
 };
 castCharSel.onchange=fillCastExpr;fillCastExpr();
 const spSel=document.querySelector('#vSpeaker');
 spSel.onchange=()=>{const c=(p.characters||[]).find(x=>x.id===spSel.value);if(document.querySelector('#fSpeaker').checked)exprFor(c)};
 document.querySelector('#fSpeaker').onchange=e=>{
  if(!e.target.checked)return;
  const c=(p.characters||[]).find(x=>x.id===spSel.value);
  exprFor(c);
 };
 document.querySelector('#batchPreview').onclick=()=>{
  const fields={};
  if(document.querySelector('#fSpeaker').checked)fields.speaker={characterId:spSel.value==='__mixed'?'':spSel.value};
  if(document.querySelector('#fSpeakerExpr').checked){
   const v=document.querySelector('#vSpeakerExpr').value;
   if(v==='__mixed')return toast('「多种值」不能直接应用，请选择一个表情或清空');
   fields.speakerExpression={expressionId:v};
  }
  if(document.querySelector('#fCast').checked){
   if(!castCharSel.value)return toast('请选择在场的角色');
   fields.cast={characterId:castCharSel.value,expressionId:castExprSel.value};
  }
  if(!Object.keys(fields).length)return toast('至少勾选一个要修改的字段');
  previewBatch(fields);
 };
}

/* ---------- 批量预览与应用 ---------- */
function batchSignature(fields){return JSON.stringify({ids:[...batch.ids].sort(),fields})}
function previewBatch(fields,signature){
 const plan=C.planBatch(p,[...batch.ids],fields);
 const sig=signature||batchSignature(fields);
 const sample=plan.changes.slice(0,5);
 const describe=ch=>{
  const name=id=>{const n=p.nodes.find(x=>x.id===id);return n?('第 '+(p.nodes.indexOf(n)+1)+' 句'):'（不存在）'}
  const c=id=>(p.characters||[]).find(x=>x.id===id);
  const sn=ch.after.speakerId?(c(ch.after.speakerId)?c(ch.after.speakerId).name:''):'旁白';
  const old=c(ch.before.speakerId)?c(ch.before.speakerId).name:(ch.before.speakerId?'（角色已删除）':'旁白');
  const ex=(cid,eid)=>{const cc=c(cid);const e=cc&&cc.expressions.find(x=>x.id===eid);return e?e.name:''};
  const beforeEx=ex(ch.before.speakerId,ch.before.expressionId)||'沿用';
  const afterEx=ex(ch.after.speakerId,ch.after.expressionId)||'沿用';
  const castDiff=JSON.stringify(ch.before.cast)!==JSON.stringify(ch.after.cast)
   ?'；在场表情：'+ch.after.cast.map(x=>{const cc=c(x.characterId);return (cc?cc.name:'?')+'·'+(ex(x.characterId,x.expressionId)||'沿用')}).join('、')
   :'';
  return '<li>'+describeNode(ch.nodeId)+'：'+old+' · '+beforeEx+' → <b>'+sn+' · '+afterEx+'</b>'+castDiff+'</li>';
 };
 const fieldText=Object.keys(fields).map(k=>{
  if(k==='speaker'){const c=(p.characters||[]).find(x=>x.id===fields.speaker.characterId);return '说话角色 → '+(c?c.name:'旁白 / 自由文本')}
  if(k==='speakerExpression'){const id=fields.speakerExpression.expressionId;const c=(p.characters||[]).find(x=>x.expressions.some(e=>e.id===id));const e=c&&c.expressions.find(x=>x.id===id);return '说话表情 → '+(e?e.name:'沿用画面表情')}
  const c=(p.characters||[]).find(x=>x.id===fields.cast.characterId);const e=c&&c.expressions.find(x=>x.id===fields.cast.expressionId);
  return '在场「'+(c?c.name:'?')+'」表情 → '+(e?e.name:'清除');
 }).join('；');
 const skipped=plan.skipped.slice(0,20).map(x=>'<li>'+describeNode(x.nodeId)+'：'+esc(x.reason)+'</li>').join('');
 const conflicts=plan.conflicts.slice(0,20).map(x=>'<li>'+describeNode(x.nodeId)+'：'+esc(x.reason)+'</li>').join('');
 modal('批量修改预览',
  '<p><b>已选 '+plan.total+' 句</b> · 可修改 <b>'+plan.changes.length+'</b> 句 · 跳过 '+plan.skipped.length+' 句 · 冲突 '+plan.conflicts.length+' 句</p>'
  +'<p class="hint">修改内容：'+esc(fieldText)+'</p>'
  +(plan.changes.length?'<p class="hint">前几句的变化：</p><ul class="issue-list">'+sample.map(describe).join('')+'</ul>'
    +(plan.changes.length>sample.length?'<details><summary>展开全部 '+plan.changes.length+' 句</summary><ul class="issue-list">'+plan.changes.map(describe).join('')+'</ul></details>':''):'')
  +(skipped?'<p class="hint">跳过：</p><ul class="issue-list">'+skipped+'</ul>':'')
  +(conflicts?'<p class="hint">冲突（这些句子不会写入）：</p><ul class="issue-list">'+conflicts+'</ul>':'')
  +'<div class="stack">'
  +(plan.changes.length?'<button id="batchApply" class="primary">应用到 '+plan.changes.length+' 句</button>':'<button class="primary" disabled>没有可应用的修改</button>')
  +'</div>');
 const btn=document.querySelector('#batchApply');
 if(btn)btn.onclick=()=>{
  /* 应用前重新计算，防止预览之后数据被改动 */
  const again=C.planBatch(p,[...batch.ids],fields);
  if(JSON.stringify(again.changes)!==JSON.stringify(plan.changes)){
   toast('预览后数据有变化，已重新生成预览');
   previewBatch(fields,sig);
   return;
  }
  $('#modal').close();
  if(!again.changes.length){toast('没有需要修改的内容，未记录撤销');return}
  edit(()=>{C.applyBatch(p,again)});
  toast('已修改 '+again.changes.length+' 句，可一次撤销');
 };
}

/* ---------- 场景 / 演出复制粘贴 ---------- */
function batchCopyScene(){
 const n=node();if(!n)return toast('先选中要复制场景的句子');
 if(n.sceneMode!=='own')return toast('这句沿用了上一画面。请先用「独立画面」把它变成独立场景，再复制。');
 batch.scene={sourceId:n.id,layers:C.clone(n.layers||[])};
 toast('已复制这句的场景布局（'+batch.scene.layers.length+' 个图层），台词与演出不会一起复制');
}
function pastePlansToModal(title,plan,apply){
 const ok=plan.targets.filter(t=>t.ok).length,bad=plan.targets.length-ok;
 const issues='<ul class="issue-list">'+plan.targets.filter(t=>!t.ok).map(t=>'<li>'+describeNode(t.nodeId)+'：'+esc((t.issues||[t.reason]).join('；'))+'</li>').join('')+'</ul>';
 modal(title,
  '<p>可应用 <b>'+ok+'</b> 句，跳过 '+bad+' 句。</p>'
  +(bad?'<p class="hint">下面这些句子不会写入：</p>'+issues:'')
  +'<p class="hint">应用会作为一次操作，可整体撤销。</p>'
  +'<div class="stack">'+(ok?'<button id="pasteApply" class="primary">应用到 '+ok+' 句</button>':'<button class="primary" disabled>没有可应用的目标</button>')+'</div>');
 const btn=document.querySelector('#pasteApply');
 if(btn)btn.onclick=()=>{$('#modal').close();edit(()=>apply(true));toast('已应用 '+ok+' 句')};
}
function batchPasteScene(){
 if(!batch.scene)return toast('先「复制场景」');
 const ids=[...batch.ids];
 if(!ids.length)return toast('先勾选要粘贴到的句子');
 const plan=C.planPasteScene(p,batch.scene.sourceId,ids);
 if(!plan.ok)return toast(plan.reason);
 pastePlansToModal('粘贴场景到 '+ids.length+' 句',plan,onlySafe=>C.applyPasteScene(p,plan,onlySafe));
}
function batchCopyEffects(){
 const n=node();if(!n)return toast('先选中要复制演出的句子');
 if(!(n.effects||[]).length)return toast('这句没有演出可以复制');
 batch.effects={sourceId:n.id,effects:C.clone(n.effects)};
 toast('已复制 '+batch.effects.effects.length+' 条演出（不含场景与台词）');
}
function batchPasteEffects(){
 if(!batch.effects)return toast('先「复制演出」');
 const ids=[...batch.ids];
 if(!ids.length)return toast('先勾选要粘贴到的句子');
 const build=mode=>{
  const plan=C.planPasteEffects(p,batch.effects.sourceId,ids,mode);
  if(!plan.ok)return toast(plan.reason);
  pastePlansToModal((mode==='append'?'追加':'替换')+'演出到 '+ids.length+' 句',plan,onlySafe=>C.applyPasteEffects(p,plan,onlySafe));
 };
 modal('粘贴演出的方式','<p>替换会清掉目标句原有的演出；追加会保留原有演出，并在冲突时停下来。</p>'
  +'<div class="stack"><button id="fxReplace" class="primary">替换原有演出</button><button id="fxAppend">追加到原有演出</button></div>');
 document.querySelector('#fxReplace').onclick=()=>{$('#modal').close();build('replace')};
 document.querySelector('#fxAppend').onclick=()=>{$('#modal').close();build('append')};
}

$('#batchToggle').onclick=()=>batchSetOn(!batch.on);
$('#batchFields').onclick=openBatchFields;
$('#batchCopyScene').onclick=batchCopyScene;
$('#batchPasteScene').onclick=batchPasteScene;
$('#batchCopyFx').onclick=batchCopyEffects;
$('#batchPasteFx').onclick=batchPasteEffects;
$('#batchClear').onclick=batchClear;

/* ================= V0.5 基础音频 =================
 * 编辑器与导出播放器共用 dist/audio.js 的同一个工厂：工程内容（逐句音频指令）
 * 与播放偏好（总/分类音量、静音）分开存放，音频生命周期只在这里接线。 */
let audioRT=null,audioPrefs=loadAudioPrefs(),audioPreviewId=null,cuePreviewOn=false;
const MIXERS=[['master','volMaster','volMasterVal'],['bgm','volBgm','volBgmVal'],['sfx','volSfx','volSfxVal'],['voice','volVoice','volVoiceVal']];
function loadAudioPrefs(){try{return A.pure.normalizePrefs(JSON.parse(localStorage.getItem('paper-audio-prefs')||'null'))}catch{return A.pure.normalizePrefs(null)}}
function persistAudioPrefs(){try{localStorage.setItem('paper-audio-prefs',JSON.stringify(audioPrefs))}catch{}}
function runtime(){
 if(!audioRT)audioRT=A.runtime({assetData:id=>{const a=C.audioAsset(p,id);return a?a.data:''},prefs:audioPrefs,onStatus:audioStatus});
 return audioRT;
}
function audioName(id){const a=C.audioAsset(p,id);return a?a.name:(id||'（已删除的素材）')}
function audioStatus(st){
 const err=st&&st.errors&&st.errors[0];
 let text;
 if(err)text='注意：'+err.title+'（'+(err.label||audioName(err.audioId)||'当前句')+'）。'+err.hint;
 else if(!st)text=C.hasAnyAudio(p)?'点击「启用声音」后播放':'本工程没有音频';
 else{
  const cur=st.bgm&&st.bgm.playing?'正在播放「'+audioName(st.bgm.audioId)+'」':'当前没有背景音乐';
  text=(st.unlocked?'声音已启用':'点击「启用声音」后播放')+' · '+cur+(st.prefs.muted?' · 已静音':'');
 }
 for(const id of ['#audioStatus','#audioCueStatus']){const el=$(id);if(el){el.textContent=text;el.classList.toggle('audio-error',!!err)}}
 const btn=$('#audioCuePreview');if(btn)btn.textContent=cuePreviewOn?'停止本句试听':'▷ 试听本句音频';
}
function audioStopAll(){if(audioRT)audioRT.stopAll();audioPreviewId=null;cuePreviewOn=false}
/* 进入一句：正常推进沿用当前播放位置；定点试玩 / 返回 / 读档 / 重开按真实路线重建。 */
function enterAudioInto(nodeId,mode){
 if(!nodeId||!C.hasAnyAudio(p))return;               /* 无音频旧工程不创建播放任务 */
 const rt=runtime();
 if(!rt.isUnlocked()){audioStatus(rt.status());return}
 const n=p.nodes.find(x=>x.id===nodeId);if(!n)return;
 audioPreviewId=null;cuePreviewOn=false;
 const cue=A.pure.normalizeCue(n.audio),rebuild=mode==='rebuild';
 const bgmState=rebuild?C.bgmAt(p,nodeId,trail):null;
 rt.enter(cue,{rebuild,bgmState,label:describeNode(nodeId)});
}
function syncMixerUI(){
 for(const [key,id,valId]of MIXERS){
  const el=$('#'+id);if(!el)continue;
  if(document.activeElement!==el)el.value=String(Math.round(audioPrefs[key]*100));
  const out=$('#'+valId);if(out)out.textContent=el.value+'%';
 }
 const m=$('#muteAll');if(m)m.checked=!!audioPrefs.muted;
}
function renderAudioUI(){renderAudioTab();renderNodeAudio()}
function renderAudioTab(){
 const list=p.audioAssets||[],total=list.reduce((s,a)=>s+(a.bytes||0),0);
 const totalEl=$('#audioTotal');if(totalEl)totalEl.textContent=list.length+' 个素材 · '+A.pure.formatBytes(total);
 const filter=$('#audioFilter')?$('#audioFilter').value:'all';
 const shown=filter==='all'?list:list.filter(a=>(a.categories||[]).includes(filter));
 const box=$('#audioAssets');if(!box)return;
 box.innerHTML=shown.length?shown.map(a=>{
  const uses=C.audioUsage(p,a.id),cats=(a.categories||[]).map(c=>A.CATEGORY_NAMES[c]||c).join(' / ');
  const dur=a.duration==null?'时长未知':A.pure.formatSeconds(a.duration);
  return '<div class="audio-asset-row'+(audioPreviewId===a.id?' playing':'')+'">'
   +'<div class="audio-name"><span>'+esc(a.name)+'</span><em>'+esc(cats)+'</em></div>'
   +'<small>'+esc(dur)+' · '+esc(A.pure.formatBytes(a.bytes))+' · 引用 '+uses.length+' 处'
   +(a.durationNote?' · '+esc(a.durationNote):'')+'</small>'
   +'<div class="audio-actions"><button data-audio-preview="'+esc(a.id)+'">'+(audioPreviewId===a.id?'停止试听':'试听')+'</button>'
   +'<button data-audio-delete="'+esc(a.id)+'" class="danger">删除</button></div></div>';
 }).join(''):'<p class="hint empty">还没有音频素材。选好分类后点「导入音频」；本版可靠支持 PCM WAV。</p>';
 box.querySelectorAll('[data-audio-preview]').forEach(b=>b.onclick=()=>toggleAudioPreview(b.dataset.audioPreview));
 box.querySelectorAll('[data-audio-delete]').forEach(b=>b.onclick=()=>deleteAudioAsset(b.dataset.audioDelete));
 syncMixerUI();
}
function audioAssetOptions(value){
 const list=p.audioAssets||[],groups=[['bgm','背景音乐'],['sfx','音效'],['voice','语音']],used=new Set();
 if(!list.length)return '<option value="">（还没有音频素材，先在左栏「音频」导入）</option>';
 let html='<option value="">（不指定）</option>';
 for(const [k,label]of groups){
  const items=list.filter(a=>(a.categories||[])[0]===k);
  if(!items.length)continue;
  html+='<optgroup label="'+label+'">'+items.map(a=>{used.add(a.id);
   return '<option value="'+esc(a.id)+'"'+(a.id===value?' selected':'')+'>'+esc(a.name)+'</option>'}).join('')+'</optgroup>';
 }
 const rest=list.filter(a=>!used.has(a.id));
 if(rest.length)html+='<optgroup label="其他">'+rest.map(a=>'<option value="'+esc(a.id)+'"'+(a.id===value?' selected':'')+'>'+esc(a.name)+'</option>').join('')+'</optgroup>';
 if(value&&!list.some(a=>a.id===value))html+='<option value="'+esc(value)+'" selected>素材已删除（保留占位）</option>';
 return html;
}
function ensureAudio(n){if(!n.audio||typeof n.audio!=='object')n.audio={bgm:null,sfx:[],voice:null};if(!Array.isArray(n.audio.sfx))n.audio.sfx=[];return n.audio}
/* 用 normalizeCue 的输出写回：字段齐全，单次编辑形成一条撤销记录。 */
function setNodeAudio(mutator){
 const n=node();if(!n)return;
 const cue=A.pure.normalizeCue(n.audio);
 mutator(cue);
 n.audio=(cue.bgm||cue.sfx.length||cue.voice)?cue:null;
}
function writeAudio(mutator,key){edit(()=>setNodeAudio(mutator),key||'audio')}
function audioContinuous(key,mutator){
 if(playing)return toast('请先退出试玩再编辑');
 checkpoint(key);setNodeAudio(mutator);revision++;queueSave();updateHistory();
}
function renderNodeAudio(){
 const n=node(),panel=$('#nodeAudioPanel');if(!panel)return;
 if(!n){panel.hidden=true;return}
 panel.hidden=false;
 const cue=A.pure.normalizeCue(n.audio),mode=cue.bgm?cue.bgm.action:'keep';
 $('#audioCueCount').textContent=(cue.bgm?1:0)+cue.sfx.length+(cue.voice?1:0);
 document.querySelectorAll('input[name=bgmMode]').forEach(r=>{r.checked=r.value===mode});
 $('#bgmAsset').innerHTML=audioAssetOptions(cue.bgm&&cue.bgm.audioId||'');
 $('#bgmVolume').value=String(Math.round((cue.bgm&&cue.bgm.volume!=null?cue.bgm.volume:1)*100));
 $('#bgmVolumeVal').textContent=$('#bgmVolume').value+'%';
 $('#bgmLoop').checked=!!(cue.bgm&&cue.bgm.loop);
 $('#bgmFadeIn').value=cue.bgm&&cue.bgm.fadeIn!=null?cue.bgm.fadeIn:A.DEFAULT_FADE.fadeIn;
 $('#bgmFadeOut').value=cue.bgm&&cue.bgm.fadeOut!=null?cue.bgm.fadeOut:A.DEFAULT_FADE.fadeOut;
 /* 当前生效音乐：路线不确定时明确提示，不猜、不按数组顺序拼状态。 */
 const eff=$('#audioEffective');
 const plan=C.entryPlan(p,n.id,(playing&&current===n.id&&trail.length)?trail:null);
 if(plan&&plan.ambiguous&&!plan.audioAgrees){
  eff.className='audio-effective warn';
  eff.textContent='这句之前的路线不唯一，无法确定生效音乐。请用「▶ 从本句」选择路线，或从更早的音乐入口开始试玩。';
 }else{
  const st=plan&&plan.bgm?plan.bgm:C.bgmAt(p,n.id,plan?plan.trail:undefined);
  eff.className='audio-effective';
  eff.textContent=st?'当前生效音乐：「'+audioName(st.audioId)+'」'+(st.loop?'（循环）':''):'当前没有背景音乐（本句若选「沿用」则保持上一句的状态）';
 }
 $('#sfxRows').innerHTML=cue.sfx.length?cue.sfx.map((s,i)=>{
  const sid=s.id||String(i),v=Math.round(s.volume*100);
  return '<div class="sfx-row" data-sfx="'+esc(sid)+'">'
   +'<label>音效素材<select data-sfx-asset>'+audioAssetOptions(s.audioId)+'</select></label>'
   +'<div class="two"><label>音量 <span data-sfx-vol-val>'+v+'%</span><input data-sfx-volume type="range" min="0" max="100" value="'+v+'"></label>'
   +'<label>延迟（秒）<input data-sfx-delay type="number" min="0" max="20" step="0.1" value="'+s.delay+'"></label></div>'
   +'<button data-sfx-del>删除这条音效</button></div>';
 }).join(''):'<p class="hint">这一句还没有音效。进入本句时每条音效各触发一次。</p>';
 $('#sfxRows').querySelectorAll('.sfx-row').forEach(row=>{
  const sid=row.dataset.sfx;
  const sel=row.querySelector('[data-sfx-asset]');
  sel.onchange=()=>writeAudio(c=>{const s=c.sfx.find(x=>(x.id||'')===sid);if(s)s.audioId=sel.value},'sfx-asset-'+sid);
  const vol=row.querySelector('[data-sfx-volume]'),out=row.querySelector('[data-sfx-val], [data-sfx-vol-val]');
  vol.oninput=()=>{const v=+vol.value/100;if(out)out.textContent=vol.value+'%';
   audioContinuous('sfx-volume-'+sid,c=>{const s=c.sfx.find(x=>(x.id||'')===sid);if(s)s.volume=v})};
  const delay=row.querySelector('[data-sfx-delay]');
  delay.onchange=()=>{const v=Math.max(0,Math.min(20,+delay.value||0));delay.value=v;
   writeAudio(c=>{const s=c.sfx.find(x=>(x.id||'')===sid);if(s)s.delay=v},'sfx-delay-'+sid)};
  row.querySelector('[data-sfx-del]').onclick=()=>writeAudio(c=>{c.sfx=c.sfx.filter(x=>(x.id||'')!==sid)},'sfx-del-'+sid);
 });
 $('#voiceAsset').innerHTML=audioAssetOptions(cue.voice&&cue.voice.audioId||'');
 $('#voiceVolume').value=String(Math.round((cue.voice?cue.voice.volume:1)*100));
 $('#voiceVolumeVal').textContent=$('#voiceVolume').value+'%';
 audioStatus(audioRT?audioRT.status():null);
}
/* ---------- 素材导入 / 试听 / 引用保护 ---------- */
function readDataUrl(f){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('音频读取失败'));r.readAsDataURL(f)})}
async function audioIdFor(dataUrl){
 try{
  const raw=atob(String(dataUrl).split(',')[1]||''),u=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i);
  const h=await globalThis.crypto.subtle.digest('SHA-256',u);
  return 'au_'+[...new Uint8Array(h)].slice(0,8).map(x=>x.toString(16).padStart(2,'0')).join('');
 }catch{return 'au_'+C.id().slice(-12)}   /* 回退仍由内容查重复用，不会产生第二个素材 */
}
function importAudioAsset(category){
 const target=selected;
 pick('audio',async f=>{
  const data=H?f.dataUrl:await readDataUrl(f);
  if(!data)throw Error('音频读取失败');
  let bytes;
  try{bytes=A.pure.decodeDataUrl(data).bytes}catch(e){throw Error('「'+f.name+'」不是有效音频：'+e.message)}
  const mime=f.type||'',ext=A.pure.extOf(f.name);
  const total=(p.audioAssets||[]).reduce((s,a)=>s+(a.bytes||0),0);
  const probe=()=>{try{return new Audio()}catch{return null}};
  const can=m=>{const el=probe();return el&&el.canPlayType?el.canPlayType(m):''};
  const check=A.pure.checkImport({name:f.name,mime,bytes,ext,totalBytes:total,elementFactory:probe,canPlayType:can});
  if(!check.ok)throw Error(check.message);
  const meta=await A.pure.readMeta(data,{elementFactory:probe});   /* 时长异步读取 */
  if(meta.note)toast('「'+f.name+'」：'+meta.note);
  const picked=C.assetForAudioImport(p,{id:(H&&f.id)?f.id:await audioIdFor(data),
   name:String(f.name).replace(/\.[^.]+$/,'')||f.name,categories:[category],data,
   mime:check.mime,ext:check.ext,bytes:bytes.length,duration:meta.duration,durationNote:meta.note});
  if(selected!==target||playing)throw Error('当前节点已变化，请重新导入音频');
  edit(()=>{
   if(picked.reused)picked.asset.categories=picked.categories;
   else p.audioAssets.push(picked.asset);
  });
  toast('已导入「'+picked.asset.name+'」'+(picked.reused?'（复用已有素材）':'')+' · '+A.pure.formatSeconds(meta.duration));
 });
}
function previewAudio(id,toggle){
 const rt=runtime(),a=C.audioAsset(p,id);if(!a)return;
 if(!rt.isUnlocked()){toast('请先点击「启用声音」');return}
 if(toggle&&audioPreviewId===id){rt.stopPreview();audioPreviewId=null;renderAudioTab();audioStatus(rt.status());return}
 rt.previewAsset(id,(a.categories||[])[0]||'sfx',1).then(r=>{if(!r.ok)toast('试听失败：'+((r.info&&r.info.title)||'素材无法播放'))});
 audioPreviewId=id;cuePreviewOn=false;
 renderAudioTab();audioStatus(rt.status());
}
function toggleAudioPreview(id){previewAudio(id,true)}
function deleteAudioAsset(id){
 const a=C.audioAsset(p,id);if(!a)return;
 const uses=C.audioUsage(p,id);
 const remove=()=>{
  audioStopAll();
  edit(()=>{
   for(const n of p.nodes){
    if(!n.audio)continue;
    const cue=A.pure.normalizeCue(n.audio);
    if(cue.bgm&&cue.bgm.action==='play'&&cue.bgm.audioId===id)cue.bgm=null;
    cue.sfx=cue.sfx.filter(s=>s.audioId!==id);
    if(cue.voice&&cue.voice.audioId===id)cue.voice=null;
    n.audio=(cue.bgm||cue.sfx.length||cue.voice)?cue:null;
   }
   p.audioAssets=p.audioAssets.filter(x=>x.id!==id);
  });
 };
 if(uses.length){
  modal('不能删除正在使用的音频素材',
   '<p>「'+esc(a.name)+'」被 <b>'+uses.length+'</b> 处引用。默认阻止直接删除；请先替换或解除这些引用。</p>'
   +'<ul class="issue-list audio-issue-list">'+uses.slice(0,20).map(u=>'<li>'+esc(u.label)+' · '+esc(u.where)+'</li>').join('')
   +(uses.length>20?'<li>…还有 '+(uses.length-20)+' 处</li>':'')+'</ul>'
   +'<p class="hint">也可以直接解除全部引用再删除（可撤销）。</p>'
   +'<div class="stack"><button id="audioLocate" class="primary">去修改第一处引用</button>'
   +'<button id="audioForceDelete" class="danger">解除全部 '+uses.length+' 处引用并删除</button></div>');
  $('#audioLocate').onclick=()=>{$('#modal').close();locateNode(uses[0].nodeId)};
  $('#audioForceDelete').onclick=()=>{$('#modal').close();remove();toast('已解除引用并删除素材，可撤销')};
  return;
 }
 modal('删除音频素材','<p>「'+esc(a.name)+'」目前没有被任何句子引用，删除后可以撤销。</p>'
  +'<div class="stack"><button id="confirmAudioDelete" class="danger">删除这个素材</button></div>');
 $('#confirmAudioDelete').onclick=()=>{$('#modal').close();remove();toast('已删除音频素材，可撤销')};
}
/* ---------- 试听本句 ---------- */
function toggleCuePreview(){
 const rt=runtime();
 if(cuePreviewOn){rt.stopAll();cuePreviewOn=false;audioPreviewId=null;audioStatus(rt.status());renderAudioTab();return}
 if(!rt.isUnlocked()){toast('请先点击「启用声音」');return}
 const n=node();if(!n)return;
 const cue=A.pure.normalizeCue(n.audio),st=C.bgmAt(p,n.id,undefined);
 rt.enter(cue,{rebuild:true,bgmState:st,label:describeNode(n.id)});
 cuePreviewOn=true;audioPreviewId=null;
 audioStatus(rt.status());renderAudioTab();
}
/* ---------- 事件：偏好、解锁、导入与逐句控件 ---------- */
for(const [key,id,valId]of MIXERS){
 const el=$('#'+id);
 el.oninput=()=>{const v=Math.max(0,Math.min(100,+el.value||0))/100;
  audioPrefs=A.pure.normalizePrefs({...audioPrefs,[key]:v});runtime().setPrefs(audioPrefs);persistAudioPrefs();
  $('#'+valId).textContent=el.value+'%'};
}
$('#muteAll').onchange=e=>{audioPrefs=A.pure.normalizePrefs({...audioPrefs,muted:!!e.target.checked});runtime().setPrefs(audioPrefs);persistAudioPrefs();audioStatus(runtime().status())};
$('#audioUnlock').onclick=async()=>{
 const r=await runtime().unlock();
 if(!r.ok)toast('声音未启用：'+(r.title||'播放被拒绝')+'。'+(r.hint||''));
 else{toast('声音已启用');if(playing)enterAudioInto(current,'rebuild')}
 audioStatus(runtime().status());
};
$('#audioImport').onclick=()=>importAudioAsset($('#audioCategory').value);
$('#audioFilter').onchange=()=>renderAudioTab();
document.querySelectorAll('input[name=bgmMode]').forEach(r=>r.onchange=()=>{
 if(!r.checked)return;
 const mode=r.value;
 if(mode==='play'&&!(p.audioAssets||[]).length){toast('请先在左栏「音频」导入音乐素材');renderNodeAudio();return}
 writeAudio(c=>{
  if(mode==='keep')c.bgm=null;
  else if(mode==='stop')c.bgm={action:'stop',fadeOut:A.DEFAULT_FADE.fadeOut};
  else c.bgm={action:'play',audioId:(p.audioAssets||[])[0].id,volume:1,loop:true,
   fadeIn:A.DEFAULT_FADE.fadeIn,fadeOut:A.DEFAULT_FADE.fadeOut};
 },'bgm-mode');
});
$('#bgmAsset').onchange=e=>{
 if(!e.target.value)return;
 writeAudio(c=>{
  if(!c.bgm||c.bgm.action!=='play')c.bgm={action:'play',audioId:e.target.value,volume:1,loop:true,
   fadeIn:A.DEFAULT_FADE.fadeIn,fadeOut:A.DEFAULT_FADE.fadeOut};
  else c.bgm.audioId=e.target.value;
 },'bgm-asset');
};
$('#bgmVolume').oninput=e=>{const v=+e.target.value; $('#bgmVolumeVal').textContent=v+'%';
 audioContinuous('bgm-volume',c=>{if(c.bgm&&c.bgm.action==='play')c.bgm.volume=v/100})};
$('#bgmLoop').onchange=e=>writeAudio(c=>{if(c.bgm&&c.bgm.action==='play')c.bgm.loop=!!e.target.checked},'bgm-loop');
for(const [id,key]of [['bgmFadeIn','fadeIn'],['bgmFadeOut','fadeOut']]){
 const el=$('#'+id);
 el.onchange=()=>{const v=Math.max(0,Math.min(10,+el.value||0));el.value=v;
  audioContinuous('bgm-'+key,c=>{if(c.bgm)c.bgm[key]=v})};
}
$('#addSfx').onclick=()=>{
 const list=p.audioAssets||[];
 if(!list.length)return toast('请先在左栏「音频」导入音效素材');
 writeAudio(c=>{c.sfx.push({id:'sfx_'+C.id(),audioId:list[0].id,volume:1,delay:0})},'sfx-add');
};
$('#voiceAsset').onchange=e=>writeAudio(c=>{
 c.voice=e.target.value?{audioId:e.target.value,volume:1}:null;
},'voice-asset');
$('#voiceVolume').oninput=e=>{const v=+e.target.value;$('#voiceVolumeVal').textContent=v+'%';
 audioContinuous('voice-volume',c=>{if(c.voice)c.voice.volume=v/100})};
$('#voicePreview').onclick=()=>{const v=$('#voiceAsset').value;if(!v)return toast('先选择语音素材');previewAudio(v,true)};
$('#voiceClear').onclick=()=>writeAudio(c=>{c.voice=null},'voice-clear');
$('#audioCuePreview').onclick=toggleCuePreview;

render();initialize();
