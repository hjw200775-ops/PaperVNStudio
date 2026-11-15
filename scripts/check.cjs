'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const checks=[...['app.js','core.js','effects.js','player.js'].map(f=>['--check','dist/'+f]),['--check','scripts/serve.cjs'],['tests/core.test.cjs'],['tests/effects.test.cjs']];
for(const args of checks){console.log('\n> node '+args.join(' '));const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(r.error){console.error(r.error.message);process.exit(1)}if(r.status!==0)process.exit(r.status||1)}
console.log('\nAll source checks passed. Windows desktop packaging still requires local testing.');
