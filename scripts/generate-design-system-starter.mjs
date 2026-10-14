#!/usr/bin/env node
// Reproduce the hosted starter using its locked toolkit, then compare every byte.
// Local temporary directories only; no host credentials or cloud resources.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,readlink,lstat,writeFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {starterSourceFiles} from '../src/lifecycle/starter-data.mjs';
import {prepareCfPreviewFiles,previewSourcePins} from '../src/preview/source.mjs';
import {assetDigests,verifyAssetDigests} from './prepare-preview-source.mjs';

const outputPath=fileURLToPath(new URL('../src/lifecycle/starter-data.mjs',import.meta.url));
const json=value=>`${JSON.stringify(value,null,2)}\n`;
const sourceFile=name=>starterSourceFiles.find(file=>file.path===name);
const run=(cwd,command,args)=>{
  const result=spawnSync(command,args,{cwd,stdio:'inherit',env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${command} failed (${result.status})`);
};

async function collect(root) {
  const files=[];
  async function visit(directory,relative='') {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const name=path.posix.join(relative,entry.name),absolute=path.join(directory,entry.name);
      if(['dist','node_modules','.cloudflare','.vite'].includes(entry.name))continue;
      if(entry.isDirectory())await visit(absolute,name);
      else if(entry.isSymbolicLink())files.push({path:name,mode:'120000',content:await readlink(absolute)});
      else if(entry.isFile())files.push({path:name,mode:((await lstat(absolute)).mode&0o111)?'100755':'100644',content:await readFile(absolute,'utf8')});
      else throw new Error(`Unsupported scaffold entry: ${name}`);
    }
  }
  await visit(root);
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

async function generate({write=false}={}) {
  const temporary=await mkdtemp(path.join(tmpdir(),'timds-starter-proof-'));
  try {
    const toolchain=path.join(temporary,'toolchain'),root=path.join(temporary,'timds-example');
    await mkdir(toolchain);
    for(const name of ['package.json','package-lock.json'])await writeFile(path.join(toolchain,name),sourceFile(name).content);
    run(toolchain,'npm',['ci','--ignore-scripts','--no-audit','--no-fund']);
    const toolkit=path.join(toolchain,'node_modules/@dtconcepts/timds');
    assert.equal(JSON.parse(await readFile(path.join(toolkit,'package.json'),'utf8')).version,previewSourcePins['@dtconcepts/timds']);
    run(toolchain,process.execPath,[path.join(toolkit,'bin/timds.mjs'),'init','--root',root,'--standalone','--provider','hosted','--portal-url','https://host.example.com','--system-id','example/core','--name','Example core']);
    const inputs=await Promise.all(['timds.json','package.json','wrangler.jsonc','.gitignore','scripts/build.mjs','scripts/check.mjs'].map(async name=>({path:name,mode:'100644',encoding:'base64',content:(await readFile(path.join(root,name))).toString('base64')})));
    const plan=prepareCfPreviewFiles(inputs,{workerName:'timds-example'});
    for(const file of plan.changedFiles)await writeFile(path.join(root,file.path),Buffer.from(file.content,'base64'));
    for(const name of plan.deletedPaths)await unlink(path.join(root,name));
    const manifest=JSON.parse(await readFile(path.join(root,'timds.json'),'utf8')),previousVersion=manifest.version;
    manifest.version='2026.10.13-1';manifest.media.portalUrl=manifest.provider.url;
    await writeFile(path.join(root,'timds.json'),json(manifest));
    const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    pkg.name='timds-example';pkg.version=manifest.version;pkg.type='module';
    await writeFile(path.join(root,'package.json'),json(pkg));
    assert.deepEqual(pkg,JSON.parse(sourceFile('package.json').content),'Keep revision 1 dependency pins immutable');
    await writeFile(path.join(root,'package-lock.json'),sourceFile('package-lock.json').content);
    await writeFile(path.join(root,'CHANGELOG.md'),(await readFile(path.join(root,'CHANGELOG.md'),'utf8')).replace(`## ${previousVersion}`,`## ${manifest.version}`));
    const files=await collect(root);
    if(!write)assert.deepEqual(files,starterSourceFiles,'Generated starter differs; review changes as a new starter revision');
    run(root,'npm',['ci','--ignore-scripts','--no-audit','--no-fund']);
    run(root,'npm',['run','build:preview']);
    const assets=await assetDigests(path.join(root,'dist'));
    run(root,'npx',['--no-install','cf','build']);
    verifyAssetDigests(assets,await assetDigests(path.join(root,'dist')));
    verifyAssetDigests(assets,await assetDigests(path.join(root,plan.verification.assetDirectory)));
    if(write)await writeFile(outputPath,`// Generated from @dtconcepts/timds 0.1.464 by scripts/generate-design-system-starter.mjs.\n// Immutable starter revision 1. Keep old revisions available for creation retries.\nexport const starterSourceFiles=Object.freeze(${JSON.stringify(files,null,2)});\n`);
    console.log(json({fileCount:files.length,assetCount:Object.keys(assets).length,reproducible:true,allPackagedAssetsByteIdentical:true,cloudDeploymentPerformed:false}));
  } finally {await rm(temporary,{recursive:true,force:true});}
}

try {
  const args=process.argv.slice(2);
  if(args.length&&(args.length!==1||args[0]!=='--write'))throw new Error('Usage: node scripts/generate-design-system-starter.mjs [--write]');
  await generate({write:args[0]==='--write'});
} catch(error) {console.error(error.message);process.exitCode=1;}
