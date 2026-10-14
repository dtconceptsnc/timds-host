import { randomUUID } from 'node:crypto';
import { persistContainerTree, sha256 } from '../src/repository/file-trees.mjs';

export async function publishedFixture({storageBucket}={}) {
  const objects=new Map(),encoder=new TextEncoder();
  const bytes=async body=>new Uint8Array(await new Response(body).arrayBuffer());
  const bucket=storageBucket||{
    async put(key,body,options={}){if(objects.has(key)&&options.onlyIf?.etagDoesNotMatch==='*')return null;objects.set(key,{data:await bytes(body),...options});return {};},
    async head(key){const row=objects.get(key);return row?{size:row.data.length,customMetadata:row.customMetadata}:null;},
    async get(key){const row=objects.get(key);if(!row)return null;return {size:row.data.length,customMetadata:row.customMetadata,body:new Response(row.data).body,text:async()=>new TextDecoder().decode(row.data),arrayBuffer:async()=>row.data.slice().buffer};},
  };
  const source={id:randomUUID(),system_id:'example/core',name:'Example',published_version:'1.0.0'},versions=new Map();
  for(const label of ['1.0.0','2.0.0']) {
    const commit=(label==='1.0.0'?'a':'b').repeat(40),id=randomUUID();
    const files={
      'docs/index.html':`<!doctype html><script>document.title=${JSON.stringify(label)}</script><p>${label}</p>`,
      'docs/style.css':'@font-face{font-family:Exact;src:url(../font.woff2)}\n',
      'docs/index.json':JSON.stringify({pages:[{id:'brand/voice',title:'Brand voice',url:'/brand/voice',view:'brand',blocks:[{id:'brand/voice#tone',title:'Tone',intro:`Guidance ${label}`,specs:[],notes:[],code:[],assets:[],prose:[]}]}]}),
      'docs/tokens.json':JSON.stringify({count:2,kinds:{color:1,length:1},roles:{'color.primary':'--brand'},tokens:[{name:'--brand',value:'#abc',resolved:'#aabbcc',kind:'color',selector:':root',base:true,source:'styles.css'},{name:'--space',value:'1rem',resolved:'1rem',kind:'length',selector:'.panel',base:false}]}),
      'docs/llms.txt':`Example ${label}\n`,
      'docs/bundle.json':JSON.stringify({schemaVersion:1,system:{id:source.system_id,name:'Example',version:label},fileCount:1,bytes:6,files:[{path:'style.css',bytes:6,sha256:'0'.repeat(64)}]}),
      'font.woff2':new Uint8Array([0,255,5,6,128,10]),
    };
    const entries=await Promise.all(Object.entries(files).map(async([path,value])=>{const data=typeof value==='string'?encoder.encode(value):value;return {path,data,sha256:await sha256(data),size:data.length,mode:'100644'};}));
    const manifest={version:1,totalBytes:entries.reduce((total,file)=>total+file.size,0),files:entries.map(({data,...file})=>file)};
    const tree=await persistContainerTree(bucket,{sourceId:source.id,operationId:id,role:'artifact',artifact:true,manifest,readFile:async index=>new Response(entries[index].data)});
    const stamp={schemaVersion:1,systemId:source.system_id,version:label,sourceCommit:commit,contentDigest:tree.digest,entry:'docs/index.html',files:{index:'docs/index.json',tokens:'docs/tokens.json',brand:'docs/brand.json',llms:'docs/llms.txt',llmsFull:'docs/llms-full.txt',formats:'docs/formats.json',designs:'docs/designs.json',changelog:'docs/changelog.json',bundle:'docs/bundle.json'}};
    versions.set(label,{id,source_id:source.id,version_label:label,source_commit:commit,content_digest:tree.digest,artifact_ref:tree.ref,stamp,artifact:{entryPath:'docs/index.html',fileCount:entries.length,totalBytes:manifest.totalBytes}});
  }
  let current='1.0.0';let unavailable=false;let resolutions=0;
  const resolvePublished=async(systemId,label)=>{resolutions++;if(unavailable)throw new Error('private R2 key secret');const version=versions.get(label||current);if(systemId!==source.system_id||!version)throw Object.assign(new Error('Published version not found'),{statusCode:404});return {source:{...source,published_version:current},version};};
  return {bucket,objects,source,versions,resolvePublished,publish:label=>{current=label;},unavailable:value=>{unavailable=value;},resolutions:()=>resolutions};
}
