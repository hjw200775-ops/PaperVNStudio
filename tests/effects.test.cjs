const assert=require('node:assert/strict'),C=require('../dist/core.js')(),F=require('../dist/effects.js')();
const p=C.sample(),[first,choice,a,b,,merge]=p.nodes,L='actor';first.layers=[{id:L}];
const e=F.make('fx',L,'scale');e.duration=1;e.easing='linear';e.to=140;first.effects=[e];
assert.equal(F.frame(p,C,first.id,[],0)[L].scale,100);assert.equal(F.frame(p,C,first.id,[],.5)[L].scale,120);assert.equal(F.frame(p,C,first.id,[],1)[L].scale,140);
// Sentence effects disappear after advancing, even if advanced midway.
assert.equal(F.frame(p,C,choice.id,[first.id])[L],undefined);
e.policy='hold';assert.equal(F.frame(p,C,choice.id,[first.id])[L].scale,140);
e.policy='auto';e.returnDuration=1;assert.equal(F.frame(p,C,first.id,[],1.5)[L].scale,120);assert.equal(F.frame(p,C,first.id,[],Infinity)[L].scale,100);assert.equal(F.frame(p,C,choice.id,[first.id])[L],undefined);
// Delay, zero-duration and disabled effects are deterministic.
e.delay=.5;assert.equal(F.frame(p,C,first.id,[],.25)[L].scale,100);e.duration=0;e.returnDuration=0;assert.equal(F.frame(p,C,first.id,[],Infinity)[L].scale,100);e.enabled=false;assert.equal(F.frame(p,C,first.id,[],1)[L],undefined);
// Carry only the chosen route's held effect at a branch merge.
first.effects=[];a.effects=[{...F.make('a',L,'blur'),to:8,policy:'hold'}];b.effects=[{...F.make('b',L,'blur'),to:20,policy:'hold'}];assert.equal(F.frame(p,C,merge.id,[first.id,choice.id,a.id])[L].blur,8);assert.equal(F.frame(p,C,merge.id,[first.id,choice.id,b.id])[L].blur,20);
// Independent scenes explicitly reset carried effects.
merge.sceneMode='own';assert.equal(F.frame(p,C,merge.id,[first.id,choice.id,b.id])[L],undefined);
// Auto-from restoration starts at inherited state rather than a hardcoded 100%.
merge.sceneMode='inherit';const reset=F.make('reset',L,'blur');reset.to=0;reset.duration=1;reset.easing='linear';reset.policy='hold';merge.effects=[reset];assert.equal(F.frame(p,C,merge.id,[first.id,choice.id,a.id],.5)[L].blur,4);
const move=F.make('move',L,'move');move.to=10;move.toY=-10;move.duration=1;move.easing='linear';first.effects=[move];assert.equal(F.frame(p,C,first.id,[],.5)[L].x,5);assert.equal(F.frame(p,C,first.id,[],.5)[L].y,-5);
assert.doesNotThrow(()=>F.validate([move]));assert.throws(()=>F.validate([move,{...move,id:'dup'}]));assert.throws(()=>F.validate([{...move,duration:NaN}]));
const old=C.clone(p);old.schema=2;old.nodes.forEach(n=>delete n.effects);const upgraded=C.migrate(old);assert.equal(upgraded.schema,4);upgraded.nodes.forEach(n=>assert.deepEqual(n.effects,[]));
const cached=F.before(p,C,merge.id,[first.id,choice.id,a.id]);const oldCached=JSON.stringify(cached);assert.deepEqual(F.frame(p,C,merge.id,[first.id,choice.id,a.id],.2,cached),F.frame(p,C,merge.id,[first.id,choice.id,a.id],.2));assert.equal(JSON.stringify(cached),oldCached);
console.log('PASS: effect interpolation, delays, holds, sentence and auto restoration, branching, scene reset, auto-from, move, validation, v2 migration');
