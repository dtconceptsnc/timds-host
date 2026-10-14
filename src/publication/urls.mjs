import { publicSystemUrls } from '../public/index.mjs';
export function publicUrls(env,source,version){
 const {root,version:release}=publicSystemUrls(env.TIMDS_PUBLIC_ORIGIN,source.system_id,version);
 return{root,version:release};
}
// Project published response locations without changing the retained receipt.
export function publishedResult(result,publicOrigin,source){
 if(result?.status!=='published'||!result.version)return result;
 const {root,version}=publicSystemUrls(publicOrigin,source.system_id,result.version);
 return {...result,publicRoot:root,versionedUrls:{root:version,llmsTxt:`${version}llms.txt`,bundleJson:`${version}bundle.json`,artifact:`${version}.timds-artifact.json`},...(Object.hasOwn(result,'url')?{url:version}:{})};
}
