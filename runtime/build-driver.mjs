// Image-baked trusted control program. Source code runs only in `check`, as uid1000.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkWorkspace,loadWorkspace} from '/opt/timds/node_modules/@dtconcepts/timds/src/core.mjs';
import {prepareMergeRelease} from '/opt/timds/node_modules/@dtconcepts/timds/templates/starter/scripts/prepare-merge-release.mjs';
import {createPublicationStampFromFiles} from '/opt/timds/node_modules/@dtconcepts/timds/src/publication-snapshot.mjs';
import {derivedLayerPaths} from '/opt/timds/node_modules/@dtconcepts/timds/src/derived.mjs';
const command=process.argv[2];
if(command==='check'){
 try{await checkWorkspace('/work');}
 catch(error){const message=String(error?.message||'');const check=message.startsWith('Unknown token reference ')?'token_reference':message.startsWith('Cyclic token reference ')?'token_cycle':message.startsWith('Unknown media reference ')?'media_reference':message.startsWith('design-system/dist contains broken local references:')?'artifact_reference':'workspace';await fs.writeFile('/work/.timds-check-result.json',JSON.stringify({ok:false,check}));process.exitCode=1;}
}else if(command==='validate-links'){
 async function visit(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=path.join(dir,entry.name);if(entry.isSymbolicLink()){const resolved=await fs.realpath(name);if(!resolved.startsWith('/work/'))throw new Error('Source link leaves workspace');}else if(entry.isDirectory())await visit(name);}}
 await visit('/work');
}else if(command==='manifest'){
 const workspace=await loadWorkspace('/work',{editing:true}),artifactDirectory=workspace.layout==='standalone'?'dist':workspace.layout==='embedded'?'design-system/dist':null;
 const artifactRoot=artifactDirectory&&path.join('/work',artifactDirectory);
 if(workspace.repoRoot!=='/work'||!artifactDirectory||artifactRoot!==path.join(workspace.designSystemRoot,'dist')||await fs.realpath(workspace.designSystemRoot)!==workspace.designSystemRoot)throw new Error('Unsupported artifact workspace layout');
 const files=[];let totalBytes=0;
 async function visit(relative=''){
  const target=path.join(artifactRoot,relative),stat=await fs.lstat(target);
  if(stat.isSymbolicLink())throw new Error('Artifact contains a symbolic link');
  if(stat.isDirectory()){for(const name of (await fs.readdir(target)).sort())await visit(relative?`${relative}/${name}`:name);return;}
  if(!stat.isFile()||!relative||/[\\\x00-\x1f\x7f]/.test(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Artifact contains an unsafe file');
  totalBytes+=stat.size;if(stat.size>12_000_000||totalBytes>80_000_000||files.length>=2000)throw new Error('Artifact exceeds size limit');
  const bytes=await fs.readFile(target);files.push({path:relative,mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 await visit();if(files.some(file=>file.path==='.timds-artifact.json'))throw new Error('Artifact contains reserved stamp');
 await fs.writeFile('/workspace/artifact-manifest.json',JSON.stringify({artifactDirectory,version:1,files,totalBytes}));
}else if(command==='release-metadata'||command==='stamp'){
 const input=JSON.parse(await fs.readFile('/workspace/metadata-input.json','utf8'));
 const load=async name=>Promise.all(input.trees[name].files.map(async(file,i)=>({...file,content:await fs.readFile(`/input/${name}/${i}`)})));
 const source=await load('source');
 if(command==='release-metadata'){
  const prior=await load('prior');
  const text=(files,name)=>{const file=files.find(file=>file.path===name);if(!file)throw new Error('Required release source file unavailable');return file.content.toString('utf8');};
  const release=prepareMergeRelease({now:new Date(input.preparedAt),previousVersion:JSON.parse(text(prior,'timds.json')).version,timdsJson:text(source,'timds.json'),packageJson:text(source,'package.json'),packageLock:text(source,'package-lock.json'),changelog:text(source,'CHANGELOG.md'),fallbackNote:input.note||'Publish submitted Design System changes.'});
  const files=[];let totalBytes=0;await fs.mkdir('/output',{recursive:true});
  for(const [name,content] of Object.entries(release.files||{})){const bytes=Buffer.from(content);await fs.writeFile(`/output/${files.length}`,bytes);totalBytes+=bytes.length;files.push({path:name,mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  await fs.writeFile('/workspace/metadata-result.json',JSON.stringify({version:release.version,manifest:{version:1,totalBytes,files}}));
 }else{
  const artifacts=await load('artifact');
  const manifest=JSON.parse(source.find(file=>file.path==='timds.json').content.toString('utf8'));
  const entryPath=manifest.artifact?.entry||manifest.viewer?.entry||manifest.artifactEntry||'index.html';
  // Remote readers (toolkit `fetchDerivedLayer`, `timds mcp read --published`)
  // locate index.json, tokens.json and the rest from the stamp's entry and files.
  const stamp={...createPublicationStampFromFiles({sourceCommit:input.sourceCommit,sourceFiles:source,artifactFiles:artifacts,systemId:input.systemId}),entry:entryPath,files:derivedLayerPaths(entryPath)};
  await fs.writeFile('/workspace/metadata-result.json',JSON.stringify({stamp,artifact:{entryPath,fileCount:artifacts.length,totalBytes:artifacts.reduce((n,file)=>n+file.content.length,0)}}));
 }
}else throw new Error('Unknown controlled build command');
