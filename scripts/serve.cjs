'use strict';
// Development server: loopback only, no dependencies, serves dist/ only.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=fs.realpathSync(path.resolve(__dirname,'../dist'));
const args=process.argv.slice(2),index=args.indexOf('--port');
if(args.length&&!(args.length===2&&index===0)){console.error('Usage: node scripts/serve.cjs [--port 4173]');process.exit(1)}
const port=index<0?4173:Number(args[index+1]);
if(!Number.isInteger(port)||port<1||port>65535){console.error('Port must be an integer from 1 to 65535.');process.exit(1)}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
function reply(res,status,message){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end(message)}
const server=http.createServer((req,res)=>{
 if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return reply(res,405,'Method not allowed')}
 let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname)}catch{return reply(res,400,'Invalid path')}
 if(pathname.includes('\0')||pathname.includes('\\'))return reply(res,400,'Invalid path');
 let file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
 if(!file.startsWith(root+path.sep))return reply(res,403,'Forbidden');
 fs.realpath(file,(err,real)=>{
  if(err)return reply(res,404,'Not found');
  if(!real.startsWith(root+path.sep))return reply(res,403,'Forbidden');
  fs.stat(real,(err,stat)=>{
   if(err||!stat.isFile())return reply(res,404,'Not found');
   res.writeHead(200,{'Content-Type':types[path.extname(real).toLowerCase()]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   if(req.method==='HEAD')return res.end();
   const stream=fs.createReadStream(real);stream.on('error',()=>res.destroy());stream.pipe(res);
  });
 });
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Port is in use. Try: node scripts/serve.cjs --port 4174':e.message);process.exitCode=1});
server.listen(port,'127.0.0.1',()=>console.log('\nPaper VN Studio v0.3\nOpen: http://127.0.0.1:'+port+'/\nCtrl+C to stop.\nBrowser drafts belong to this local origin; import your downloaded project to transfer work.\n'));
