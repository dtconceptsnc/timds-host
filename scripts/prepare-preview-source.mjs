#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir,readFile,writeFile,unlink,lstat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareCfPreviewFiles,previewSourcePins} from '../src/preview/source.mjs';

export async function assetDigests(root) {
  const files={};
  async function visit(directory,relative='') {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const name=relative?`${relative}/${entry.name}`:entry.name,absolute=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw new Error(`Refusing symlink in build output: ${name}`);
      if(entry.isDirectory())await visit(absolute,name);
      else if(entry.isFile())files[name]=createHash('sha256').update(await readFile(absolute)).digest('hex');
      else throw new Error(`Unsupported build output entry: ${name}`);
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}

export function verifyAssetDigests(expected,actual) {
  assert.ok(Object.keys(expected).length>0,'Toolkit output must not be empty');
  assert.deepEqual(actual,expected,'cf must preserve every toolkit output path and byte without additional assets');
}

async function sourceInputs(root) {
  const rootNames=(await readdir(root,{withFileTypes:true})).map(entry=>entry.name);
  const names=[...rootNames.filter(name=>['package.json','package-lock.json','timds.json','.gitignore','index.html','wrangler.jsonc'].includes(name)||/^(vite\.config\.|cloudflare\.config\.|wrangler\.)/.test(name)),'scripts/build.mjs','scripts/check.mjs'];
  return Promise.all(names.map(async name=>{
    const absolute=path.join(root,name),stat=await lstat(absolute);
    if(!stat.isFile())throw new Error(`Source conversion input must be a regular file: ${name}`);
    return{path:name,encoding:'base64',content:(await readFile(absolute)).toString('base64'),mode:(stat.mode&0o111)?'100755':'100644'};
  }));
}

export async function preparePreviewSource({source,workerName,apply=false,receiptPath,run}={}) {
  if(!path.isAbsolute(source||''))throw new Error('--source must be an explicit absolute path');
  const root=path.resolve(source);
  if(!(await lstat(root)).isDirectory())throw new Error('--source must name a regular directory, not a symlink');
  const plan=prepareCfPreviewFiles(await sourceInputs(root),{workerName});
  if(!apply)return{source:root,workerName,changedPaths:plan.changedFiles.map(file=>file.path),deletedPaths:plan.deletedPaths,pins:plan.pins,verification:plan.verification};
  // These commands operate only on the explicitly selected disposable/reviewed
  // source tree. No cloud provisioning or deployment is performed.
  const execute=run||((command,args)=>{
    const result=spawnSync(command,args,{cwd:root,stdio:'inherit',env:process.env});
    if(result.error)throw result.error;
    if(result.status!==0)throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
  });
  for(const file of plan.changedFiles)await writeFile(path.join(root,file.path),Buffer.from(file.content,'base64'));
  for(const name of plan.deletedPaths)await unlink(path.join(root,name));
  await execute('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
  const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
  for(const [name,version] of Object.entries(previewSourcePins))assert.equal(lock.packages?.[`node_modules/${name}`]?.version,version,`npm must resolve the exact ${name} pin`);
  assert.equal(lock.packages?.['node_modules/wrangler'],undefined,'The static Preview build must not retain Wrangler');
  await execute('npm',['run','build:preview']);
  const before=await assetDigests(path.join(root,'dist'));
  await execute('npx',['--no-install','cf','build']);
  verifyAssetDigests(before,await assetDigests(path.join(root,'dist')));
  const output=await assetDigests(path.join(root,plan.verification.assetDirectory));
  verifyAssetDigests(before,output);
  const config=JSON.parse(await readFile(path.join(root,'.cloudflare/output/v0/workers/default/worker.config.json'),'utf8'));
  assert.equal(config.name,workerName,'cf must package the explicitly selected Worker');
  assert.equal(config.entrypoint,undefined,'The prepared Preview must remain an assets-only Worker');
  const receipt={schemaVersion:1,recordedAt:new Date().toISOString(),workerName,pins:plan.pins,commands:['npm install --ignore-scripts --no-audit --no-fund','npm run build:preview','npx --no-install cf build'],assetDirectory:plan.verification.assetDirectory,assetCount:Object.keys(before).length,assetsSha256:before,packageLockSha256:createHash('sha256').update(await readFile(path.join(root,'package-lock.json'))).digest('hex'),workerConfig:config,distUnchanged:true,allPackagedAssetsByteIdentical:true,cloudDeploymentPerformed:false};
  const destination=receiptPath||path.join(root,'.cloudflare/preview-source-proof.json');
  if(!path.isAbsolute(destination))throw new Error('--receipt must be an absolute path');
  await mkdir(path.dirname(destination),{recursive:true});
  await writeFile(destination,`${JSON.stringify(receipt,null,2)}\n`);
  return{source:root,workerName,assetCount:receipt.assetCount,allPackagedAssetsByteIdentical:true,receiptPath:destination};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),options={};
    for(let index=0;index<args.length;index++) {
      const arg=args[index];
      if(arg==='--apply')options.apply=true;
      else if(['--source','--worker','--receipt'].includes(arg)&&args[index+1]&&!args[index+1].startsWith('--'))options[{'--source':'source','--worker':'workerName','--receipt':'receiptPath'}[arg]]=args[++index];
      else throw new Error('Usage: node scripts/prepare-preview-source.mjs --source /absolute/standalone --worker timds-<source-id-without-hyphens> [--apply] [--receipt /absolute/proof.json]');
    }
    console.log(JSON.stringify(await preparePreviewSource(options),null,2));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
