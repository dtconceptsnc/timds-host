import {Files,DirectoryBackup,DirectoryBackupGateway} from '@cloudflare/sandbox';
import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {readTreeManifest,readTreeFile,persistContainerTree,sha256,transferFiles} from '../src/repository/file-trees.mjs';
import {dependencyCacheKey,INSTALL_FLAGS} from '../src/build/cache.mjs';
import {nativeBuildResult,unwrapNativeBuildResult,safeRequestDiagnostic} from '../src/requests/diagnostics.mjs';
export {DirectoryBackupGateway};
const ca='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const cleanEnv={HOME:'/tmp/home',NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:'/tmp/empty-global.npmrc',NPM_CONFIG_CACHE:'/tmp/npm-cache',NODE_EXTRA_CA_CERTS:ca};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=message=>Object.assign(new Error(message),{statusCode:409});
const outputText=result=>new TextDecoder().decode(result.stdout);
async function execute(container,args,options={}){const result=await(await container.exec(args,{cwd:'/workspace',env:cleanEnv,signal:AbortSignal.timeout(20*60_000),...options})).output();if(result.exitCode!==0)throw fail('Controlled container operation failed');return result;}
function assertInput(input){if(!uuid.test(input.sourceId||'')||!uuid.test(input.publicationId||'')||!input.files?.ref?.startsWith(`snapshots/${input.sourceId}/`))throw fail('Invalid build source identity');}
async function cleanup(container,storage,stage,tag,primary){
 let failure;
 try{stage('cleanup-alarm');await storage.deleteAlarm();}catch(error){failure=tag(error);}
 try{stage('cleanup-container');if(container.running)await container.destroy();}catch(error){failure??=tag(error);}
 // Keep the operation's diagnostic when cleanup also fails. Always attempt both.
 if(failure){if(!primary)throw failure;primary.cleanupDiagnostic=safeRequestDiagnostic(failure.requestDiagnostic);}
}
export class BuildOutbound extends WorkerEntrypoint {
 fetch(request){const url=new URL(request.url);if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password||url.port||!['GET','HEAD'].includes(request.method))return new Response('Forbidden',{status:403});const headers=new Headers(request.headers);headers.delete('authorization');headers.delete('cookie');return fetch(new Request(request,{headers,redirect:'manual'}));}
}
export class BuildDeny extends WorkerEntrypoint {fetch(){return new Response('Forbidden',{status:403});}}
export class DependencySandbox extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.serial=Promise.resolve();}
 prepare(input){const next=this.serial.then(()=>nativeBuildResult('native-build-dependencies',(stage,tag)=>this.run(input,stage,tag)));this.serial=next.catch(()=>{});return next;}
 async run({packageText,lockText},stage,tag){
  const container=this.ctx.container,files=new Files(container);let cache,primary;
  try{
   stage('start');container.start({image:container.images.build,instance:'standard-2',enableInternet:false});stage('lifetime');await container.setInactivityTimeout(20*60_000);await this.ctx.storage.setAlarm(Date.now()+20*60_000);
   stage('backup');
   const backup=new DirectoryBackup(container,this.ctx.exports.DirectoryBackupGateway,{binding:'SNAPSHOTS',prefix:'dependency-cache/objects/'});await backup.intercept();
   stage('outbound-binding');
   const outbound=this.ctx.exports.BuildOutbound({props:{}});stage('outbound-http');await container.interceptAllOutboundHttp(outbound);stage('outbound-https');await container.interceptOutboundHttps('*',outbound);
   stage('runtime');
   const runtime=JSON.parse(outputText(await execute(container,['node','-e','process.stdout.write(JSON.stringify({nodeVersion:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch}))'])));
   const key=await dependencyCacheKey({packageText,lockText,image:container.images.build,...runtime}),recordKey=`dependency-cache/records/${key}.json`;
   stage('cache-read');
   const existing=await this.env.SNAPSHOTS.get(recordKey);
   if(existing){const receipt=await existing.json();if(receipt.key!==key||receipt.image!==container.images.build||!receipt.backup?.sha256)throw fail('Dependency cache identity changed');return receipt;}
   stage('package-copy');await files.writeFile('/dependencies/package.json',packageText);await files.writeFile('/dependencies/package-lock.json',lockText);await execute(container,['chown','-R','1000:1000','/dependencies']);
   stage('install');
   await execute(container,['npm',...INSTALL_FLAGS],{cwd:'/dependencies',user:'1000'});
   // Freeze writers before the immutable archive; source scripts never ran.
   stage('archive');cache=await backup.backup({dir:'/dependencies/node_modules',name:key,signal:AbortSignal.timeout(10*60_000)});
   const receipt={version:1,key,image:container.images.build,runtime,backup:cache};
   stage('cache-write');
   const written=await this.env.SNAPSHOTS.put(recordKey,JSON.stringify(receipt),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
   if(!written){const winner=await this.env.SNAPSHOTS.get(recordKey);if(!winner)throw fail('Dependency cache commit unavailable');await backup.delete(cache);cache=null;return winner.json();}
   return receipt;
  }catch(error){primary=tag(error);throw primary;}finally{await cleanup(container,this.ctx.storage,stage,tag,primary);}
 }
 async alarm(){if(this.ctx.container?.running)await this.ctx.container.destroy();}
}
export class BuildSandbox extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.serial=Promise.resolve();}
 run(input){const next=this.serial.then(()=>nativeBuildResult('native-build',(stage,tag)=>this.execute(input,stage,tag)));this.serial=next.catch(()=>{});return next;}
 metadata(input){const next=this.serial.then(()=>nativeBuildResult('native-build-metadata',(stage,tag)=>this.executeMetadata(input,stage,tag)));this.serial=next.catch(()=>{});return next;}
 async executeMetadata(input,stage,tag){
  if(!uuid.test(input.sourceId||'')||!uuid.test(input.publicationId||'')||!['release-metadata','stamp'].includes(input.operation))throw fail('Invalid metadata operation');
  const container=this.ctx.container,files=new Files(container),bucket=this.env.SNAPSHOTS,trees={};let primary;
  try{
   stage('start');container.start({image:container.images.build,instance:'standard-2',enableInternet:false});stage('lifetime');await container.setInactivityTimeout(20*60_000);await this.ctx.storage.setAlarm(Date.now()+20*60_000);
   stage('outbound-binding');
   const deny=this.ctx.exports.BuildDeny({props:{}});stage('outbound-http');await container.interceptAllOutboundHttp(deny);stage('outbound-https');await container.interceptOutboundHttps('*',deny);
   for(const name of ['source',...(input.operation==='stamp'?['artifact']:['prior'])]){
    const tree=input[name];if(!tree?.ref?.startsWith(`snapshots/${input.sourceId}/`))throw fail('Metadata tree belongs to another source');
    stage('manifest');const manifest=await readTreeManifest(bucket,tree);trees[name]=manifest;stage('mkdir');await files.mkdir(`/input/${name}`,{recursive:true});
    stage('copy');await transferFiles(manifest.files,async(file,i)=>files.writeFile(`/input/${name}/${i}`,(await readTreeFile(bucket,tree,file)).body));
   }
   stage('control-input');
   await files.writeFile('/workspace/metadata-input.json',JSON.stringify({trees,sourceCommit:input.sourceCommit,systemId:input.systemId,preparedAt:input.preparedAt,note:input.note}));
   stage('control-exec');await execute(container,['node','/opt/timds/build-driver.mjs',input.operation]);
   stage('result');
   const result=await(await files.readFile('/workspace/metadata-result.json')).json();
   if(input.operation==='stamp')return result;
   stage('persist');return {version:result.version,files:await persistContainerTree(bucket,{sourceId:input.sourceId,operationId:input.publicationId,role:'release-metadata',manifest:result.manifest,readFile:index=>files.readFile(`/output/${index}`)})};
  }catch(error){primary=tag(error);throw primary;}finally{await cleanup(container,this.ctx.storage,stage,tag,primary);}
 }
 async execute(input,stage,tag){
  assertInput(input);stage('manifest');const bucket=this.env.SNAPSHOTS,manifest=await readTreeManifest(bucket,input.files),byPath=new Map(manifest.files.map(file=>[file.path,file]));
  const inputText=async name=>{const file=byPath.get(name);if(!file||file.mode==='120000')throw fail(`Build source requires regular ${name}`);return(await readTreeFile(bucket,input.files,file)).text();};
  const packageText=await inputText('package.json'),lockText=await inputText('package-lock.json');
  const selector=await sha256(new TextEncoder().encode(packageText+'\0'+lockText));
  stage('dependencies');const cache=await unwrapNativeBuildResult(this.ctx.exports.DependencySandbox.getByName(selector).prepare({packageText,lockText}),'dependencies');
  const container=this.ctx.container,files=new Files(container);let primary;
  try{
   stage('start');container.start({image:container.images.build,instance:'standard-2',enableInternet:false});stage('lifetime');await container.setInactivityTimeout(20*60_000);await this.ctx.storage.setAlarm(Date.now()+20*60_000);
   stage('backup');
   const backup=new DirectoryBackup(container,this.ctx.exports.DirectoryBackupGateway,{binding:'SNAPSHOTS',prefix:'dependency-cache/objects/'});await backup.intercept();
   stage('outbound-binding');const deny=this.ctx.exports.BuildDeny({props:{}});stage('outbound-http');await container.interceptAllOutboundHttp(deny);stage('outbound-https');await container.interceptOutboundHttps('*',deny);
   // A cached directory is data only. SDK verifies archive SHA before swap and
   // revokes its one-object read grant before any source program can execute.
   stage('restore');await backup.restore(cache.backup,{dir:'/work/node_modules',signal:AbortSignal.timeout(10*60_000)});
   stage('source');
   const links=manifest.files.filter(file=>file.mode==='120000');
   for(const file of manifest.files){if(file.path==='node_modules'||file.path.startsWith('node_modules/')||links.some(link=>file.path.startsWith(link.path+'/')))throw fail('Build source shadows dependency or link paths');}
   await transferFiles(manifest.files.filter(file=>file.mode!=='120000'),async file=>{
    const slash=file.path.lastIndexOf('/'),parent=slash<0?'':file.path.slice(0,slash);if(parent)await files.mkdir('/work/'+parent,{recursive:true});
    const object=await readTreeFile(bucket,input.files,file);await files.writeFile('/work/'+file.path,object.body);if(file.mode==='100755')await execute(container,['chmod','755','/work/'+file.path]);
   });
   stage('links');for(const file of links){const target=await(await readTreeFile(bucket,input.files,file)).text();let depth=file.path.split('/').length-1;if(!target||target.startsWith('/')||/[\\\x00-\x1f]/.test(target))throw fail('Unsafe source link');for(const part of target.split('/')){if(part==='..'){if(--depth<0)throw fail('Source link leaves workspace');}else if(part&&part!=='.')depth++;}const slash=file.path.lastIndexOf('/'),parent=slash<0?'':file.path.slice(0,slash);if(parent)await files.mkdir('/work/'+parent,{recursive:true});await execute(container,['ln','-s','--',target,'/work/'+file.path]);}
   await execute(container,['node','/opt/timds/build-driver.mjs','validate-links']);
   stage('ownership');await execute(container,['chown','-R','1000:1000','/work']);
   stage('check');
   const result=await(await container.exec(['node','/opt/timds/build-driver.mjs','check'],{cwd:'/work',user:'1000',env:cleanEnv,signal:AbortSignal.timeout(20*60_000),stdout:'ignore',stderr:'ignore'})).output();
   // Source subprocesses cannot race artifact validation/streaming afterward.
   stage('stop-writers');await container.exec(['pkill','-KILL','-u','1000'],{stdout:'ignore',stderr:'ignore'}).then(process=>process.output());
   stage('result');
   if(result.exitCode!==0){let label='workspace';try{if((await files.stat('/work/.timds-check-result.json')).size>4096)throw new Error('Invalid check metadata');const report=await(await files.readFile('/work/.timds-check-result.json')).json();if(['token_reference','token_cycle','media_reference','artifact_reference'].includes(report.check))label=report.check;}catch{}throw fail(`Isolated publication ${label} check failed`);}
   await execute(container,['node','/opt/timds/build-driver.mjs','manifest']);
   const artifactManifest=await(await files.readFile('/workspace/artifact-manifest.json')).json();
   stage('persist');const artifact=await persistContainerTree(bucket,{sourceId:input.sourceId,operationId:input.publicationId,role:'build-artifact',manifest:artifactManifest,artifact:true,readFile:index=>files.readFile('/work/dist/'+artifactManifest.files[index].path)});
   return{files:artifact,cacheKey:cache.key,checks:{workspace:true,tokenReferences:true,mediaReferences:true,artifactReferences:true}};
  }catch(error){primary=tag(error);throw primary;}finally{await cleanup(container,this.ctx.storage,stage,tag,primary);}
 }
 async alarm(){if(this.ctx.container?.running)await this.ctx.container.destroy();}
}
