/* Shared data/scene logic for editor and exported games. */
function createVNCore(){
 const clone=x=>JSON.parse(JSON.stringify(x));
 const id=()=>globalThis.crypto?.randomUUID?.()||'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
 const finite=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
 function migrate(input){const p=clone(input);if(p.schema===3)return p;if(p.schema===2){p.schema=3;for(const n of p.nodes)n.effects=[];return p;}if(p.schema!==1)throw Error('不支持的工程版本');p.schema=2;p.id=id();p.presets=[];for(const n of p.nodes){n.sceneMode='own';n.layers=[];if(n.bg)n.layers.push({id:id(),asset:n.bg,name:'背景',kind:'bg',x:0,y:0,w:100,h:100,fit:'cover',opacity:100,hidden:false,locked:false,motion:'none'});if(n.char){const a=p.assets.find(a=>a.id===n.char);let h=n.scale||85,w=Math.min(90,h*9/16*((a?.width&&a?.height)?a.width/a.height:.65));n.layers.push({id:id(),asset:n.char,name:'角色立绘',kind:'char',x:n.align==='left'?4:n.align==='right'?96-w:50-w/2,y:100-h,w,h,fit:'contain',opacity:100,hidden:false,locked:false,motion:n.motion||'none',legacy:true})}delete n.bg;delete n.char;delete n.align;delete n.scale;delete n.motion;n.effects=[]}p.schema=3;return p}
 function validate(p){if(!p||![1,2,3].includes(p.schema)||typeof p.title!=='string'||!Array.isArray(p.nodes)||!Array.isArray(p.assets))throw Error('不是有效的纸间工程');if(p.nodes.length>20000||p.assets.length>1000)throw Error('工程超过体验版限制');const ids=new Set();for(const n of p.nodes){if(!n||typeof n.id!=='string'||ids.has(n.id)||!['say','choice','end'].includes(n.type)||typeof n.name!=='string'||typeof n.text!=='string')throw Error('剧情节点格式错误');ids.add(n.id);if(n.next!=null&&typeof n.next!=='string')throw Error('跳转目标格式错误');if(n.type==='choice'&&(!Array.isArray(n.options)||n.options.length>100||n.options.some(o=>!o||typeof o.text!=='string'||typeof o.target!=='string')))throw Error('选项格式错误');if(p.schema===3&&!Array.isArray(n.effects))throw Error('缺少演出列表');if(p.schema>=2){if(!['own','inherit'].includes(n.sceneMode)||!Array.isArray(n.layers)||n.layers.length>100)throw Error('场景格式错误');checkLayers(n.layers)}}const aids=new Set();for(const a of p.assets){if(!a||typeof a.id!=='string'||aids.has(a.id)||typeof a.name!=='string'||!['bg','char'].includes(a.kind)||typeof a.data!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(a.data))throw Error('图片素材格式错误');aids.add(a.id)}if(p.schema>=2){if(typeof p.id!=='string'||!Array.isArray(p.presets)||p.presets.length>200)throw Error('工程信息格式错误');for(const t of p.presets){if(!t||typeof t.id!=='string'||typeof t.name!=='string'||!Array.isArray(t.layers)||t.layers.length>100)throw Error('预设格式错误');checkLayers(t.layers)}}return true}
 function checkLayers(ls){const ids=new Set();for(const l of ls){if(!l||typeof l.id!=='string'||ids.has(l.id)||typeof l.asset!=='string'||typeof l.name!=='string'||!['bg','char'].includes(l.kind)||!finite(l.x,-500,500)||!finite(l.y,-500,500)||!finite(l.w,1,1000)||!finite(l.h,1,1000)||!finite(l.opacity,0,100)||typeof l.hidden!=='boolean'||typeof l.locked!=='boolean'||!['contain','cover','fill'].includes(l.fit)||!['none','breathe','sway'].includes(l.motion))throw Error('图层设置格式错误');ids.add(l.id)}}
 function scene(p,nodeId,trail){const n=p.nodes.find(n=>n.id===nodeId);if(!n)return [];if(n.sceneMode==='own')return n.layers;const before=trail||p.nodes.slice(0,p.nodes.indexOf(n)).map(n=>n.id);for(let i=before.length-1;i>=0;i--){const prev=p.nodes.find(n=>n.id===before[i]);if(prev?.sceneMode==='own')return prev.layers}return []}
 function edges(p,n){if(n.type==='end')return [];if(n.type==='choice')return(n.options||[]).map(o=>o.target).filter(Boolean);return [n.next||p.nodes[p.nodes.indexOf(n)+1]?.id].filter(Boolean)}
 function analyze(p){let errors=[],warnings=[];const ids=new Set(p.nodes.map(n=>n.id)),aids=new Set(p.assets.map(a=>a.id));if(!p.nodes.length)errors.push('还没有剧情节点。');for(const [i,n]of p.nodes.entries()){const at='第 '+(i+1)+' 节：';if(!n.text.trim())warnings.push(at+'文本为空。');if(n.type==='choice'){if(!n.options?.length)errors.push(at+'没有选项。');for(const o of n.options||[])if(!o.text.trim()||!ids.has(o.target))errors.push(at+'选项文字为空或跳转目标无效。')}if(n.next&&!ids.has(n.next))errors.push(at+'跳转目标无效。');for(const l of n.layers)if(!aids.has(l.asset))errors.push(at+'图层「'+l.name+'」缺少图片。');if(n.type==='say'&&!edges(p,n).length)warnings.push(at+'对话在此结束，建议添加结局节点。')}
 const layerIds=new Set(p.nodes.flatMap(n=>n.layers.map(l=>l.id)));for(const [i,n]of p.nodes.entries())for(const e of n.effects||[])if(!layerIds.has(e.layer))errors.push('第 '+(i+1)+' 节：演出引用的图层已删除或被预设替换，请移除或重新添加该效果。');
 const visited=new Set(),queue=p.nodes.length?[p.nodes[0].id]:[];while(queue.length){const at=queue.pop();if(visited.has(at))continue;visited.add(at);const n=p.nodes.find(n=>n.id===at);if(n)queue.push(...edges(p,n))}p.nodes.forEach((n,i)=>{if(!visited.has(n.id))warnings.push('第 '+(i+1)+' 节：无法从开头到达。')});const indegree=new Map([...visited].map(x=>[x,0]));for(const n of p.nodes)if(visited.has(n.id))for(const e of edges(p,n))if(indegree.has(e))indegree.set(e,indegree.get(e)+1);const q=[...indegree].filter(([,v])=>v===0).map(([k])=>k);let count=0;while(q.length){const at=q.pop();count++;const n=p.nodes.find(n=>n.id===at);if(n)for(const e of edges(p,n))if(indegree.has(e)){indegree.set(e,indegree.get(e)-1);if(indegree.get(e)===0)q.push(e)}}if(count<visited.size)warnings.push('剧情存在可达循环；请确认玩家有退出循环的路径。');return {errors,warnings}}
 function makeNode(type='say'){return {id:id(),type,name:'',text:'',next:'',sceneMode:'inherit',layers:[],effects:[],...(type==='choice'?{options:[{text:'选项一',target:''},{text:'选项二',target:''}]}:{})}}
 function blank(){return {schema:3,id:id(),title:'未命名的故事',assets:[],nodes:[],presets:[]}}
 function sample(){const p=blank();p.title='晚风来信 · 局部分支示例';const a=makeNode(),b=makeNode('choice'),c=makeNode(),d=makeNode(),e=makeNode(),merge=makeNode(),end=makeNode('end');a.sceneMode='own';a.name='旁白';a.text='放学后的走廊，风把书页轻轻翻开。';b.name='澪';b.text='要不要一起走一段？';c.name='我';c.text='先去图书馆吧。我想给你看一本书。';d.name='我';d.text='绕操场走走？今天的晚风很舒服。';e.name='我';e.text='我们到门口等一等，看看天边的云。';merge.name='旁白';merge.text='聊着不同的话题，我们还是并肩走出了校门。';end.name='结局';end.text='这一次，选择改变了沿途的谈话，却没有改变共同的约定。';b.options=[{text:'去图书馆',target:c.id},{text:'绕操场走走',target:d.id},{text:'在门口看云',target:e.id}];c.next=d.next=e.next=merge.id;p.nodes=[a,b,c,d,e,merge,end];return p}
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
 function defaultLayer(a){
  const ratio=(a.width||1280)/(a.height||720);let w,h;
  if(a.kind==='bg'){if(ratio>16/9){h=100;w=100*ratio/(16/9)}else{w=100;h=100*(16/9)/ratio}}
  else{h=85;w=h*9/16*ratio;if(w>90){h*=90/w;w=90}}
  return {id:id(),asset:a.id,name:a.name,kind:a.kind,x:(100-w)/2,y:a.kind==='bg'?(100-h)/2:100-h,w,h,fit:'contain',opacity:100,hidden:false,locked:false,motion:'none'};
 }
 /* 追加图层：背景插在角色下面，角色压在背景上面。同素材可被多个图层复用。 */
 function appendAssetLayer(node,asset){
  const l=defaultLayer(asset);
  if(asset.kind==='bg'){const i=node.layers.findIndex(x=>x.kind==='char');node.layers.splice(i<0?node.layers.length:i,0,l)}
  else node.layers.push(l);
  return l;
 }
 return {clone,id,validate,migrate,scene,edges,analyze,makeNode,blank,sample,assetForImport,defaultLayer,appendAssetLayer};
}
if(typeof module!=='undefined')module.exports=createVNCore;
