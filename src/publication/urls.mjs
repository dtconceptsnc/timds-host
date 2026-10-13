export function publicUrls(env,source,version){
 const origin=new URL(env.TIMDS_PUBLIC_ORIGIN||env.HOST_ORIGIN);if(origin.protocol!=='https:'&&origin.hostname!=='localhost')throw new Error('Public host origin must be HTTPS');
 const root=source.public_root_url?new URL(source.public_root_url).href.replace(/\/?$/,'/'):`${origin.origin}/systems/${encodeURIComponent(source.system_id)}/`;
 return{root,version:`${root}v/${encodeURIComponent(version)}/`};
}
