const assert=require('node:assert/strict'),C=require('../dist/core.js')();
const p=C.sample();assert(C.validate(p));assert.equal(p.nodes[1].options.length,3);assert.deepEqual(C.analyze(p),{errors:[],warnings:[]});
// All three temporary branches rejoin the same story, rather than ending it.
for(const o of p.nodes[1].options){const n=p.nodes.find(n=>n.id===o.target);assert.equal(n.type,'say');assert.equal(n.next,p.nodes[5].id)}
// Runtime inheritance follows the actual path; editor preview follows order.
const a={id:'a',asset:'asset',name:'A',kind:'bg',x:0,y:0,w:100,h:100,fit:'contain',opacity:100,hidden:false,locked:false,motion:'none'};
p.nodes[0].layers=[a];p.nodes[2].sceneMode='own';p.nodes[2].layers=[{...a,id:'branch',name:'branchA'}];p.nodes[3].sceneMode='own';p.nodes[3].layers=[{...a,id:'other',name:'branchB'}];
assert.equal(C.scene(p,p.nodes[5].id,[p.nodes[0].id,p.nodes[1].id,p.nodes[2].id])[0].name,'branchA');assert.equal(C.scene(p,p.nodes[5].id,[p.nodes[0].id,p.nodes[1].id,p.nodes[3].id])[0].name,'branchB');
// Copy-on-edit does not mutate source layers.
const copy=C.clone(C.scene(p,p.nodes[5].id));copy[0].x=30;assert.equal(p.nodes[3].layers[0].x,0);
const old={schema:1,title:'legacy',assets:[],nodes:[{id:'old',type:'say',name:'a',text:'b',bg:'bg',char:'char',align:'left',scale:85,motion:'breathe',next:''}]};const migrated=C.migrate(old);assert(C.validate(migrated));assert.equal(migrated.nodes[0].layers.length,2);assert.equal(migrated.nodes[0].layers[1].motion,'breathe');assert.equal(old.schema,1);
const invalid=C.clone(p);invalid.nodes[0].layers[0].w=NaN;assert.throws(()=>C.validate(invalid));
const broken=C.sample();broken.nodes[1].options[0].target='deleted';assert(C.analyze(broken).errors.length>0);const cycle=C.sample();cycle.nodes[5].next=cycle.nodes[1].id;assert(C.analyze(cycle).warnings.some(x=>x.includes('循环')));
console.log('PASS: validation, v1 migration, three-way merging, path-dependent scene inheritance, copy isolation, missing targets and cycles');
