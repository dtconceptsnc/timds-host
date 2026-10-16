const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const prefix='timds.studio.v1.';
// The sign-in ('token') and the registered OAuth client ('client') are shared by
// every Studio tab at this origin through localStorage; everything else, including
// the one-time PKCE transaction, is per tab in sessionStorage.
const shared=key=>key==='token'||key==='client';
const store=key=>shared(key)?localStorage:sessionStorage;
const read=(key,fallback=null)=>{try{return JSON.parse(store(key).getItem(prefix+key))??fallback;}catch{return fallback;}};
const save=(key,value)=>{try{store(key).setItem(prefix+key,JSON.stringify(value));}catch{}};
const remove=key=>{try{store(key).removeItem(prefix+key);}catch{}};
// Agents are the only writers. Studio directs them with Requests and decides with
// publish, rollback, close and invite; it never holds source files.
const state={token:read('token'),principal:null,systems:[],management:null,managementError:null,source:null,view:'overview',work:null,delivery:null,submissions:[],session:null,composer:{here:''},requestRows:[],generation:0,polling:false,requestPolling:false,polledAt:0,presence:[],routeHash:location.hash,waking:new Map(),conflicts:new Map(),resolving:new Set(),previews:new Set(),destructions:new Map(),directory:null,inviteChoice:'',studio:{filter:'all',width:'desktop'}};
const enc=value=>encodeURIComponent(value);
// The toolkit the Overview tells people to install; keep in step with package.json.
const TOOLKIT='@dtconcepts/timds@0.1.476';
const sourcePath=()=>`/api/timds/design-systems/${enc(state.source.id)}`;
const sessionPath=()=>`/api/timds/sessions/${enc(state.session.session.id)}`;
const short=value=>String(value||'').slice(0,8);
const date=value=>value?new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
const text=value=>typeof value==='string'?value:JSON.stringify(value,null,2);
function ago(value){const time=Date.parse(value||'');if(!Number.isFinite(time))return'';const seconds=Math.round((Date.now()-time)/1000);if(seconds<45)return'just now';if(seconds<3600)return`${Math.max(1,Math.round(seconds/60))} min ago`;if(seconds<86400)return`${Math.round(seconds/3600)} h ago`;return date(value);}
function node(tag,props={},...children){const element=document.createElement(tag);for(const [key,value]of Object.entries(props)){if(key==='class')element.className=value;else if(key.startsWith('on'))element.addEventListener(key.slice(2),value);else if(key==='text')element.textContent=value;else if(value!==undefined&&value!==null){if(key in element&&!key.startsWith('aria-'))element[key]=value;else element.setAttribute(key,value);}}for(const child of children.flat(Infinity))if(child!==null&&child!==undefined&&child!==false)element.append(child instanceof Node?child:document.createTextNode(String(child)));return element;}
const replaceContent=(element,...children)=>element.replaceChildren(...children.flat(Infinity).filter(child=>child!==null&&child!==undefined&&child!==false));
const title=(tag,value,props={})=>node(tag,{...props,text:value});
const button=(label,action,kind='')=>node('button',{type:'button',class:kind,onclick:event=>perform(event.currentTarget,action)},label);
const field=(label,control,hint='')=>node('div',{class:'field'},node('label',{htmlFor:control.id},label),control,hint?title('p',hint):null);
const empty=(heading,description)=>node('div',{class:'empty'},title('strong',heading),description);
const panel=(heading,...children)=>node('section',{class:'panel'},title('h2',heading),children);
const details=(label,value)=>node('details',{class:'details'},title('summary',label),title('pre',text(value),{class:'diff'}));
const statusClass=value=>['published','submitted','succeeded','open','ready','completed'].includes(value)?'success':['failed','dead_letter','error','conflicted'].includes(value)?'error':['queued','running','starting','submitting','closing','publishing','unknown','pending','waking','sending'].includes(value)?'warning':'';
const badge=value=>title('span',String(value||'pending').replaceAll('_',' '),{class:`badge ${statusClass(value)}`});
// Loading indicators: a spinner, a centred block for a page that is still
// opening, a line inside dialogs and frames, and a top progress bar while a
// user-visible load (sign-in, workspace, session) is in flight.
const spin=large=>node('span',{class:large?'spin large':'spin','aria-hidden':'true'});
const loadingBlock=(heading,detail='')=>node('div',{class:'loading-block',role:'status'},spin(true),title('strong',heading),detail?title('span',detail,{class:'muted'}):null);
const loadingLine=message=>node('p',{class:'loading-line',role:'status'},spin(false),message);
let inflight=0;
async function busy(work){inflight++;document.documentElement.setAttribute('data-busy','true');try{return await work;}finally{if(--inflight===0)document.documentElement.removeAttribute('data-busy');}}
// Patches skip a region only while someone is typing or choosing in it.
const editing=target=>{const active=document.activeElement;return Boolean(active&&target.contains(active)&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName));};
function safeUrl(value){try{const url=new URL(value);if(url.username||url.password||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))return null;return url.href;}catch{return null;}}
function link(label,value){const href=safeUrl(value);return href?node('a',{class:'button small',href,target:'_blank',rel:'noopener noreferrer'},label):null;}
function notice(message,error=false){const target=$('#notice');target.textContent=message;target.className=error?'error':'';target.hidden=false;clearTimeout(notice.timer);if(!error)notice.timer=setTimeout(()=>target.hidden=true,6500);}
async function perform(control,action){if(control.disabled)return;control.disabled=true;control.setAttribute('aria-busy','true');try{await action();}catch(error){notice(error.message||'This operation could not be completed.',true);}finally{control.disabled=false;control.removeAttribute('aria-busy');}}
async function responseJson(response){let body;try{body=await response.json();}catch{throw new Error('The host returned an unreadable response. Refresh status before retrying.');}if(!response.ok){const error=new Error(body.error_description||body.error||`The host returned HTTP ${response.status}`);error.status=response.status;throw error;}return body;}
// Humans cannot write: these session routes (snapshot pull, update, submit,
// claims) belong to agents and are refused before any request leaves the tab.
const agentOnly=/^\/api\/timds\/sessions\/[^/]+(?:\/(?:update|submit|claims))?$/;
function safeDeletionBlockers(value){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(!value||typeof value!=='object'||!uuid.test(value.sourceId||'')||!Number.isSafeInteger(value.total)||value.total<1||!Array.isArray(value.sessions))return null;
  const sessions=value.sessions.slice(0,50).filter(row=>row&&uuid.test(row.sessionId||'')&&['starting','open','closing','closed','expired'].includes(row.status)&&['missing_creation_receipt','fork_identity_changed'].includes(row.reason)&&['review_session','operator_review'].includes(row.action)).map(row=>({sessionId:row.sessionId,status:row.status,reason:row.reason,action:row.action==='review_session'&&row.reason==='missing_creation_receipt'&&['open','closing'].includes(row.status)?'review_session':'operator_review'}));
  return{sourceId:value.sourceId,total:Math.max(value.total,sessions.length),sessions};
}
// Sign-in lifetime. The access token lasts about an hour; the rotating refresh
// token (offline_access) renews it in the background for up to 30 days. The pair
// is shared by every Studio tab at this origin: a rotation or disconnect in one
// tab reaches the others through the storage event, and the newest issued pair
// wins so no tab posts a stale refresh token the host has already rotated away.
const renewAhead=5*60*1000,renewal={promise:null};
const newer=(candidate,current)=>Boolean(candidate?.refreshToken&&candidate.expiresAt>(current?.expiresAt??0));
function adoptToken(next){const stored=read('token');state.token=newer(stored,next)?stored:next;if(state.token===next)save('token',next);}
const signedIn=()=>Boolean(state.token&&(state.token.expiresAt>Date.now()||state.token.refreshToken));
function tokenResult(result){if(typeof result.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw new Error('The host did not return a valid sign-in');return{accessToken:result.access_token,expiresAt:Date.now()+result.expires_in*1000-10000,refreshToken:typeof result.refresh_token==='string'&&result.refresh_token?result.refresh_token:null};}
async function renew(token){
  // Another tab may have rotated the pair since this renewal was scheduled: use
  // its newer pair rather than burning the previous-token grace on a stale one.
  const stored=read('token');
  if(newer(stored,token)){state.token=token=stored;if(token.expiresAt-Date.now()>renewAhead)return;}
  const response=await fetch('/token',{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refreshToken,client_id:token.clientId,resource:`${location.origin}/api/timds`})});
  if(state.token!==token)return;
  if(!response.ok){
    // A 4xx means the host refused this refresh token (expired, revoked or rotated
    // away): keep the access token while it lasts, then ask the person to connect
    // again. A 5xx is transient; the next call retries with the same token.
    if(response.status<500)adoptToken({...token,refreshToken:null});
    return;
  }
  const result=await response.json().catch(()=>null);if(!result)throw new Error('unreadable');
  adoptToken({...tokenResult(result),clientId:token.clientId});
}
async function freshToken(){
  const token=state.token;
  if(token?.refreshToken&&token.clientId&&token.expiresAt-Date.now()<=renewAhead){renewal.promise??=renew(token).finally(()=>{renewal.promise=null;});try{await renewal.promise;}catch{}}
  if(!state.token||state.token.expiresAt<=Date.now()){disconnect(false);throw new Error('Your sign-in has expired. Connect again to continue.');}
  return state.token.accessToken;
}
async function api(route,body){
  if(!route.startsWith('/api/timds/')||route.includes('://'))throw new Error('Invalid API route');
  if(agentOnly.test(route.split('?')[0]))throw new Error('Studio does not edit source files. Send a Request and the agent makes the change.');
  const serialized=body===undefined?undefined:JSON.stringify({apiVersion:1,...body});
  const accessToken=await freshToken();
  const response=await fetch(route,{method:body===undefined?'GET':'POST',redirect:'error',credentials:'omit',cache:'no-store',
    ...(body===undefined?{signal:AbortSignal.timeout(45000)}:{}),
    headers:{Authorization:`Bearer ${accessToken}`,'X-TimDS-API-Version':'1',Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(serialized===undefined?{}:{body:serialized})});
  if(response.status===401){disconnect(false);throw new Error('Connect again to continue.');}
  const result=await response.json().catch(()=>null);
  // A 409 with conflicts is a receipt, not a failure: callers render it read-only.
  const conflict=response.status===409&&Array.isArray(result?.conflicts);
  if(!result)throw new Error('The host returned an unreadable response. Refresh status before retrying.');
  if(!response.ok&&!conflict){const error=new Error(result.error_description||result.error||`The host returned HTTP ${response.status}`);error.status=response.status;const blockers=response.status===409?safeDeletionBlockers(result.deletionBlockers):null;if(blockers)error.deletionBlockers=blockers;throw error;}
  if(result.apiVersion!==1)throw new Error('This Studio requires TimDS API version 1');
  return result;
}
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function connect(){const redirectUri=`${location.origin}/studio/`;let client=read('client');if(!client?.clientId){const result=await responseJson(await fetch('/register',{method:'POST',redirect:'error',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'TimDS Studio',client_uri:redirectUri,redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:'timds:read timds:write offline_access'})}));if(typeof result.client_id!=='string')throw new Error('Client registration did not return an identity');client={clientId:result.client_id};save('client',client);}const verifier=base64url(crypto.getRandomValues(new Uint8Array(32))),nonce=base64url(crypto.getRandomValues(new Uint8Array(32))),challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));save('authorization',{verifier,nonce,redirectUri,clientId:client.clientId,createdAt:Date.now(),returnHash:location.hash});const url=new URL('/authorize',location.origin);url.search=new URLSearchParams({response_type:'code',client_id:client.clientId,redirect_uri:redirectUri,scope:'timds:read timds:write offline_access',resource:`${location.origin}/api/timds`,state:nonce,code_challenge:challenge,code_challenge_method:'S256'});location.assign(url);await new Promise(resolve=>setTimeout(resolve,10000));}
async function completeAuthorization(){const url=new URL(location.href);if(!url.searchParams.has('code')&&!url.searchParams.has('error'))return;const saved=read('authorization');history.replaceState(null,'','/studio/'+(saved?.returnHash||''));remove('authorization');if(!saved||Date.now()-saved.createdAt>10*60*1000||url.searchParams.get('state')!==saved.nonce)throw new Error('This sign-in expired or did not match this tab. Connect again.');if(url.searchParams.has('error'))throw new Error('Connection was cancelled.');const result=await responseJson(await fetch('/token',{method:'POST',redirect:'error',credentials:'omit',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:url.searchParams.get('code'),client_id:saved.clientId,redirect_uri:saved.redirectUri,code_verifier:saved.verifier,resource:`${location.origin}/api/timds`})}));state.token={...tokenResult(result),clientId:saved.clientId};save('token',state.token);}
function disconnect(explicit=true){feedStop();$('#dialog')?.close();state.management=null;state.managementError=null;state.destructions.clear();state.token=null;state.principal=null;state.source=null;state.delivery=null;state.generation++;remove('token');if(explicit){for(const name of ['sessionStorage','localStorage'])try{const area=window[name];for(const key of Object.keys(area))if(key.startsWith(prefix))area.removeItem(key);}catch{}}renderWelcome();}
// Another Studio tab at this origin rotated, set or cleared the shared sign-in.
window.addEventListener('storage',event=>{if(event.storageArea!==localStorage||event.key!==prefix+'token')return;const next=read('token');if(!next){if(state.token)disconnect(false);return;}
  // An older pair another tab saved last loses to the one this tab already holds.
  const same=next.accessToken===state.token?.accessToken;if(state.principal&&!same&&!newer(next,state.token))return;
  state.token=next;if(!state.principal)boot().catch(loadFailure);});
function renderWelcome(){const main=node('main',{id:'main',class:'welcome'},node('span',{class:'wordmark'},'timds',title('span','.',{class:'brand-dot'})),title('div','YOUR DESIGN SYSTEM, TOGETHER',{class:'eyebrow'}),title('h1','A place for your next good change.'),title('p','Ask for a change, watch the agent make it live, and review the result before it goes out.'),button(signedIn()?'Try opening Studio again':'Connect to your Studio',signedIn()?boot:connect,'primary'),title('div','Your existing account permissions apply. Every Studio tab in this browser shares the sign-in for up to 30 days; Disconnect ends it.',{class:'welcome-footer'}));$('#app').replaceChildren(main);}
function navigate(view,sessionId=''){const params=new URLSearchParams({...(state.source?{source:state.source.id}:{}),view,...(sessionId?{session:sessionId}:{})});const next=params.toString();if(location.hash.slice(1)===next)return route().catch(loadFailure);location.hash=next;}
function renderShell(){if(state.view==='studio'&&state.source){$('#app').replaceChildren(node('div',{class:'studio-shell'},studioTop(),node('main',{id:'main',class:'studio-main',tabIndex:-1})));renderMain();return;}const current=state.source;
  const systems=node('nav',{class:'navigation','aria-label':'Design Systems'},...(state.systems.length?state.systems.map(system=>{const active=system.id===current?.id,hash=new URLSearchParams({source:system.id,view:'overview'}).toString();return node('a',{href:'#'+hash,class:`nav-link system-link ${active?'active':''}`,'aria-current':active?'page':null,onclick:event=>{event.preventDefault();if(!active)location.hash=hash;}},title('span',system.name,{class:'system-name'}),title('span',system.systemId,{class:'system-id'}));}):[title('p','No Design Systems yet.',{class:'help'})]));
  if(state.principal?.admin)systems.append(node('a',{href:'#view=systems',class:`nav-link ${state.view==='systems'?'active':''}`,'aria-current':state.view==='systems'?'page':null},'Manage Design Systems'),button('Create Design System',()=>createSystemDialog(),'small primary'));
  const tabs=current?[['overview','Overview'],['deliverables','Deliverables'],['sessions','Sessions'],['review','Review'],['activity','Activity']]:[];
  const views=node('nav',{class:'view-nav','aria-label':'Workspace'},...tabs.map(([view,label])=>node('a',{href:'#'+new URLSearchParams({source:current?.id||'',view}),class:`view-link ${state.view===view?'active':''}`,'aria-current':state.view===view?'page':null,onclick:event=>{event.preventDefault();navigate(view);}},label)));
  const sidebar=node('aside',{class:'sidebar'},node('span',{class:'wordmark'},'timds',title('span','.',{class:'brand-dot'})),node('div',{},title('div','Design Systems',{class:'sidebar-label'}),systems),node('div',{class:'sidebar-footer'},title('div',state.principal?.name||'Connected',{class:'identity'}),title('div','Your shared design workspace'),button('Disconnect this tab',()=>disconnect(),'quiet')));
  const bar=node('header',{class:'topbar'},node('div',{class:'topbar-system'},title('strong',current?.name||(state.view==='systems'?'Design Systems':'Studio')),current?.systemId?title('span',current.systemId,{class:'mono'}):null),views,node('div',{class:'actions'},current?publishingSlot():null,current?feedIndicator():null,button('Refresh',()=>refreshWorkspace(),'small quiet'),node('span',{class:'mobile-only'},button('Disconnect',()=>disconnect(),'small quiet'))));
  $('#app').replaceChildren(node('div',{class:'shell'},sidebar,node('div',{class:'workspace'},bar,node('main',{id:'main',class:'content',tabIndex:-1}))));renderMain();}
function pageHead(eyebrow,heading,description,action){return node('div',{class:'page-head'},node('div',{},title('div',eyebrow,{class:'eyebrow'}),title('h1',heading),title('p',description)),action);}

// ---- Sessions, drafts and their runner -------------------------------------
const ownRequests=()=>read(`requests.${state.source.id}`,[]);
function storeRequests(rows){save(`requests.${state.source.id}`,rows.slice(0,50));}
function openSessions(){return(state.work?.sessions||[]).filter(session=>['starting','open','closing'].includes(session.status));}
const sessionLabel=row=>row?.name||`${row?.kind==='draft'?'Draft':'Session'} ${short(row?.id)}`;
function sessionById(id){if(!id)return null;if(state.session?.session.id===id)return{...state.session.session,canInvite:state.session.canInvite};return(state.work?.sessions||[]).find(row=>row.id===id)||null;}
// Designer presence from the host's runner record.
const runnerText=runner=>({starting:'Designer running',running:'Designer running',submitting:'Designer submitting',idle:'Designer idle',submitted:'Designer idle',sleeping:'Sleeping',failed:'Failed',conflicted:'Conflicted'})[runner?.state]||'';
const RUNNER_STEPS=['queued','starting','running','submitting','submitted'];
const activeRunner=value=>['starting','running','submitting'].includes(value);
function runnerStrip(step){if(!step)return null;const failed=['conflicted','failed'].includes(step),index=RUNNER_STEPS.indexOf(step);return node('div',{class:'runner',role:'group','aria-label':`Designer ${step}`},...RUNNER_STEPS.map((name,i)=>title('span',name,{class:failed?'':i<index||(i===index&&name==='submitted')?'done':i===index?'now':''})),failed?title('span',step,{class:'fail'}):null);}
// A session row's strip: an active run wins, then queued Requests, then the last result.
function sessionStep(row){const value=row?.runner?.state;if(activeRunner(value))return value;if(row?.queueLength>0)return'queued';if(['submitted','conflicted','failed'].includes(value))return value;return null;}
// A Request's strip: its bound runner when present, else the Request's own status.
function requestStep(row){const value=row.runner?.state;if(activeRunner(value)||['submitted','conflicted','failed'].includes(value))return value;if(row.status==='queued')return'queued';if(row.status==='running')return'starting';if(row.status==='succeeded'&&row.submissionId)return'submitted';if(['failed','dead_letter','cancelled'].includes(row.status))return'failed';return null;}

// ---- Live state: starting, waking, ready, running, sleeping ----------------
const detailsOf=event=>{const value=event?.details_json;if(typeof value==='string'){try{return JSON.parse(value)||{};}catch{return{};}}return value&&typeof value==='object'?value:{};};
const LIVE_STATES=['starting','waking','ready','running','sleeping'];
function latestLive(sessionId){let best=null;for(const event of state.work?.events||[])if(event.event_type==='live_state'&&event.session_id===sessionId&&(!best||(Number(event.seq)||0)>(Number(best.seq)||0)))best=event;return detailsOf(best).state||null;}
function baseLiveState(row){
  if(!row)return'sleeping';
  if(row.status==='starting')return'starting';
  if(['closing','closed','expired'].includes(row.status))return'closed';
  if(activeRunner(row.runner?.state))return'running';
  const reported=latestLive(row.id)||row.liveState;
  if(['waking','starting','ready','failed'].includes(reported))return reported;
  if(['sleeping','stopped','closed'].includes(reported)||row.runner?.state==='sleeping')return'sleeping';
  return'ready';
}
// "waking" shows from the moment Studio opens a sleeping session or sends it a
// Request until the runtime reports ready (or a run starts); 5 minutes at most.
function liveStateOf(row){const base=baseLiveState(row),mark=row&&state.waking.get(row.id);if(mark){if(base==='running'||base==='ready'&&mark.base!=='ready'||base==='closed'||Date.now()-mark.at>300000)state.waking.delete(row.id);else return'waking';}return base;}
function markWaking(sessionId){const row=sessionById(sessionId);if(row&&row.status==='open'&&baseLiveState(row)==='sleeping'){state.waking.set(sessionId,{at:Date.now(),base:'sleeping'});renderStateStrips(sessionId);}}
function stateStrip(row){const current=liveStateOf(row);return node('div',{class:'runner state-strip',role:'status','aria-label':`Live view ${current}`,'data-live-state':row.id},...LIVE_STATES.map(name=>title('span',name,{class:name===current?(['ready','running'].includes(name)?'done now':'now'):''})),['failed','closed'].includes(current)?title('span',current,{class:'fail'}):null);}
function renderStateStrips(sessionId=null){for(const target of $$('[data-live-state]')){if(sessionId&&target.dataset.liveState!==sessionId)continue;const row=sessionById(target.dataset.liveState);if(row)target.replaceWith(stateStrip(row));}}

// ---- Embedded live view and Preview frames ---------------------------------
// One component for session/draft live views and submission Previews. Frames
// are never moved or re-created by a refresh; feed events reload them in place.
const frameTimers=new WeakMap(),frameReloads=new Map();
function frameView({url,sessionId='',submissionId='',label}){const href=safeUrl(url);const wrap=node('div',{class:'lv-frame','data-frame-session':sessionId,'data-frame-submission':submissionId,'data-url':href||'','data-label':label});if(!href){const live=sessionId?liveStateOf(sessionById(sessionId)):null;if(live==='starting'||live==='waking')wrap.append(frameLoading(live==='waking'?'Waking the session… the live view appears here when it is ready.':'Starting the session… the live view appears here when it is ready.'));else wrap.append(frameFallback(null,sessionId?'The live view appears here once the session has started.':'This submission has no Preview yet.'));return wrap;}mountFrame(wrap);return wrap;}
function mountFrame(wrap){const frame=document.createElement('iframe');frame.className='lv';frame.title=wrap.dataset.label||'Live view';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('loading','eager');frame.dataset.url=wrap.dataset.url;frame.src=wrap.dataset.url;wrap.replaceChildren(frameLoading(wrap.dataset.frameSubmission?'Loading the Preview…':'Loading the live view…'),frame);watchFrame(wrap,frame);}
function watchFrame(wrap,frame){clearTimeout(frameTimers.get(frame));delete frame.dataset.loaded;frame.onload=()=>{if(frame.dataset.blocked)return;frame.dataset.loaded='1';clearTimeout(frameTimers.get(frame));wrap.querySelector(':scope>.lv-fallback')?.remove();wrap.querySelector(':scope>.lv-loading')?.remove();};frame.onerror=()=>frameSlow(wrap,frame);frameTimers.set(frame,setTimeout(()=>{if(!frame.dataset.loaded)frameSlow(wrap,frame);},20000));}
// No load within 20 s (or an error): show the fallback card above the frame and
// keep the frame loading, so a container that is still waking can still appear.
function frameSlow(wrap,frame){if(!wrap.contains(frame)||wrap.querySelector(':scope>.lv-fallback'))return;wrap.querySelector(':scope>.lv-loading')?.remove();wrap.prepend(frameFallback(frame.dataset.url,'The live view has not loaded inside Studio yet.',()=>{wrap.querySelector(':scope>.lv-fallback')?.remove();mountFrame(wrap);}));}
function frameLoading(message){return node('div',{class:'lv-loading',role:'status'},spin(false),message);}
function frameFallback(href,message,retry){return node('div',{class:'lv-fallback'},title('strong',message),href?title('code',href,{class:'lv-url'}):null,node('div',{class:'actions'},href?link('Open in new tab ↗',href):null,retry?button('Try again',async()=>retry(),'small quiet'):null));}
function reloadFrames(sessionId){for(const wrap of $$('.lv-frame[data-frame-session]')){if(wrap.dataset.frameSession!==sessionId||!wrap.dataset.url||wrap.dataset.blocked)continue;clearTimeout(frameReloads.get(wrap));frameReloads.set(wrap,setTimeout(()=>{frameReloads.delete(wrap);const frame=wrap.querySelector('iframe');if(!frame){mountFrame(wrap);return;}wrap.querySelector(':scope>.lv-fallback')?.remove();if(!wrap.querySelector(':scope>.lv-loading'))wrap.prepend(frameLoading('Reloading with the latest change…'));frame.src=wrap.dataset.url;watchFrame(wrap,frame);},800));}}
// Studio's CSP names the allowed frame origins (TIMDS_STUDIO_FRAME_ORIGINS). A
// blocked frame becomes the fallback card at once instead of waiting 20 s.
document.addEventListener('securitypolicyviolation',event=>{if(!['frame-src','child-src'].includes(event.effectiveDirective||event.violatedDirective))return;let origin=null;try{origin=new URL(event.blockedURI).origin;}catch{}for(const wrap of $$('.lv-frame')){const href=wrap.dataset.url;if(!href)continue;let match=!origin;try{match=match||new URL(href).origin===origin;}catch{}if(!match||!wrap.querySelector('iframe')&&wrap.dataset.blocked)continue;wrap.dataset.blocked='1';const frame=wrap.querySelector('iframe');if(frame){frame.dataset.blocked='1';clearTimeout(frameTimers.get(frame));}wrap.replaceChildren(frameFallback(href,'Studio is not configured to show this view inline.',null));}});

// ---- Presence --------------------------------------------------------------
function viewersOf(id){const seen=new Map();for(const row of state.presence||[]){const viewing=row.viewing;if(viewing&&(viewing.sessionId===id||viewing.draftId===id))seen.set(row.principalId,row);}return[...seen.values()];}
const initials=name=>String(name||'?').trim().split(/[\s@._-]+/).filter(Boolean).slice(0,2).map(part=>[...part][0]).join('').toUpperCase()||'?';
function avatars(id){const rows=viewersOf(id),names=rows.map(row=>`${row.name||short(row.principalId)}${row.type==='agent'?' (agent)':''}`);return node('span',{class:'avatars','data-presence':id,role:'group','aria-label':rows.length?`Watching now: ${names.join(', ')}`:'Nobody else is watching',hidden:!rows.length},...rows.slice(0,5).map((row,index)=>node('span',{class:`avatar${row.type==='agent'?' agent':''}`,title:`${names[index]}${row.principalId===state.principal?.id?' · you':''}`},initials(row.name),row.type==='agent'?title('span','agent',{class:'agent-tag'}):null)),rows.length>5?title('span',`+${rows.length-5}`,{class:'avatar more',title:names.slice(5).join(', ')}):null);}
function renderPresence(){for(const target of $$('[data-presence]'))target.replaceWith(avatars(target.dataset.presence));}

// ---- Activity rail (feed first; the poll only fills gaps) ------------------
const EVENT_WORDS={session_started:'started a session',draft_created:'created a draft',member_joined:'added a member',claimed:'claimed a working area',updated:'changed the source',submitted:'submitted changes for review',closed:'closed a session',request_received:'sent a Request',request_started:'started a Request',request_submitted:'finished a Request',request_failed:'could not finish a Request',publication_queued:'queued a release',publication_failed:'release stopped',published:'published a release',authority_changed:'changed who can publish'};
function eventWords(event){const type=String(event.event_type||event.action||'activity'),detail=detailsOf(event);if(type==='live_state')return`live view ${detail.state||'changed'}`;if(type==='publication_stage')return`release reached ${detail.stage||'a new stage'}`;return EVENT_WORDS[type]||type.replaceAll('_',' ');}
const eventOrder=(a,b)=>(Number(b.seq)||0)-(Number(a.seq)||0)||String(b.created_at||'').localeCompare(String(a.created_at||''));
function activityRail(sessionId=null,limit=30){const events=(state.work?.events||[]).filter(event=>!sessionId||event.session_id===sessionId).sort(eventOrder).slice(0,limit);return node('ol',{class:'timeline rail','data-rail':sessionId||'all','data-limit':String(limit)},...(events.length?events.map(event=>{const row=!sessionId&&sessionById(event.session_id);return node('li',{},node('div',{class:'row-between'},node('span',{class:'rail-line'},title('strong',event.actor_name||event.principal_name||(event.actor_principal_id?short(event.actor_principal_id):'TimDS')),' ',eventWords(event)),title('time',ago(event.created_at),{dateTime:event.created_at||'',title:date(event.created_at)})),event.note?title('p',String(event.note).slice(0,280),{class:'rail-note'}):null,row?button(sessionLabel(row),()=>navigate('studio',row.id),'small quiet'):null);}):[node('li',{},empty('A fresh page','Activity appears here as it happens.'))]));}
const railPanel=(sessionId=null,limit=30)=>node('section',{class:'panel rail-panel'},node('div',{class:'panel-header'},title('h2','Activity'),feed.status==='live'?title('span','live',{class:'badge success'}):null),activityRail(sessionId,limit));
function renderRails(){for(const target of $$('[data-rail]'))if(!editing(target))target.replaceWith(activityRail(target.dataset.rail==='all'?null:target.dataset.rail,Number(target.dataset.limit)||30));}

// ---- Requests --------------------------------------------------------------
// Requests keep their UUID, prompt and target across ambiguous responses and retries.
async function sendTracked(prompt,targetSessionId=''){const rows=ownRequests(),prior=rows.find(row=>row.status==='unknown'&&row.prompt===prompt&&(row.targetSessionId||'')===(targetSessionId||''));const body=prior||{requestId:crypto.randomUUID(),prompt,targetSessionId:targetSessionId||null};if(!prior){rows.unshift({...body,status:'unknown',createdAt:new Date().toISOString()});storeRequests(rows);}if(targetSessionId)markWaking(targetSessionId);return sendRequest(body);}
async function sendRequest(body){const target=Object.hasOwn(body,'targetSessionId')?body.targetSessionId:body.sessionId;const result=await api(`${sourcePath()}/requests`,{requestId:body.requestId,prompt:body.prompt,...(target?{sessionId:target}:{})});storeRequests(ownRequests().map(row=>row.requestId===body.requestId?{...row,status:'queued',executionJobId:result.executionJobId,error:null}:row));return result;}
function requestCard(row){const sessionId=row.sessionId||row.targetSessionId,where=sessionById(sessionId);return node('article',{class:'request-card'},node('div',{class:'card-title'},title('h3',row.submissionId?'Ready for review':'Request'),badge(row.runner?.state||(row.status==='unknown'&&!row.error?'sending':row.status))),title('p',row.prompt,{class:'request-prompt'}),runnerStrip(requestStep(row)),row.status==='queued'&&row.queuePosition>0?title('p',`queued, ${row.queuePosition} ahead`,{class:'card-meta queue-position'}):null,title('p',[date(row.createdAt),where?sessionLabel(where):null].filter(Boolean).join(' · '),{class:'card-meta'}),row.error?title('p',row.error,{class:'error-text'}):null,node('div',{class:'actions'},sessionId&&state.session?.session.id!==sessionId?button('Open Studio',()=>navigate('studio',sessionId),'small'):null,row.submissionId?button('Review',()=>{state.previews.add(row.submissionId);navigate('review');},'small'):null,['unknown','failed','dead_letter','cancelled'].includes(row.status)?button('Retry this Request',async()=>{await sendRequest(row);await refresh(true);},'small'):null),details('Request reference',row.requestId));}
function requestList(sessionId=null){const rows=state.requestRows.filter(row=>!sessionId||row.sessionId===sessionId||row.targetSessionId===sessionId);return node('div',{class:'list','data-requests':sessionId||'all'},...(rows.length?rows.map(requestCard):[empty(sessionId?'No Requests from you here yet':'No Requests yet',sessionId?'Ask the agent for a change and follow it here.':'Start with a small change. Its progress will appear here.')]));}
function renderRequestLists(){for(const target of $$('[data-requests]'))if(!editing(target))target.replaceWith(requestList(target.dataset.requests==='all'?null:target.dataset.requests));if(state.view==='studio')patchStream();}

// ---- Work list -------------------------------------------------------------
const destructionKey=(sourceId,id)=>`${sourceId}:${id}`;
const destructionFor=row=>state.destructions.get(destructionKey(row.sourceId||state.source.id,row.id));
function destroySessionButton(row){if(!row.canManage||!['starting','open','closing'].includes(row.status))return null;const pending=destructionFor(row),control=button(pending?.busy?'Destroying…':row.status==='closing'||pending?.error?'Retry destroy…':'Destroy…',()=>destroySessionDialog(row),'small danger');control.disabled=Boolean(pending?.busy);if(pending?.busy)control.setAttribute('aria-busy','true');return control;}
function workCard(row,manage=false){const step=sessionStep(row),pending=destructionFor(row),draft=row.draftSessionId&&(state.work?.drafts||[]).find(item=>item.id===row.draftSessionId);return node('article',{class:'work-card'},node('div',{class:'card-title'},node('div',{class:'title-line'},title('h3',sessionLabel(row)),avatars(row.id)),badge(row.status)),title('p',manage?[`${row.members?.length||1} member${row.members?.length===1?'':'s'}`,draft?`From ${sessionLabel(draft)}`:row.kind==='draft'?'Shared draft':'From the main Design System'].join(' · '):`${row.kind==='draft'?'Shared draft':'Working session'} · ${row.members?.length||1} member${row.members?.length===1?'':'s'}${row.queueLength?` · ${row.queueLength} queued`:''}`,{class:'card-meta'}),manage?null:step?runnerStrip(step):title('p',runnerText(row.runner)||'Designer idle',{class:'card-meta runner-state'}),manage?null:(row.claims||[]).slice(0,2).map(claim=>title('p',`${claim.name||short(claim.principalId)} · ${claim.patterns.join(', ')}`,{class:'help break'})),manage&&row.status==='closing'?title('p','Cleanup has not finished. Retry destruction to finish removing this workspace.',{class:'help'}):null,manage&&pending?.error?title('p',pending.error,{class:'error-text',role:'alert'}):null,node('div',{class:'actions'},manage&&row.status==='closing'?null:button('Open Studio',()=>navigate('studio',row.id),'small primary'),manage?destroySessionButton(row):link('Live view ↗',row.liveUrl)));}
function workList(manage=false){const rows=openSessions(),drafts=rows.filter(row=>row.kind==='draft'),sessions=rows.filter(row=>row.kind!=='draft');if(manage)return node('div',{id:'work-list',class:'session-groups'},panel('Working sessions',sessions.length?node('div',{class:'list'},...sessions.map(row=>workCard(row,true))):empty('No working sessions','Create a session above to start from the main Design System or a shared draft.')),panel('Shared drafts',drafts.length?node('div',{class:'list'},...drafts.map(row=>workCard(row,true))):empty('No shared drafts','Create a named draft above to explore a direction together.')));return node('div',{id:'work-list',class:'list'},...(rows.length?[drafts.length?title('div','Shared drafts',{class:'section-label'}):null,...drafts.map(row=>workCard(row)),sessions.length?title('div','Sessions',{class:'section-label'}):null,...sessions.map(row=>workCard(row))]:[empty('All clear','Open a session to begin, then send your Request in Studio.')]));}
function sessionCreation(){return node('div',{class:'session-creation'},node('section',{class:'panel'},title('h2','New working session'),title('p','Start from the main Design System or a shared draft, then make your changes in Studio.',{class:'help'}),button('New session',()=>startSessionDialog(),'primary')),node('section',{class:'panel'},title('h2','New shared draft'),title('p','Give a direction a name so collaborators can work on it together in Studio.',{class:'help'}),button('New draft',()=>startDraftDialog(),'primary')));}

// ---- Views -----------------------------------------------------------------
function renderMain(){const main=$('#main');if(!main)return;if(state.view==='systems'&&state.principal?.admin){main.replaceChildren(manageSystemsView());return;}if(!state.source){main.replaceChildren(pageHead('STUDIO','Your systems will appear here.','Ask your administrator for access to a Design System.'));return;}if(!state.work){main.replaceChildren(loadingBlock('Loading your workspace…','Sessions, Requests and releases are on their way.'));return;}
  if(state.view==='studio'){if(!state.session){main.replaceChildren(loadingBlock('Opening the session…','The stream and the live view appear in a moment.'));return;}renderStudio(main);return;}
  if(state.view==='overview'){main.replaceChildren(pageHead('YOUR DESIGN SYSTEM',state.source.name,'From the first idea to everything your team needs to bring it to life.',state.principal?.admin?node('div',{class:'actions head-actions'},button('Access…',()=>accessDialog(state.source),'small'),button('Delete Design System…',()=>deleteSelectedSystem(),'small danger')):null),deliveryView(),node('div',{class:'section-head'},title('h2','Keep creating.'),title('p','Three ways to make your next change.')),waysOverview(),node('div',{class:'grid'},panel('Drafts and sessions',workList()),node('div',{class:'stack'},panel('Recent Requests',requestList()),panel('Releases',releaseList(3)))));return;}
  if(state.view==='deliverables'){main.replaceChildren(pageHead(state.source.name,'Made to be used.','Explore the published system, find the right assets, and hand everything over to your team.'),deliveryView(true));return;}
  if(state.view==='sessions'){main.replaceChildren(pageHead(state.source.name,'Sessions and drafts.','Create a workspace here, then open Studio for Requests, live changes and review.'),sessionCreation(),workList(true));return;}
  if(state.view==='review'){main.replaceChildren(pageHead(state.source.name,'Ready for a closer look.','Open each Preview here, then publish or restore a release.'),node('section',{class:'panel'},reviewList()),panel('Releases',releaseList()));return;}
  main.replaceChildren(pageHead(state.source.name,'The work, recorded.','Requests, agents and releases leave a shared history.'),railPanel(null,100),panel('Published releases',releaseList()));}
function showDialog(heading,...content){const dialog=$('#dialog');replaceContent(dialog,title('h2',heading,{id:'dialog-title'}),...content);if(!dialog.open)dialog.showModal();return dialog;}
const cancelButton=()=>button('Cancel',()=>$('#dialog').close());
// ---- Administrator lifecycle ---------------------------------------------
// Pending inputs are scoped to this signed-in identity and survive a reload.
// Never change a submitted creation's IDs or input after an ambiguous response.
const creationKey=()=>`creations.${state.principal.id}`;
const pendingCreations=()=>read(creationKey(),[]);
function rememberCreation(record){save(creationKey(),[...pendingCreations().filter(row=>row.input.operationId!==record.input.operationId),{input:record.input,...(record.organization?{organization:record.organization}:{})}]);}
function forgetCreation(operationId){save(creationKey(),pendingCreations().filter(row=>row.input.operationId!==operationId));}
const deletionKey=id=>`deletion.${state.principal.id}.${id}`;
function manageSystems(){if(location.hash==='#view=systems')return route();location.hash='view=systems';}
async function catalogPages(path,key,cursorKey){const rows=[],seen=new Set();let cursor='',first;do{const result=await api(path+(cursor?`?after=${enc(cursor)}`:''));first??=result;rows.push(...(result[key]||[]));cursor=result[cursorKey]||'';if(cursor&&seen.has(cursor))throw new Error('The catalog could not finish loading. Refresh to try again.');seen.add(cursor);}while(cursor);return{...first,[key]:rows};}
async function loadManagement(force=false){
  if(!state.principal?.admin)return;
  if(state.management&&!force)return;
  const principalId=state.principal.id;state.managementError=null;
  try{
    const results=await Promise.allSettled([catalogPages('/api/timds/admin/systems','systems','nextSystemCursor'),catalogPages('/api/timds/admin/organizations','organizations','nextOrganizationCursor'),api('/api/timds/design-systems')]);
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    if(state.principal?.id!==principalId)return;
    const [catalog,organizations,ordinary]=results.map(result=>result.value);state.management={systems:catalog.systems,organizations:organizations.organizations,namespaces:catalog.namespaces||[]};state.systems=ordinary.systems||[];for(const record of pendingCreations())if(catalog.systems.some(row=>row.id===record.input.sourceId&&['deleting','deleted'].includes(row.lifecycleStatus)))forgetCreation(record.input.operationId);
  }catch(error){if(state.principal?.id!==principalId)return;state.managementError=error.message;throw error;}
  finally{if(state.principal?.id===principalId&&state.view==='systems')renderShell();}
}
async function refreshWorkspace(){
  if(state.view==='systems'){await loadManagement(true);return;}
  const principalId=state.principal?.id,catalog=await api('/api/timds/design-systems');if(state.principal?.id!==principalId)return;state.systems=catalog.systems||[];
  if(!state.systems.some(row=>row.id===state.source?.id)){await route();return;}
  renderShell();await refresh(true,true);
}
function manageSystemsView(){
  const head=pageHead('ADMINISTRATION','Design Systems','Create a system, review its lifecycle, or follow a deletion through cleanup.',button('Create Design System',()=>createSystemDialog(),'primary'));
  if(!state.management)return node('div',{},head,state.managementError?panel('The catalog could not load',title('p',state.managementError,{class:'error-text'}),button('Try again',()=>loadManagement(true))):loadingBlock('Loading Design Systems…'));
  const data=state.management,pending=pendingCreations().filter(record=>!data.systems.some(system=>system.id===record.input.sourceId&&['deleting','deleted'].includes(system.lifecycleStatus))),pendingIds=new Set(pending.map(row=>row.input.sourceId)),active=data.systems.filter(system=>system.lifecycleStatus!=='deleted'),deleted=data.systems.filter(system=>system.lifecycleStatus==='deleted');
  const systemRow=system=>{const organization=data.organizations.find(row=>row.id===system.organizationId),deletionId=system.deletionOperationId||read(deletionKey(system.id))?.operationId,isDeleted=system.lifecycleStatus==='deleted';return node('article',{class:'panel system-management-row'},node('div',{class:'card-title'},node('div',{},title('h2',system.name),title('p',system.systemId,{class:'mono help break'})),badge(isDeleted?'deleted':system.archivedAt?'archived':system.lifecycleStatus)),title('p',organization?.name||'Design System organization',{class:'card-meta'}),node('div',{class:'actions'},system.lifecycleStatus==='ready'&&!system.archivedAt?button('Open system',()=>{location.hash=new URLSearchParams({source:system.id,view:'overview'}).toString();},'small'):null,system.lifecycleStatus==='ready'&&!system.archivedAt?button('Access…',()=>accessDialog(system),'small'):null,!isDeleted&&organization?button('Rename organization…',()=>renameOrganizationDialog(organization),'small'):null,['provisioning','ready'].includes(system.lifecycleStatus)&&system.creationPending&&system.creationInput&&!pendingIds.has(system.id)?button(system.lifecycleStatus==='ready'?'Finish setup':'Resume creation',()=>createSystemDialog({input:system.creationInput}),'small'):null,system.lifecycleStatus==='provisioning'&&!system.creationInput?title('p','Provisioning is incomplete. Resume it from the original administrative workflow.',{class:'help'}):null,deletionId?button(isDeleted?'Deletion receipt':'Review deletion',()=>deleteSystemDialog(system,deletionId),'small'):['ready','provisioning'].includes(system.lifecycleStatus)?button('Delete…',()=>deleteSystemDialog(system),'small danger'):null));};
  return node('div',{class:'system-management'},head,state.managementError?title('p',state.managementError,{class:'error-text'}):null,...pending.map(record=>panel(`Creation in progress: ${record.input.name}`,title('p','This tab saved the original details. Review status or retry the same creation.',{class:'help'}),button('Resume creation',()=>createSystemDialog(record),'small'))),
    active.length?node('div',{class:'list'},...active.map(systemRow)):panel(deleted.length?'No active Design Systems':'Create your first Design System',title('p','Start with a hosted starter, then open a session and ask the designer to make it yours.',{class:'help'}),button('Create Design System',()=>createSystemDialog(),'primary')),
    deleted.length?node('details',{class:'details'},title('summary',`Deleted Design Systems (${deleted.length})`),node('div',{class:'list'},...deleted.map(systemRow))):null);
}
function renameOrganizationDialog(organization){
  if(!state.principal?.admin)throw new Error('An active administrator is required.');
  const principal=state.principal,id=organization.id,expectedName=organization.name,host=node('div'),name=node('input',{id:'organization-name',required:true,maxLength:200,value:expectedName}),errorText=title('p','',{class:'error-text',role:'alert'});
  const visible=()=>state.principal===principal&&host.isConnected&&dialog.open;
  const rename=button('Save name',async()=>{
    if(!visible()||!name.reportValidity())return;
    const desiredName=name.value.trim();if(!desiredName)throw new Error('Enter a name for the organization.');errorText.textContent='';
    try{
      const result=await api(`/api/timds/admin/organizations/${enc(id)}/name`,{name:desiredName,expectedName});
      if(!visible())return;
      if(result.organization?.id!==id||result.organization.name!==desiredName)throw new Error('No matching organization was returned. Refresh the catalog before retrying.');
      const row=state.management?.organizations.find(item=>item.id===id);if(row)row.name=result.organization.name;
      dialog.close();if(state.view==='systems')renderShell();notice('Organization name updated.');
    }catch(error){if(visible())errorText.textContent=error.message;}
  },'primary');
  host.append(title('p','This changes the organization name for every Design System that uses it, including systems sharing an existing organization. Organization IDs and Design System identities remain fixed.'),field('Organization name',name),errorText,node('div',{class:'dialog-actions'},cancelButton(),rename));
  const dialog=showDialog('Rename organization',host);
}
// ---- Source access ---------------------------------------------------------
// Who can read, write or publish a Design System. Each change is a durable
// authority operation: the operation UUID and exact command are saved per
// principal and source before the request leaves the tab and reused unchanged
// after an ambiguous response. The host rechecks administrator authority on
// every call and closes that person's live sessions so they reconnect with
// their new permissions. Studio never matches emails or creates identities.
const accessKey=(sourceId,principalId)=>`access.${state.principal.id}.${sourceId}.${principalId}`;
const accessVisible=tracker=>state.principal?.id===tracker.principalId&&tracker.host.isConnected&&$('#dialog').open;
async function cursorPages(path,key,cursorKey){const rows=[],seen=new Set();let cursor='',first;do{const result=await api(path+(cursor?`/${enc(cursor)}`:''));first??=result;rows.push(...(result[key]||[]));cursor=result[cursorKey]||'';if(cursor&&seen.has(cursor))throw new Error('The access list could not finish loading. Refresh to try again.');seen.add(cursor);}while(cursor);return{...first,[key]:rows};}
const describeAccess=command=>{const granted=['read','write','publish'].filter(key=>command[key]);return granted.length?`can ${granted.join(', ')}`:'no longer has access';};
async function accessDialog(system){
  if(!state.principal?.admin)throw new Error('An active administrator is required.');
  const host=node('div',{class:'access-dialog'}),tracker={system:{id:system.id,name:system.name,systemId:system.systemId},host,principalId:state.principal.id,data:null,error:null,selected:'',flags:null};
  showDialog(`Access to ${system.name}`,host);host.append(loadingLine('Reading who has access…'),node('div',{class:'dialog-actions'},cancelButton()));
  await readAccess(tracker);
}
async function readAccess(tracker){
  const base=`/api/timds/admin/systems/${enc(tracker.system.id)}`;
  try{
    const [publishers,principals,directory]=await Promise.all([cursorPages(`${base}/authority`,'publishers','nextPublisherCursor'),cursorPages(`${base}/principals`,'principals','nextPrincipalCursor'),api(`/api/timds/design-systems/${enc(tracker.system.id)}/principals`)]);
    if(!accessVisible(tracker))return;
    if(publishers.sourceId!==tracker.system.id||directory.sourceId!==tracker.system.id)throw new Error('The host returned access for a different Design System. Refresh before continuing.');
    tracker.data={version:publishers.authorityVersion,publishers:new Set(publishers.publishers.map(row=>row.id)),principals:principals.principals.filter(row=>row&&typeof row.id==='string'),directory:(directory.principals||[]).filter(row=>row&&typeof row.id==='string')};tracker.error=null;
  }catch(error){if(!accessVisible(tracker))return;tracker.error=error.message;}
  renderAccess(tracker);
}
function renderAccess(tracker){
  if(!accessVisible(tracker))return;
  const {host,data,system}=tracker,close=button('Close',()=>$('#dialog').close());
  if(!data){replaceContent(host,title('p',tracker.error||'The access list could not load.',{class:'error-text',role:'alert'}),node('div',{class:'dialog-actions'},close,button('Try again',()=>readAccess(tracker))));return;}
  const byId=new Map(data.principals.map(row=>[row.id,row])),rows=data.directory.map(row=>({id:row.id,name:row.name||row.id,type:row.type,active:row.active!==false,publisher:data.publishers.has(row.id)}));
  for(const id of data.publishers)if(!rows.some(row=>row.id===id)){const row=byId.get(id);rows.push({id,name:row?.name||id,type:row?.type||'user',active:row?.status==='active',publisher:true});}
  rows.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const errorText=title('p','',{class:'error-text',role:'alert'}),choices=data.principals.filter(row=>row.status==='active').sort((a,b)=>String(a.name||a.id).localeCompare(String(b.name||b.id)));
  const select=node('select',{id:'access-principal'},node('option',{value:''},'Choose a person or agent…'),...choices.map(row=>node('option',{value:row.id,selected:row.id===tracker.selected},`${row.name||row.id} (${row.type})`)));
  const check=(id,label,checked)=>{const input=node('input',{type:'checkbox',id,checked});return{input,row:node('label',{class:'check',htmlFor:id},input,label)};};
  const flags=tracker.flags||{read:true,write:true,publish:false},canRead=check('access-read','Read',flags.read),canWrite=check('access-write','Write',flags.write),canPublish=check('access-publish','Publish',flags.publish);
  const sync=()=>{if(canWrite.input.checked)canRead.input.checked=true;tracker.flags={read:canRead.input.checked,write:canWrite.input.checked,publish:canPublish.input.checked};const any=tracker.flags.read||tracker.flags.write||tracker.flags.publish;apply.textContent=any?'Apply permissions':'Remove all access';apply.className=any?'primary':'danger';};
  canWrite.input.addEventListener('change',sync);canRead.input.addEventListener('change',()=>{if(!canRead.input.checked)canWrite.input.checked=false;sync();});canPublish.input.addEventListener('change',sync);
  select.addEventListener('change',()=>{tracker.selected=select.value;const current=rows.find(row=>row.id===select.value);if(current){canRead.input.checked=true;canWrite.input.checked=true;canPublish.input.checked=current.publisher;}sync();});
  const apply=button('Apply permissions',async()=>{
    const principalId=select.value;if(!principalId)throw new Error('Choose who should have access.');
    const command={principalId,read:canRead.input.checked,write:canWrite.input.checked,publish:canPublish.input.checked},key=accessKey(system.id,principalId),saved=read(key),operationId=saved?.operationId&&JSON.stringify(saved.command)===JSON.stringify(command)?saved.operationId:crypto.randomUUID();
    save(key,{operationId,command});errorText.textContent='';
    try{
      const receipt=await api(`/api/timds/admin/systems/${enc(system.id)}/authority`,{operationId,command});
      if(!accessVisible(tracker))return;
      if(receipt.source_id!==system.id||receipt.command?.principalId!==principalId||!Number.isSafeInteger(receipt.confirmed_version))throw new Error('The host did not confirm this change. Refresh the list and review current access before retrying.');
      sessionStorage.removeItem(prefix+key);tracker.selected='';tracker.flags=null;
      notice(`${byId.get(principalId)?.name||principalId} ${describeAccess(command)}.`);
      await readAccess(tracker);
    }catch(error){if(accessVisible(tracker))errorText.textContent=error.message;}
  },'primary');
  const personRow=row=>node('div',{class:'access-row'},node('div',{class:'access-who'},title('strong',row.name),title('span',`${row.type}${row.active?'':' · inactive'}`,{class:'muted'})),node('div',{class:'access-flags'},row.publisher?badge('publisher'):badge('access'),row.active&&byId.has(row.id)?button('Change…',()=>{tracker.selected=row.id;tracker.flags={read:true,write:true,publish:row.publisher};renderAccess(tracker);host.querySelector('#access-principal')?.focus();},'small quiet'):null));
  replaceContent(host,title('p',`${system.systemId||system.id} · authority version ${data.version??'unknown'}`,{class:'mono help break'}),
    panel('Who has access',rows.length?node('div',{class:'access-list'},...rows.map(personRow)):empty('Nobody yet','Only host administrators can reach this Design System.'),title('p','Everyone who can read, write or publish, plus the designer agent. Publishers can release to the public address; the host requires that grant explicitly, even for administrators.',{class:'help'})),
    panel('Set permissions',field('Person or agent',select,'Only identities that have already signed in to this host appear here. Studio never creates an identity from an email address.'),node('div',{class:'checks'},canRead.row,canWrite.row,canPublish.row),title('p','Permissions are set exactly as checked. Write includes read. Unchecking everything removes this identity’s access; published releases and recorded history stay.',{class:'help'}),errorText),
    node('div',{class:'dialog-actions'},close,button('Refresh',()=>readAccess(tracker)),apply));
  sync();
}
async function createSystemDialog(record=null){
  if(!state.principal?.admin)throw new Error('An active administrator is required.');
  const principal=state.principal,dialog=$('#dialog'),dialogContent=dialog.firstChild,dialogOpen=dialog.open,unchanged=()=>state.principal===principal&&dialog.firstChild===dialogContent&&dialog.open===dialogOpen;
  try{await loadManagement();}catch(error){if(unchanged())throw error;return;}
  if(!unchanged())return;
  if(record){rememberCreation(record);return creationProgress(record);}
  const data=state.management,name=node('input',{id:'system-name',required:true,maxLength:200,placeholder:'Example design system'}),systemId=node('input',{id:'system-slug',required:true,maxLength:300,placeholder:'example/design-system'}),organization=node('select',{id:'system-organization'},node('option',{value:''},'New organization'),...data.organizations.map(row=>node('option',{value:row.id},row.name))),namespace=[...data.namespaces].sort()[0]||'';
  let edited=false;systemId.addEventListener('input',()=>edited=true);name.addEventListener('input',()=>{if(!edited)systemId.value=name.value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,300);});
  const create=button('Create Design System',async()=>{
    if(state.principal!==principal||!name.isConnected||!dialog.open)return;
    if(!name.reportValidity()||!systemId.reportValidity())return;
    if(!name.value.trim())throw new Error('Enter a name for the Design System.');
    if(!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(systemId.value))throw new Error('Use a lowercase system ID with letters, numbers, periods, underscores or hyphens, optionally separated by slashes.');
    if(!namespace)throw new Error('No repository namespace is configured. Ask the host operator to configure one.');
    if(organization.value&&!data.organizations.some(row=>row.id===organization.value))throw new Error('Select an available organization.');
    const organizationId=organization.value||crypto.randomUUID(),input={operationId:crypto.randomUUID(),sourceId:crypto.randomUUID(),organizationId,name:name.value.trim(),systemId:systemId.value,namespace};
    const saved={input,...(!organization.value?{organization:{id:organizationId,name:input.name}}:{})};rememberCreation(saved);creationProgress(saved);await submitCreation(saved);
  },'primary');create.disabled=!namespace;
  showDialog('Create a Design System',title('p','Create a hosted starter with a working guide and the foundation for your first release. You receive read, edit and publish access.'),field('Name',name),field('System ID',systemId,'A unique public identifier: lowercase letters, numbers, periods, underscores and hyphens, optionally separated by slashes. Technical identities stay fixed after creation.'),field('Organization',organization,'A new organization takes the Design System name. You can rename the organization later.'),!namespace?title('p','No repository namespace is configured. Ask the host operator to configure one before creating a system.',{class:'error-text'}):null,node('div',{class:'dialog-actions'},cancelButton(),create));
}
function creationProgress(record,message=''){const host=node('div',{class:'creation-progress'});record.host=host;record.principal=state.principal;const input=record.input;record.dialog=showDialog(`Creating ${input.name}`,host);renderCreation(record,message);}
const creationVisible=(record,host=record.host)=>state.principal===record.principal&&record.host===host&&host?.isConnected&&record.dialog?.open;
function renderCreation(record,message=''){
  if(!creationVisible(record))return;
  const input=record.input;replaceContent(record.host,title('p','These original details are saved in this tab. A retry continues the same creation.'),node('dl',{class:'lifecycle-facts'},title('dt','Name'),title('dd',input.name),title('dt','System ID'),title('dd',input.systemId),title('dt','Operation'),title('dd',input.operationId)),message?title('p',message,{class:'help',role:'status'}):null,record.busy?loadingLine('Creating the repository and starter… this can take a moment.'):null,record.error?title('p',record.error,{class:'error-text',role:'alert'}):null,node('div',{class:'dialog-actions'},button('Close',()=>record.dialog.close()),record.busy?null:button('Refresh status',()=>refreshCreation(record),'quiet'),record.busy?null:button('Resume creation',()=>submitCreation(record),'primary')));
}
async function refreshCreation(record){
  if(!creationVisible(record))return;const host=record.host,input=record.input;
  try{
    const result=await api(`/api/timds/admin/systems/${enc(input.sourceId)}/provision/${enc(input.operationId)}`);if(!creationVisible(record,host))return;
    renderCreation(record,result.provision.status==='completed'?'The starter exists. Resume creation to finish access and open it.':`Provisioning ${result.provision.status}. Resume creation to continue.`);
  }catch(error){if(!creationVisible(record,host))return;if(error.status===404||error.status===409){renderCreation(record,'No complete receipt is available yet. Retry the saved creation to continue.');return;}throw error;}
}
async function submitCreation(record){
  if(record.busy||!creationVisible(record))return;const principal=state.principal,host=record.host,dialog=record.dialog;record.busy=true;record.error=null;renderCreation(record);
  try{
    if(record.organization)await api('/api/timds/admin/organizations',record.organization);
    if(state.principal!==principal)return;
    const result=await api('/api/timds/admin/systems/create',record.input);if(state.principal!==principal||!creationVisible(record,host))return;
    if(result.source?.id!==record.input.sourceId)throw new Error('No matching creation receipt was returned. Refresh status before retrying.');
    forgetCreation(record.input.operationId);state.management=null;
    const source={id:result.source.id,systemId:record.input.systemId,name:record.input.name};state.systems=[...state.systems.filter(row=>row.id!==source.id),source];
    if(creationVisible(record,host)){dialog.close();notice(`${source.name} is ready. Open a session to start creating.`);location.hash=new URLSearchParams({source:source.id,view:'overview'}).toString();}
  }catch(error){if(state.principal===principal){record.error=error.message;if(creationVisible(record,host))notice('Creation needs attention. The original details are saved for retry.',true);}}
  finally{record.busy=false;if(creationVisible(record,host))renderCreation(record);}
}
const deletionActive=receipt=>['queued','running'].includes(receipt?.status);
function retireFromWorkspace(sourceId){state.systems=state.systems.filter(row=>row.id!==sourceId);if(state.source?.id===sourceId){feedStop();state.source=null;state.work=null;state.delivery=null;state.session=null;state.generation++;void manageSystems();}else if(state.view==='systems')renderShell();}
async function deleteSelectedSystem(){
  const sourceId=state.source?.id,principalId=state.principal?.id,generation=state.generation;
  if(!sourceId||!state.principal?.admin)throw new Error('An active administrator is required.');
  await loadManagement(true);
  if(state.generation!==generation||state.principal?.id!==principalId||!state.principal?.admin||state.source?.id!==sourceId||state.view!=='overview')return;
  const system=state.management.systems.find(row=>row.id===sourceId);
  if(!system)throw new Error('This Design System is no longer available. Refresh the workspace.');
  await deleteSystemDialog(system);
}
async function deleteSystemDialog(system,operationId=null){
  if(!state.principal?.admin)throw new Error('An active administrator is required.');
  const saved=read(deletionKey(system.id)),id=operationId||system.deletionOperationId||saved?.operationId||crypto.randomUUID(),host=node('div',{class:'deletion-progress'}),tracker={system,operationId:id,host,principalId:state.principal.id,receipt:null,blockers:null,reading:false};
  save(deletionKey(system.id),{operationId:id});showDialog(`Delete ${system.name}`,host);host.append(loadingLine('Reading the system’s cleanup review…'),node('div',{class:'dialog-actions'},cancelButton()));await readDeletion(tracker,true);
}
function deletionVisible(tracker){return state.principal?.id===tracker.principalId&&tracker.host.isConnected&&$('#dialog').open;}
async function readDeletion(tracker,prepare=false){
  if(tracker.reading||!deletionVisible(tracker))return;tracker.reading=true;clearTimeout(tracker.timer);
  try{
    let receipt,prepared=false;const base=`/api/timds/admin/systems/${enc(tracker.system.id)}/deletion`;
    try{receipt=await api(`${base}/${enc(tracker.operationId)}`);}catch(error){if(!prepare||error.status!==404)throw error;receipt=await api(base,{operationId:tracker.operationId});prepared=true;}
    if(!deletionVisible(tracker))return;tracker.receipt=receipt;tracker.error=null;if(prepared||receipt.status!=='awaiting_confirmation')tracker.blockers=null;
    if(receipt.status!=='awaiting_confirmation'){const row=state.management?.systems.find(row=>row.id===tracker.system.id);if(row){row.deletionOperationId=receipt.operationId;row.lifecycleStatus=receipt.status==='completed'?'deleted':'deleting';}retireFromWorkspace(tracker.system.id);}
    renderDeletion(tracker);
    if(deletionActive(receipt))tracker.timer=setTimeout(()=>void readDeletion(tracker),3000);
    else if(receipt.status==='completed'){void loadManagement(true).catch(error=>notice(error.message,true));}
  }catch(error){if(deletionVisible(tracker)){tracker.error=error.message;if(error.deletionBlockers?.sourceId===tracker.system.id)tracker.blockers=error.deletionBlockers;renderDeletion(tracker);if(deletionActive(tracker.receipt)&&![401,403].includes(error.status))tracker.timer=setTimeout(()=>void readDeletion(tracker),5000);}}
  finally{tracker.reading=false;}
}
function deletionBlockerPanel(tracker){
  const blockers=tracker.blockers;if(!blockers||blockers.sourceId!==tracker.system.id)return null;
  const sourceId=tracker.system.id,href='#'+new URLSearchParams({source:sourceId,view:'sessions'}).toString();
  const sessionsLink=()=>node('a',{href,class:'button small',onclick:event=>{event.preventDefault();if(!deletionVisible(tracker))return;if(!state.systems.some(row=>row.id===sourceId)){tracker.error='This Design System is unavailable in Sessions. Ask a host operator to resolve its lifecycle state before managing these workspaces.';renderDeletion(tracker);return;}$('#dialog').close();if(location.hash===href)void route().catch(loadFailure);else location.hash=href;}},'Go to Sessions');
  return panel('Workspaces blocking deletion',title('p',`${blockers.total} workspace${blockers.total===1?' needs':'s need'} attention before this Design System can be deleted.`,{class:'help'}),blockers.total>blockers.sessions.length?title('p',`Showing ${blockers.sessions.length} of ${blockers.total} affected workspaces.`,{class:'help'}):null,
    ...blockers.sessions.map(row=>{const known=state.source?.id===sourceId?(state.work?.sessions||[]).find(item=>item.id===row.sessionId):null;return node('article',{class:'work-card'},node('div',{class:'card-title'},title('h3',known?sessionLabel(known):`Workspace ${short(row.sessionId)}`),badge(row.status)),title('p',row.sessionId,{class:'mono help break'}),title('p',row.reason==='missing_creation_receipt'?'Missing ownership receipt: this workspace’s repository has no immutable creation receipt, so system deletion cannot remove it automatically.':'Repository identity changed: the current repository does not match its recorded ownership receipt.',{class:'help'}),row.action==='review_session'?node('div',{},title('p','Go to Sessions and explicitly destroy this workspace there. Then return here and retry the deletion review; prepare a new review if its impact changed.',{class:'help'}),node('div',{class:'actions'},sessionsLink())):title('p','A host operator must verify ownership and resolve this blocker. Studio will not remove or adopt the repository.',{class:'help'}));}),!blockers.sessions.length?title('p','No valid workspace details were returned. Ask a host operator to inspect the deletion blocker.',{class:'help'}):null);
}
function renderDeletion(tracker){
  if(!deletionVisible(tracker))return;
  const receipt=tracker.receipt,host=tracker.host,close=button('Close',()=>$('#dialog').close()),refresh=button('Refresh status',()=>readDeletion(tracker));
  if(!receipt){replaceContent(host,title('p',tracker.error||'No deletion review was returned.',{class:'error-text',role:'alert'}),deletionBlockerPanel(tracker),node('div',{class:'dialog-actions'},close,button('Retry review',()=>readDeletion(tracker,true))));return;}
  const phase={inspect:'Review the impact before deleting.',stop_work:'Stopping sessions, Requests and live runtimes.',remove_media:'Removing source media and waiting for temporary upload capabilities to expire.',remove_repositories:'Removing session forks and the source repository.',remove_preview:'Removing the owned Preview Worker and Builds connection.',revoke_authority:'Revoking Design System grants.',verify:'Verifying cleanup and retained history.',completed:'Deletion is complete. The Design System identity remains permanently retired.'}[receipt.phase]||'Cleanup is in progress.';
  const counts=receipt.counts||{},typed=node('input',{id:'delete-repository',autoComplete:'off',spellcheck:false}),confirmable=['awaiting_confirmation','failed'].includes(receipt.status)&&!receipt.requiresConsumerProof&&!tracker.blockers;
  const confirm=button(receipt.status==='failed'?'Resume deletion':'Permanently delete',async()=>{
    if(tracker.blockers)throw new Error('Resolve the workspace blockers and refresh the deletion review before confirming.');
    if(typed.value!==receipt.repository.name)throw new Error('Type the exact repository name shown in the review.');
    try{tracker.receipt=await api(`/api/timds/admin/systems/${enc(tracker.system.id)}/deletion/${enc(receipt.operationId)}/confirm`,{impactHash:receipt.impactHash,typedRepository:typed.value});tracker.error=null;tracker.blockers=null;retireFromWorkspace(tracker.system.id);renderDeletion(tracker);tracker.timer=setTimeout(()=>void readDeletion(tracker),1000);}catch(error){tracker.error=error.message;if(error.deletionBlockers?.sourceId===tracker.system.id)tracker.blockers=error.deletionBlockers;renderDeletion(tracker);}
  },'danger');confirm.disabled=true;typed.addEventListener('input',()=>{confirm.disabled=typed.value!==receipt.repository.name;});
  replaceContent(host,node('div',{class:'title-line'},badge(receipt.status),title('span',phase,{class:'help',role:'status'})),deletionActive(receipt)?loadingLine('The host is cleaning up in the background. You can close this dialog and return to its receipt.'):null,
    title('p','Deletion permanently removes the source repository, mutable session forks, live runtimes, owned Preview resources and access grants. It stops authoring and public serving as soon as confirmed.'),
    node('dl',{class:'lifecycle-facts'},title('dt','Repository'),title('dd',`${receipt.repository.namespace}/${receipt.repository.name}`),...Object.entries({Sessions:counts.sessions,'Session forks':counts.forks,Publishers:counts.publishers,'Active Requests':counts.requests,...(counts.mediaAssets!==undefined?{'Media assets':counts.mediaAssets}:{}),...(counts.mediaUploads!==undefined?{'Media uploads':counts.mediaUploads}:{})}).flatMap(([label,value])=>[title('dt',label),title('dd',String(value??0))])),
    panel('Retained after deletion',title('p','Immutable release bytes and audit history remain retained. Downloads and cached copies cannot be recalled. The source UUID cannot be reused.',{class:'help'}),receipt.retention?.mediaOriginals==='removed_scoped'?title('p','Source media uploads and original assets are removed. Immutable release copies remain retained.',{class:'help'}):title('p','Immutable media bytes remain retained.',{class:'help'})),
    receipt.requiresConsumerProof&&receipt.status!=='completed'?panel('External consumer verification required',title('p','An imported system needs its original backend to fence consumer attachments and supply a fresh signed verification. An operator must complete or resume deletion through that backend. Studio cannot supply this proof.',{class:'help'}),snippet([`Source: ${receipt.sourceId}`,`Operation: ${receipt.operationId}`,`Impact: ${receipt.impactHash}`])):null,
    receipt.error?title('p',receipt.error,{class:'error-text',role:'alert'}):null,tracker.error?title('p',tracker.error,{class:'error-text',role:'alert'}):null,deletionBlockerPanel(tracker),
    confirmable?field(`Type ${receipt.repository.name} to ${receipt.status==='failed'?'resume deletion':'confirm'}`,typed,'This confirmation permanently retires the Design System and cannot be undone.'):null,
    node('div',{class:'dialog-actions'},close,refresh,receipt.status==='awaiting_confirmation'?button('Prepare a new review',async()=>{const operationId=crypto.randomUUID();save(deletionKey(tracker.system.id),{operationId});await deleteSystemDialog(tracker.system,operationId);},'quiet'):null,confirmable?confirm:null,receipt.status==='completed'?button('Retained history',async()=>{const history=await api(`/api/timds/admin/systems/${enc(tracker.system.id)}/deletion/${enc(receipt.operationId)}/history`);if(deletionVisible(tracker)){const existing=host.querySelector('.retained-history');existing?.remove();host.append(node('div',{class:'retained-history'},details('Retained session and audit descriptors',history)));}},'quiet'):null));
}
// One session per idempotency key: a retry after an ambiguous response lands on the same session.
async function createSession(key,draft='',source=state.source){const result=await api('/api/timds/sessions',{systemId:source.systemId,idempotencyKey:key,...(draft?{draft}:{})});if(!result.session?.id||result.session.sourceId!==source.id)throw new Error('The host did not return a matching session. Retry with the same session details.');return result.session.id;}
async function copyText(value,element){try{await navigator.clipboard.writeText(value);notice('Copied to the clipboard.');}catch{const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(element);selection.removeAllRanges();selection.addRange(range);notice('Text selected. Use your device’s Copy command.');}}
function snippet(lines){const value=lines.join('\n'),code=title('pre',value,{class:'code',tabIndex:0});return node('div',{class:'snippet'},code,button('Copy',()=>copyText(value,code),'small quiet'));}

// Published deliverables use the existing read-only MCP tool. Credentials only
// reach this fixed same-origin route; public URLs are links, never API origins.
// One JSON-RPC tool call to the host's authenticated MCP endpoint; JSON or SSE replies.
async function mcpCall(name,args,unavailable){
  const accessToken=await freshToken();
  const id=crypto.randomUUID(),response=await fetch('/api/timds/mcp',{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
  if(response.status===401){disconnect(false);throw new Error('Connect again to continue.');}
  if(!response.ok)throw new Error(unavailable);
  const body=await response.text();
  const messages=response.headers.get('Content-Type')?.includes('text/event-stream')?body.split(/\r?\n\r?\n/).map(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(value=>JSON.parse(value)):[JSON.parse(body)];
  const result=messages.find(message=>message.id===id)?.result;
  if(!result||result.isError)throw new Error(unavailable);
  return result.structuredContent;
}
async function readDeliverables(systemId){
  const data=await mcpCall('read_derived_layer',{systemId},'Published deliverables could not be loaded. Try again in a moment.');
  if(data?.source?.systemId!==systemId||!data.release||!data.layer||!safeUrl(data.publicRoot)||!safeUrl(data.layer.source?.base))throw new Error('Published deliverables are unavailable. Refresh to try again.');
  return data;
}
async function loadDeliverables(force=false){
  if(!state.source||!['overview','deliverables'].includes(state.view))return;
  const source=state.source,marker=JSON.stringify((state.work?.publicationEvents||[]).map(row=>[row.id,row.design_system_version_id,row.action,row.created_at]).sort()),previous=state.delivery;
  if(previous?.sourceId===source.id&&previous.marker===marker&&(!force||previous.status==='loading'))return;
  const delivery={sourceId:source.id,marker,status:'loading',data:null};state.delivery=delivery;patchDelivery();
  try{
    const view=await api(`/api/timds/design-systems/${enc(source.id)}`);
    if(state.delivery!==delivery||state.source?.id!==source.id)return;
    if(!view.currentVersion){if(view.source?.publishedVersionId)throw new Error('Published release is unavailable');delivery.status='empty';}
    else{delivery.data=await readDeliverables(source.systemId);delivery.status='ready';}
  }catch{delivery.status='error';delivery.data=null;}
  if(state.delivery===delivery&&state.source?.id===source.id)patchDelivery();
}
function patchDelivery(){const target=$('#delivery');if(target)target.replaceWith(deliveryView(state.view==='deliverables'));}
const publishedRows=value=>Array.isArray(value)?value:[];
// Client deliverables must use a public-facing domain. Never guess a branded
// replacement for an infrastructure URL: the host must advertise a routed origin.
function clientUrl(value,root){const href=safeUrl(value);if(!href)return null;const url=new URL(href),host=url.hostname.replace(/\.$/,'');if(root&&url.origin!==new URL(root).origin)return null;return url.protocol==='https:'&&host.includes('.')&&!/(^|\.)(workers\.dev|pages\.dev|r2\.dev|localhost)$/.test(host)&&!/^\d+(?:\.\d+){3}$/.test(host)?href:null;}
const deliveryShareable=data=>Boolean(clientUrl(data?.publicRoot)&&clientUrl(data?.layer?.source?.base,data?.publicRoot));
function publishedPath(data,path){if(typeof path!=='string'||!path||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..'))return null;return clientUrl(`${data.layer.source.base.replace(/\/$/,'')}/${path.split('/').map(enc).join('/')}`,data.publicRoot);}
function deliveryResources(data){const layer=data.layer,documents=layer.provenance?.files||{};return[
  {key:'brand',mark:'Aa',name:'Brand essentials',description:'Identity, voice, logos and typography, collected in one brand reference.',action:'Open brand data'},
  {key:'tokens',mark:'{ }',name:'Design tokens',description:'Resolved colors, spacing and type values for a consistent implementation.',action:'Open tokens'},
  {key:'designs',mark:'▤',name:'Design references',description:'Published screens, page designs and states to guide your next build.',action:'Open design catalog'},
  {key:'formats',mark:'↗',name:'Formats & templates',description:'Specifications for the digital, social and print formats in this system.',action:'Open formats'},
  {key:'bundle',mark:'↓',name:'Implementation files',description:'The stylesheets, scripts and assets packaged for your product.',action:'Open file manifest'},
  {key:'llms',mark:'✳',name:'AI-ready guidance',description:'A readable introduction for AI tools working with your design system.',action:'Open AI guide'},
].map(item=>({...item,url:layer[item.key]!=null?publishedPath(data,documents[item.key]):null,browseUrl:item.key==='designs'?clientUrl(layer.designs?.url,data.publicRoot):null}));}
function deliveryModel(data){
  const files=publishedRows(data.layer.bundle?.files).filter(file=>typeof file.path==='string'&&clientUrl(file.url,data.publicRoot)),pages=publishedRows(data.layer.index?.pages).filter(page=>clientUrl(page.url,data.publicRoot)),tokens=publishedRows(data.layer.tokens?.tokens),brand=data.layer.brand;
  const brandMedia=[...publishedRows(brand?.logos),...publishedRows(brand?.imagery)].map(asset=>({title:asset.name,publicUrl:asset.media?.url,kind:asset.role==='logo'?'Logo':'Imagery',bytes:asset.media?.bytes}));
  const fonts=Object.entries(brand?.roles||{}).flatMap(([name,role])=>publishedRows(role?.files).map(file=>({title:role.family||name,publicUrl:file.url,kind:'Font',bytes:file.bytes})));
  const media=[...new Map([...brandMedia,...fonts,...publishedRows(data.media?.assets)].filter(asset=>clientUrl(asset.publicUrl,data.publicRoot)).map(asset=>[asset.publicUrl,asset])).values()];
  const version=data.release.versionLabel,pinned=data.layer.source.base===data.publicUrls?.version;
  // The consumer CLI expects bundle.json at the artifact root. Do not suggest
  // an install that would resolve a different same-label release or nested file.
  // The command matches docs/consuming/: the CLI at @latest, no toolkit version,
  // and no --version so init pins the release that is current when it runs.
  // AI tools get the public, read-only MCP at /mcp on the public origin; the
  // authenticated designer MCP is not part of the client handoff.
  const installable=pinned&&data.layer.provenance?.files?.bundle==='bundle.json'&&files.length>0&&data.layer.bundle?.system?.id===data.source.systemId&&data.layer.bundle?.system?.version===version;
  const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
  const command=installable?`npx --yes @dtconcepts/timds@latest consumer init \\\n  --system ${quote(data.source.systemId)} \\\n  --url ${quote(data.publicRoot.replace(/\/$/,''))}`:null;
  return{files,pages,tokens,media,version,pinned,command,resources:deliveryResources(data),mcp:new URL('/mcp',data.publicRoot).href};
}
function deliveryCover(data,model){const colors=[...new Map(model.tokens.filter(token=>token.kind==='color'&&/^#(?:[a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(token.resolved||token.value||'')).map(token=>[token.resolved||token.value,token])).values()].slice(0,5);
  return node('div',{class:'delivery-cover'},title('span','THE PUBLISHED COLLECTION',{class:'eyebrow'}),title('span',data.source.name||state.source.name,{class:'cover-name'}),title('span',model.version,{class:'cover-version mono'}),node('div',{class:'cover-palette','aria-label':colors.length?'A sample of the published color tokens':'Design system collection'},...(colors.length?colors.map(token=>{const chip=swatch(token.resolved||token.value);chip.title=`${token.name}: ${token.resolved||token.value}`;chip.removeAttribute('aria-hidden');chip.setAttribute('role','img');chip.setAttribute('aria-label',chip.title);return chip;}):[title('span','Aa',{class:'cover-letter','aria-hidden':'true'})])));
}
function deliveryHero(data,model,full){const open=link('Explore the published system ↗',data.publicRoot);open?.classList.add('primary');return node('section',{class:'delivery-hero'},node('div',{class:'delivery-intro'},node('div',{class:'title-line'},title('span','READY TO SHARE',{class:'eyebrow'}),title('span',model.version,{class:'badge success'})),title('h2','Good design. Ready for the real world.'),title('p','Your published guide, reusable assets and implementation essentials. Everything your team needs to make the next thing feel like you.'),node('div',{class:'actions'},open,button('Prepare client handoff',()=>handoffDialog(data),'quiet')),node('div',{class:'delivery-facts'},title('span',`${model.pages.length} guidance pages`),title('span',`${model.tokens.length} design tokens`),title('span',`${model.files.length} implementation files`)),full?null:button('View all deliverables →',()=>navigate('deliverables'),'delivery-more quiet')),deliveryCover(data,model));}
function deliveryView(full=false){const host=node('div',{id:'delivery',class:'delivery'}),delivery=state.delivery;
  if(!delivery||delivery.sourceId!==state.source.id||delivery.status==='loading'){host.append(node('section',{class:'panel'},loadingBlock('Gathering your published collection…','The guide, assets and implementation details will appear here.')));return host;}
  if(delivery.status==='error'){host.append(panel('We couldn’t load the published collection.',title('p','Try again to get the current deliverables and share links.',{class:'help'}),button('Try again',()=>loadDeliverables(true),'small')));return host;}
  if(delivery.status==='empty'){host.append(node('section',{class:'delivery-empty panel'},title('div','FROM DESIGN TO DELIVERY',{class:'eyebrow'}),title('h2','A home for the finished work.'),title('p','Publish your first release to bring the guide, design assets and implementation files together here. Then share the collection with your client.'),button('Go to review',()=>navigate('review'),'primary')));return host;}
  const data=delivery.data;if(!deliveryShareable(data)){host.append(panel('Your public address is being prepared.',title('p','The published collection needs a public-facing web address before it can be shared with clients. Ask your host administrator to finish public hosting, then refresh.',{class:'help'}),button('Refresh public links',()=>loadDeliverables(true),'small')));return host;}const model=deliveryModel(data);host.append(deliveryHero(data,model,full));
  if(!full){host.append(node('div',{class:'delivery-shortcuts'},...model.resources.filter(item=>item.url).slice(0,4).map(item=>node('a',{href:item.url,target:'_blank',rel:'noopener noreferrer'},title('span',item.mark,{'aria-hidden':'true'}),item.name,title('span','↗',{'aria-hidden':'true'})))));return host;}
  host.append(node('div',{class:'section-head'},title('h2','Your deliverables.'),title('p','Choose what you need. Each export comes from the published collection.')),node('div',{class:'delivery-grid'},...model.resources.map(item=>node('article',{class:`panel deliverable${item.url?'':' unavailable'}`},title('span',item.mark,{class:'deliverable-mark','aria-hidden':'true'}),title('h3',item.name),title('p',item.description),item.url?node('div',{class:'actions'},link(`${item.action} ↗`,item.url),item.browseUrl?link('Browse designs ↗',item.browseUrl):null):title('span','Not included in this release',{class:'help'})))));
  host.append(implementationPanel(data,model),deliveryLibrary(data,model));return host;
}
function implementationPanel(data,model){const guide=model.resources.find(item=>item.key==='llms');return node('section',{class:'panel implementation'},node('div',{class:'section-head'},title('div','MAKE IT PART OF YOUR WORK',{class:'eyebrow'}),title('h2','From handoff to first build.')),node('div',{class:'implementation-grid'},node('div',{},title('span','01',{class:'step-number'}),title('h3','Get to know the system'),title('p','Start with the published guide for the visual language, components and usage decisions.'),link('Open the guide ↗',data.publicRoot),model.pinned?link(`View release ${model.version} ↗`,data.layer.source.base):null,title('p','The main guide follows new releases. A release link stays on that version.',{class:'help'})),node('div',{},title('span','02',{class:'step-number'}),title('h3','Bring it into your product'),title('p',model.command?'Run this in your product’s Git repository to pin the current release, install its bundle and set up future installs.':'Open the file manifest and download the files you need, preserving their relative paths.'),model.command?snippet([model.command]):link('Open file manifest ↗',model.resources.find(item=>item.key==='bundle')?.url),title('p',model.command?'Files are restored into design-system/ by npm ci. Use them in your app; choose when to move to a newer release.':model.files.length?'This release uses a custom bundle layout. Its manifest supplies the published file URLs.':'An implementation bundle has not been included in this release.',{class:'help'})),node('div',{},title('span','03',{class:'step-number'}),title('h3','Give your AI the same context'),title('p','Add this public, read-only MCP server to your AI tool. No sign-in or Studio account is needed.'),snippet([model.mcp]),snippet([`Use the design system ${JSON.stringify(data.source.systemId)}. Read describe_system, then get_tokens and read_page for the relevant guidance before implementing.`]),title('p',guide?.url?'Tools without MCP can read the AI guide (llms.txt) instead; it leads to the tokens, brand data and guidance pages.':'Tools without MCP can start from the published guide instead.',{class:'help'}),guide?.url?link('Read the AI guide ↗',guide.url):null)));
}
function deliveryLibrary(data,model){
  const search=node('input',{id:'deliverable-search',type:'search',placeholder:'Search files and assets…'}),list=node('div',{class:'asset-list'}),count=title('p','',{class:'help',role:'status'}),rows=[...model.files.map(file=>({name:file.path,url:file.url,kind:'Bundle file',bytes:file.bytes})),...model.media.map(asset=>({name:asset.title||asset.key||'Published asset',url:asset.publicUrl,kind:asset.kind||'Media',bytes:asset.bytes}))];
  const render=()=>{const query=search.value.trim().toLowerCase(),matches=rows.filter(row=>`${row.name} ${row.kind}`.toLowerCase().includes(query));count.textContent=`${matches.length} ${matches.length===1?'file':'files'}${matches.length>60?' · Showing the first 60. Refine your search to find more.':''}${data.media?.truncated?' · Media catalog is limited to the first 1,000 records.':''}`;list.replaceChildren(...(matches.length?matches.slice(0,60).map(row=>{const open=link('Open ↗',row.url);open.setAttribute('aria-label',`Open ${row.name} in a new tab`);return node('div',{class:'asset-row'},node('div',{},title('strong',row.name),title('span',[row.kind,Number.isFinite(row.bytes)?`${Math.max(1,Math.round(row.bytes/1024))} KB`:null].filter(Boolean).join(' · '),{class:'card-meta'})),open);}):[empty(query?'No matching files':'No downloadable files yet',query?'Try a filename or asset type.':'The guide and any available data exports are linked above.')]));};search.addEventListener('input',render);render();
  const pages=model.pages;return node('div',{class:'delivery-library'},node('section',{class:'panel'},title('h2','Files & assets'),title('p','Open a published file to use or save it. Bundle paths match the folders in the implementation package.',{class:'help'}),field('Find a file',search),count,list),node('section',{class:'panel'},title('h2','Inside the guide'),title('p','A direct route to the guidance your team needs.',{class:'help'}),node('div',{class:'guide-directory'},...(pages.length?pages.slice(0,30).map(page=>link(`${page.title||page.id} ↗`,page.url)):[link('Explore the guide ↗',data.publicRoot)])),pages.length>30?title('p','Open the full guide for all pages.',{class:'help'}):null));
}
function handoffDialog(data){if(!deliveryShareable(data))throw new Error('A public-facing address is required before sharing this collection.');const model=deliveryModel(data),guide=model.resources.find(item=>item.key==='llms'),lines=[`${data.source.name} — design system handoff`,`Published release: ${model.version}`,'','START HERE',`Published guide: ${data.publicRoot}`,...(model.pinned?[`This release: ${data.layer.source.base}`]:[]),'The main guide follows new releases. Use a release link when you need a fixed version.','','DELIVERABLES',...model.resources.filter(item=>item.url).map(item=>`${item.name}: ${item.url}`),'','IMPLEMENTATION',...(model.command?['Run in your product’s Git repository:',model.command,'Files are installed into design-system/. Future npm ci runs restore the pinned release.']:['Open the implementation manifest, when available, and save its files with their relative paths.']),'','AI TOOLS',`Public, read-only MCP server: ${model.mcp}`,`System: ${data.source.systemId}`,'Ask your AI tool to read describe_system, get_tokens and read_page before implementing. No sign-in is needed.',...(guide?.url?[`Without MCP, start from the AI guide (llms.txt): ${guide.url}`]:[]),'','These published links can be opened without a Studio account.'];const value=lines.join('\n'),preview=title('pre',value,{class:'code handoff-preview',tabIndex:0});showDialog('Ready to hand over.',title('p','Copy this introduction into your client email, project notes or delivery document. It includes the public links and setup instructions.'),preview,node('div',{class:'dialog-actions'},button('Close',()=>$('#dialog').close()),button('Copy client handoff',()=>copyText(value,preview),'primary')));}
// The Overview explains the three ways to edit: Studio, an MCP client, or the toolkit on disk.
function waysOverview(){const origin=location.origin,systemId=state.source.systemId||'',folder=systemId.split('/').pop()||'design-system';let key=crypto.randomUUID();return node('div',{class:'ways'},
  node('section',{class:'panel way tint'},title('div','01 · In your browser',{class:'eyebrow'}),title('h2','Open Studio'),title('p','Start a working session and direct an agent from here: ask for a change, watch it happen in the live view, and review it before it goes out.'),node('div',{class:'actions'},button('Open Studio',async()=>{const id=await createSession(key);key=crypto.randomUUID();navigate('studio',id);},'primary'),button('Start from a draft…',()=>startSessionDialog(),'quiet')),title('p','Opens a new session on the current system. Drafts and sessions already open are listed below.',{class:'help'})),
  node('section',{class:'panel way'},title('div','02 · From your agent',{class:'eyebrow'}),node('div',{class:'row-between'},title('h2','Send your agent'),badge('preview')),title('p','Put Claude Code, Codex, Cursor or any MCP client straight into this Design System. One click copies the connection and a brief that tells it what to do here.'),node('div',{class:'actions'},button('Send to your agent…',()=>agentDialog(null),'primary')),title('p','Your agent signs in as you with OAuth, so your Design System permissions apply. It reads the system, edits in a hosted session and submits for review here; publishers can also publish through it.',{class:'help'}),title('p','The full contribution lifecycle is implemented. Verification on a deployed host is still pending.',{class:'help'})),
  node('section',{class:'panel way'},title('div','03 · On your machine',{class:'eyebrow'}),title('h2','Edit locally with npm'),title('p','Install the toolkit, pull a session to disk, work with your own tools, and submit it back here for review.'),snippet([`npm install --global ${TOOLKIT}`,`timds auth login --portal-url ${origin} --oauth`,`timds start ${systemId} --root ./${folder} --portal-url ${origin}`,`cd ${folder}`,'npm ci','timds dev','timds submit --note "Describe the change"']),title('p','This starts a new session. To work in one that is already open, use the join command from Invite… in its Studio. Submissions from the toolkit appear under Review like any other.',{class:'help'})));}
function startSessionDialog(){const source={id:state.source.id,systemId:state.source.systemId},principalId=state.principal.id,drafts=(state.work.drafts||[]).filter(row=>row.status==='open'),select=node('select',{id:'start-draft'},node('option',{value:''},'Main Design System'),...drafts.map(row=>node('option',{value:row.name||row.id},row.name||short(row.id))));const key=crypto.randomUUID(),starting=loadingLine('Starting a working session… this can take a moment.');let submittedDraft=null;starting.hidden=true;showDialog('Open a working session',title('p','Start from the current system or a shared draft. Agents work in it when you send Requests.'),field('Start from',select),starting,node('div',{class:'dialog-actions'},cancelButton(),button('Open Studio',async()=>{if(state.principal?.id!==principalId)throw new Error('Sign in again before creating this session.');submittedDraft??=select.value;starting.hidden=false;select.disabled=true;try{const id=await createSession(key,submittedDraft,source);if(state.principal?.id!==principalId)return;if(starting.isConnected&&$('#dialog').open){$('#dialog').close();location.hash=new URLSearchParams({source:source.id,view:'studio',session:id}).toString();}else notice('Session created. Open it from Sessions when you are ready.');}finally{starting.hidden=true;}},'primary')));}
function startDraftDialog(){const sourceId=state.source.id,principalId=state.principal.id,name=node('input',{id:'draft-name',placeholder:'spring-refresh',maxLength:80}),key=crypto.randomUUID(),starting=loadingLine('Creating the shared draft… this can take a moment.');let submittedName=null;starting.hidden=true;showDialog('Create a shared draft',title('p','Name the draft, then open its Studio to direct the work.'),field('Draft name',name,'Use lowercase letters, numbers, and hyphens.'),starting,node('div',{class:'dialog-actions'},cancelButton(),button('Create draft',async()=>{if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name.value))throw new Error('Choose a lowercase draft name using letters, numbers, and hyphens.');if(state.principal?.id!==principalId)throw new Error('Sign in again before creating this draft.');submittedName??=name.value;name.disabled=true;starting.hidden=false;try{const result=await api(`/api/timds/design-systems/${enc(sourceId)}/drafts`,{name:submittedName,idempotencyKey:key});if(!result.session?.id||result.session.sourceId!==sourceId)throw new Error('The host did not return a matching draft. Retry with the same name.');if(state.principal?.id!==principalId)return;if(starting.isConnected&&$('#dialog').open){$('#dialog').close();location.hash=new URLSearchParams({source:sourceId,view:'studio',session:result.session.id}).toString();}else notice('Draft created. Open it from Sessions when you are ready.');}finally{starting.hidden=true;}},'primary')));}

// ---- Review: Preview frames, stage strip, publish --------------------------
const STAGES=['preflight','merge','build','prepare','release','flip','close'];
function stageStrip(publication){if(!publication)return null;const status=publication.status,index=STAGES.indexOf(publication.stage),flip=STAGES.indexOf('flip'),live=['published','closing','closed'].includes(status);
  const mark=i=>{if(status==='failed')return i<index?'done':i===index?'fail':'';if(live){if(publication.completedAt||status==='closed')return'done';const reached=Math.max(index,flip);return i<=reached&&!(i===index&&STAGES[i]==='close')?'done':i===index?'now':'';}return i<index?'done':i===index?'now':'';};
  return node('div',{class:'steps',role:'group','aria-label':`Release ${status}${publication.stage?`, ${publication.stage}`:''}`},status==='queued'?title('span',publication.queuePosition?`queued #${publication.queuePosition}`:'queued',{class:'now'}):null,...STAGES.map((name,i)=>title('span',name,{class:mark(i)})));}
function publicationStatus(row){return node('div',{},title('p',`${row.stage||row.status}${row.queuePosition?` · Queue position ${row.queuePosition}`:''}${row.result?.version?` · ${row.result.version}`:''}`,{class:'card-meta'}),row.error?title('p',`${row.error} The host may retry this publication; refresh its status.`,{class:'error-text'}):null,link('Published release ↗',clientUrl(row.result?.versionedUrls?.root||row.result?.url)));}
function changedPaths(diff){if(Array.isArray(diff))return diff.map(item=>typeof item==='string'?item:item?.path||item?.newPath||item?.oldPath).filter(Boolean);if(typeof diff==='string')return[...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map(match=>match[1]);return[];}
// The changelog: one row per file in the submission's unified diff with its
// added and removed line counts, so the reviewer reads what goes out before publishing.
function diffStat(diff){if(!(typeof diff==='string'))return changedPaths(diff).map(path=>({path,added:0,removed:0}));const rows=[];let row=null;for(const line of diff.split('\n')){const head=line.match(/^diff --git a\/(.+?) b\//);if(head){row={path:head[1],added:0,removed:0};rows.push(row);continue;}if(!row||line.startsWith('+++ ')||line.startsWith('--- '))continue;if(line[0]==='+')row.added++;else if(line[0]==='-')row.removed++;}return rows;}
function changelog(diff,limit=12){const rows=diffStat(diff);if(!rows.length)return null;const more=rows.length-limit;return node('div',{class:'changelog'},title('p',`${rows.length} changed file${rows.length===1?'':'s'}`,{class:'changelog-count'}),node('ul',{class:'changelog-list'},...rows.slice(0,limit).map(row=>node('li',{},title('code',row.path),row.added||row.removed?title('span',`+${row.added} −${row.removed}`,{class:'changelog-stat'}):null))),more>0?title('p',`${more} more file${more===1?'':'s'} changed.`,{class:'help'}):null);}
function reviewInfo(row){const pub=row.publication,where=sessionById(row.sessionId),open=state.previews.has(row.id),conflict=state.conflicts.get(row.id);
  return[node('div',{class:'card-title'},title('h3',row.note||`Submission ${short(row.id)}`),badge(pub?.status||row.status)),title('p',[date(row.createdAt),where?sessionLabel(where):null,row.targetDraftSessionId?'Integrated into a draft':null].filter(Boolean).join(' · '),{class:'card-meta'}),stageStrip(pub),pub?publicationStatus(pub):null,changelog(row.diff,6),conflict?conflictSection(conflict.conflicts,row.sessionId,`publish:${row.id}`,'Publishing found changes to the same values in the current release.'):null,
    node('div',{class:'actions'},safeUrl(row.previewUrl)?button(open?'Hide Preview':'Show Preview here',async()=>{document.activeElement?.blur();if(open)state.previews.delete(row.id);else state.previews.add(row.id);const card=document.getElementById(`review-${row.id}`);if(card)patchReviewCard(card,row);},'small'):null,link('Open Preview ↗',row.previewUrl),row.sessionId?button('Open Studio',()=>navigate('studio',row.sessionId),'small quiet'):null,state.work.canPublish&&!row.targetDraftSessionId&&['submitted','publishing'].includes(row.status)?button(pub?'Publication status':'Publish…',()=>publicationDialog(row),'small primary'):null)];}
function syncPreview(card,row){const slot=card.querySelector('.review-frame');if(!slot)return;const open=state.previews.has(row.id)&&Boolean(safeUrl(row.previewUrl));if(open&&!slot.firstChild)slot.append(frameView({url:row.previewUrl,submissionId:row.id,label:`Preview of ${row.note||`submission ${short(row.id)}`}`}));else if(!open&&slot.firstChild)slot.replaceChildren();}
function reviewCard(row){const card=node('article',{class:'review-card',id:`review-${row.id}`,'data-submission':row.id},node('div',{class:'review-info'},reviewInfo(row)),node('div',{class:'review-frame'}));syncPreview(card,row);return card;}
function patchReviewCard(card,row){const info=card.querySelector('.review-info');if(info&&!editing(info))info.replaceChildren(...reviewInfo(row).filter(Boolean));syncPreview(card,row);}
function reviewList(){return node('div',{id:'review-list',class:'list'},...(state.submissions.length?state.submissions.map(reviewCard):[empty('Nothing waiting for review','Send a Request; the agent submits its change here with a Preview.')]));}
// Keyed patch: existing cards (and their Preview frames) are never moved or rebuilt.
function patchReviewList(){const list=$('#review-list');if(!list)return;if(!state.submissions.length||!list.querySelector(':scope>[data-submission]')){list.replaceWith(reviewList());return;}const wanted=new Set(state.submissions.map(row=>row.id));for(const card of list.querySelectorAll(':scope>[data-submission]'))if(!wanted.has(card.dataset.submission))card.remove();let previous=null;for(const row of state.submissions){let card=document.getElementById(`review-${row.id}`);if(card&&card.parentElement===list)patchReviewCard(card,row);else{card=reviewCard(row);if(previous)previous.after(card);else list.prepend(card);}previous=card;}}
async function publicationDialog(submission){showDialog('Check this publication',title('p',submission.note||`Submission ${short(submission.id)}`),loadingLine('Checking current permissions and whether these changes can merge…'),node('div',{class:'dialog-actions'},cancelButton()));const result=await api(`/api/timds/submissions/${enc(submission.id)}/publish`,{preflight:true});
  if(Array.isArray(result.conflicts)){state.conflicts.set(submission.id,{conflicts:result.conflicts,sessionId:submission.sessionId,mainRevision:result.mainRevision||null});patchReviewList();if(state.view==='studio')patchStudio();showDialog('This change overlaps the current release',title('p','Another release changed the same values. An agent resolves conflicts: ask it to reconcile them in this session and submit again.',{class:'help'}),conflictReceipt(result.conflicts),node('div',{class:'dialog-actions'},cancelButton(),askAgentButton(submission.sessionId,result.conflicts,`publish:${submission.id}`,()=>$('#dialog').close())));return;}
  const receipt=result.preflight;if(!receipt)throw new Error('The host did not return a publication check');state.conflicts.delete(submission.id);showDialog('Publish this change?',title('p',submission.note||`Submission ${short(submission.id)}`),node('div',{class:'panel tint'},title('h3',receipt.version||'New release'),title('p',receipt.currency==='published'?'This change is already published.':`${receipt.diffSummary?.files??0} changed file(s) · ${receipt.autoRebased?'Merged with current work':'Ready to merge'}`,{class:'help'})),changelog(submission.diff)||title('p','The host did not return this submission’s file list. Open the Preview to review it.',{class:'help'}),link('Open Preview ↗',submission.previewUrl),details('Publication check',receipt),title('p','Publishing updates the public release after validation. The host finishes in the background.',{class:'help'}),node('div',{class:'dialog-actions'},cancelButton(),button('Build check only',async()=>{const checked=await api(`/api/timds/submissions/${enc(submission.id)}/publish`,{dryRun:true});notice(checked.preflight?.buildChecked?'Build check passed. No release was published.':'Check completed.');},'quiet'),button(receipt.currency==='published'?'View status':'Publish release',async()=>{const accepted=await api(`/api/timds/submissions/${enc(submission.id)}/publish`,{});if(!accepted.publication)throw new Error('Refresh status before retrying: the host did not return a publication receipt.');$('#dialog').close();const current=state.submissions.find(row=>row.id===submission.id);if(current)current.publication={...accepted.publication};renderPublishing();notice('Publication accepted. Publishing shows in the top bar until the release is live.');await refresh(true);},'primary')));}
function applyPublicationEvent(event){const row=state.submissions.find(item=>item.id===event.submission_id);if(!row)return;const detail=detailsOf(event),pub={...(row.publication||{status:'queued',stage:null})},type=event.event_type;
  if(type==='publication_queued'){pub.status='queued';pub.queuePosition=detail.queuePosition??pub.queuePosition;}
  else if(type==='publication_stage'){pub.stage=detail.stage||pub.stage;if(!['published','closing','closed'].includes(pub.status))pub.status='running';}
  else if(type==='publication_failed'){pub.status='failed';pub.stage=detail.stage||pub.stage;pub.error=detail.error||pub.error||'The publication stopped.';}
  else if(type==='published'){pub.status='published';if(STAGES.indexOf(pub.stage)<STAGES.indexOf('flip'))pub.stage='flip';}
  else return;
  row.publication=pub;renderPublishing();const card=document.getElementById(`review-${row.id}`);if(card)patchReviewCard(card,row);if(state.view==='studio'&&state.session)patchStudio();}
function releaseList(limit=0){const events=[...(state.work.publicationEvents||[])].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),rows=limit?events.slice(0,limit):events;return node('div',{class:'list','data-releases':String(limit)},...(rows.length?rows.map(event=>node('article',{class:'work-card'},node('div',{class:'card-title'},title('h3',event.version_label||'Release'),badge(event.action)),title('p',date(event.created_at),{class:'card-meta'}),event.reason?title('p',event.reason,{class:'help'}):null,state.work.canPublish&&event.design_system_version_id?button('Restore this release',()=>rollbackDialog(event),'small'):null)):[empty('No release yet','Published versions and rollbacks appear here.')]));}
function renderReleaseLists(){for(const target of $$('[data-releases]'))if(!editing(target))target.replaceWith(releaseList(Number(target.dataset.releases)||0));}
function rollbackDialog(event){const reason=node('textarea',{id:'rollback-reason',placeholder:'Why are you restoring this version?',maxLength:2000});let checked=false;const action=button('Check rollback',async()=>{if(!checked){const result=await api(`${sourcePath()}/rollback`,{versionId:event.design_system_version_id,reason:reason.value,dryRun:true});checked=true;action.textContent='Restore release';reason.disabled=true;$('#dialog').insertBefore(details('Rollback check',result),$('#dialog').lastChild);return;}await api(`${sourcePath()}/rollback`,{versionId:event.design_system_version_id,reason:reason.value});$('#dialog').close();notice(`Public release restored to ${event.version_label}.`);await refresh(true);},'primary');showDialog(`Restore ${event.version_label}?`,title('p','This switches the public pointer to this previously published artifact. The source history remains available.'),field('Reason',reason),node('div',{class:'dialog-actions'},cancelButton(),action));}

// ---- Conflicts: a read-only receipt and one way forward (an agent) ---------
const swatch=value=>{if(typeof value!=='string'||!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim()))return null;const chip=node('span',{class:'swatch','aria-hidden':'true'});chip.style.setProperty('background-color',value.trim());return chip;};
const describe=value=>{const result=value===null||value===undefined?'(absent)':typeof value==='string'?value:value?.truncated?'(large value)':value?.bytes!==undefined?`file, ${value.bytes} bytes`:JSON.stringify(value);return result.length>200?`${result.slice(0,197)}…`:result;};
function conflictReceipt(conflicts){return node('div',{class:'conflict-list'},...conflicts.slice(0,50).map(item=>node('div',{class:'conflict'},title('code',item.key?`${item.path}#${item.key}`:item.path),node('dl',{class:'conflict-values'},...[['Base',item.base],['Mine',item.mine],['Theirs',item.theirs]].flatMap(([label,value])=>[title('dt',label),node('dd',{},swatch(value),title('span',describe(value),{class:'val'}))])))),conflicts.length>50?title('p',`${conflicts.length-50} more conflicts are not shown.`,{class:'help'}):null);}
const promptValue=value=>{const result=value===null||value===undefined?'absent':typeof value==='string'?value:JSON.stringify(value);return result.length>120?`${result.slice(0,117)}…`:result;};
function conflictPrompt(conflicts){const items=conflicts.slice(0,40).map(item=>`${item.key?`${item.path}#${item.key}`:item.path} — mine ${promptValue(item.mine)}, theirs ${promptValue(item.theirs)} (base ${promptValue(item.base)})`);return`Resolve the conflicts in this session and submit${items.length?`: ${items.join('; ')}${conflicts.length>40?`; and ${conflicts.length-40} more`:''}`:''}. Keep the intent of the latest Request and prefer the value that satisfies it; update related tokens for consistency.`;}
function askAgentButton(sessionId,conflicts,key,after){if(state.resolving.has(key))return title('p','Resolution requested. The agent’s progress appears in Requests.',{class:'help'});return button('Ask the agent to resolve',async()=>{if(!sessionId)throw new Error('This conflict has no session to send a Request to.');await sendTracked(conflictPrompt(conflicts||[]),sessionId);state.resolving.add(key);after?.();await refresh(true);notice('Request sent. The agent will resolve the conflicts and submit again.');},'primary');}
function conflictSection(conflicts,sessionId,key,message){return node('div',{class:'conflict-panel'},title('div','CONFLICT',{class:'eyebrow'}),title('p',message,{class:'help'}),conflicts?.length?conflictReceipt(conflicts):title('p','The host did not return the conflicting values; the agent can read them in the session.',{class:'help'}),node('div',{class:'actions'},askAgentButton(sessionId,conflicts,key)));}
function sessionConflicts(row,canRequest){const parts=[];if(row.runner?.state==='conflicted')parts.push(conflictSection(row.runner.conflicts||[],row.id,`runner:${row.id}:${row.runner.requestId||''}`,row.runner.error||'The latest Request overlaps a newer change.'));for(const [submissionId,entry]of state.conflicts)if(entry.sessionId===row.id)parts.push(conflictSection(entry.conflicts,row.id,`publish:${submissionId}`,'Publishing a submission from here found changes to the same values in the current release.'));if(!parts.length)return null;if(!canRequest)parts.push(title('p','Only the owner or a publisher can ask the agent to resolve conflicts here.',{class:'help'}));return node('section',{class:'panel conflict-host'},title('h2','Two changes touched the same values'),...parts);}

// ---- Session and draft page ------------------------------------------------
async function openSession(id){const generation=state.generation,sourceId=state.source.id;const status=await busy(api(`/api/timds/sessions/${enc(id)}/status`));if(generation!==state.generation)return;if(status.session.sourceId!==sourceId)throw new Error('This session belongs to another Design System');if(state.session?.session.id!==id)state.composer.here='';state.session=status;markWaking(id);renderMain();feedViewing();}
const canRequestIn=()=>state.session?.session.status==='open'&&state.session.canInvite===true;
function sessionSubmissions(pending=false){const rows=[...(state.session.submissions||[])].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));return rows.length?node('div',{class:'list'},...rows.map(row=>{const full=state.submissions.find(item=>item.id===row.id)||row,pub=full.publication||null,publishable=state.work?.canPublish&&!row.targetDraftSessionId&&['submitted','publishing'].includes(full.status||row.status);return node('article',{class:'work-card'},node('div',{class:'card-title'},title('h3',row.note||`Submission ${short(row.id)}`),badge(pub?.status||full.status||row.status)),title('p',date(row.createdAt),{class:'card-meta'}),stageStrip(pub),changelog(full.diff??row.diff,6),node('div',{class:'actions'},publishable?button(pub?'Publication status':'Publish…',()=>publicationDialog(full),'small primary'):null,link('Preview ↗',row.previewUrl)));})):empty(pending?'Nothing submitted yet':'Nothing to publish yet',pending?'The changes above are not reviewable until the designer submits them.':'The designer submits here when a Request is done.');}
// ---- Changes since the last submission -------------------------------------
// Every edit the host records for a session is an `updated` event: API and MCP
// update_session saves, draft integrations, and commits reconciled from the
// session's container. Those newer than the session's last submission are
// pending: visible here, but nothing to review or publish until an agent submits.
const sessionEventsOf=id=>(state.work?.events||[]).filter(event=>event.session_id===id);
function pendingChanges(id){const events=sessionEventsOf(id).sort(eventOrder),last=events.find(event=>event.event_type==='submitted'),latest=[...(state.session?.submissions||[])].map(row=>String(row.createdAt||'')).sort().pop()||'';
  return events.filter(event=>event.event_type==='updated'&&!detailsOf(event).rejected&&(!last||eventOrder(event,last)<0)&&String(event.created_at||'')>latest);}
function changeWords(event){const detail=detailsOf(event);return detail.outOfBandHead?'committed a change in the session':detail.integratedSubmissionId?'integrated a submission':'changed the source';}
function changeRow(event){const keys=Array.isArray(event.merged_keys)?event.merged_keys.filter(key=>typeof key==='string'):[];return node('div',{class:'change'},node('div',{class:'row-between'},node('span',{class:'rail-line'},title('strong',actorName(event)),` ${changeWords(event)}`),title('time',ago(event.created_at),{dateTime:event.created_at||'',title:date(event.created_at)})),event.note?title('p',String(event.note).slice(0,200),{class:'rail-note'}):null,keys.length?title('p',`${keys.slice(0,6).join(', ')}${keys.length>6?` +${keys.length-6}`:''}`,{class:'claim-line'}):null);}
const submitPrompt=count=>`Submit the current changes in this session for review. Write a note that summarises the ${count===1?'change':`${count} changes`} made since the last submission.`;
function submitRequestButton(sessionId,key,count){if(state.resolving.has(key))return title('p','Submission requested. The designer’s progress appears in the stream.',{class:'help'});return button('Submit for review',async()=>{await sendTracked(submitPrompt(count),sessionId);state.resolving.add(key);await refresh(true);notice('Request sent. The designer will submit these changes for review.');},'small primary');}
function sessionChanges(){const row=state.session.session,rows=pendingChanges(row.id);if(!rows.length)return null;const key=`submit:${row.id}:${rows[0].seq||rows[0].created_at||''}`,hidden=rows.length-8;
  return node('section',{class:'rail-section'},title('h3','Changes'),title('p',`${rows.length} change${rows.length===1?'':'s'} since the last submission, not yet submitted.`,{class:'help'}),node('div',{class:'change-list'},...rows.slice(0,8).map(changeRow)),hidden>0?title('p',`${hidden} earlier change${hidden===1?'':'s'} not shown.`,{class:'help'}):null,canRequestIn()?node('div',{class:'actions'},submitRequestButton(row.id,key,rows.length)):title('p','Only the owner or a publisher can ask the designer to submit.',{class:'help'}));}
function members(){return node('div',{},...(state.session.members||[]).map(member=>node('div',{class:'member'},node('span',{},member.name||member.principalId,member.type==='agent'?title('span','agent',{class:'agent-tag inline'}):null),title('span',member.role,{class:'muted'}))));}
// Join Session widget: the Studio link, and the same invitation in the toolkit's words.
// Anyone the Design System already authorizes who opens either joins the session (route handles `join=1`).
const inviteUrl=id=>`${location.origin}${location.pathname}#${new URLSearchParams({source:state.source.id,view:'studio',session:id,join:'1'})}`;
const joinCommand=id=>`npx --yes --package ${TOOLKIT} timds join "${inviteUrl(id)}"`;
function copyRow(id,label,value,hint){const input=node('input',{id,readOnly:true,value,onfocus:event=>event.currentTarget.select()});
  return node('div',{class:'field'},node('label',{htmlFor:id},label),node('div',{class:'copy-row'},input,button('Copy',async()=>{try{await navigator.clipboard.writeText(value);notice(`${label} copied.`);}catch{input.focus();input.select();throw new Error('Copying is unavailable here. The text is selected; press ⌘C or Ctrl+C.');}},'small')),title('p',hint));}
function inviteDialog(id){showDialog('Join this session',title('p','Anyone with access to this Design System can join with either of these.'),
  copyRow('invite-link','Studio link',inviteUrl(id),'Opens this session in Studio and joins on arrival.'),
  copyRow('invite-command','Terminal',joinCommand(id),'Joins with the TimDS toolkit in a new session folder, signing in through this host if needed.'),
  node('div',{class:'dialog-actions'},button('Send to your agent…',()=>agentDialog(id),'quiet'),button('Done',()=>$('#dialog').close(),'primary')));}
// ---- Agent handoff ----------------------------------------------------------
// One click puts the designer's own agent into this account or this session. Every
// client gets the same host MCP server under the name `timds`; the brief and the
// skill are the same text for all of them, with the client's connect step inlined.
const MCP_NAME='timds',mcpUrl=()=>`${location.origin}/api/timds/mcp`;
const AGENT_CLIENTS=[
  {id:'claude-code',name:'Claude Code',connect:url=>[`claude mcp add --transport http ${MCP_NAME} ${url}`],after:'Then type /mcp inside Claude Code and sign in as yourself.'},
  {id:'codex',name:'Codex',connect:url=>[`codex mcp add ${MCP_NAME} --url ${url}`,`codex mcp login ${MCP_NAME}`],after:'The login command opens the browser sign-in.'},
  {id:'cursor',name:'Cursor',open:url=>`cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_NAME}&config=${btoa(JSON.stringify({url}))}`,openLabel:'Add to Cursor',where:'Settings → MCP',steps:['Click Add to Cursor and confirm the server, or paste this URL under Settings → MCP.','Sign in as yourself when Cursor asks.'],after:'Cursor keeps the connection for every later chat.'},
  {id:'vscode',name:'VS Code',open:url=>`vscode:mcp/install?${enc(JSON.stringify({name:MCP_NAME,type:'http',url}))}`,openLabel:'Add to VS Code',connect:url=>[`code --add-mcp '${JSON.stringify({name:MCP_NAME,type:'http',url})}'`],after:'Start the server from the MCP list and sign in when VS Code asks.'},
  {id:'gemini',name:'Gemini CLI',connect:url=>[`gemini mcp add --transport http ${MCP_NAME} ${url}`],after:'Then type /mcp auth timds inside Gemini CLI to sign in.'},
  {id:'claude',name:'Claude app',where:'Settings → Connectors → Add custom connector',steps:['Open Settings → Connectors → Add custom connector.','Paste this as the server URL and sign in as yourself.'],after:'Works in the Claude desktop and web apps.'},
  {id:'other',name:'Other',where:'its MCP settings',steps:['Add a remote (HTTP) MCP server with this URL.','Sign in with OAuth and allow read and write access.'],after:'Any client that supports remote MCP servers with OAuth and PKCE can connect.'}];
const studioUrl=id=>`${location.origin}${location.pathname}#${new URLSearchParams(id?{source:state.source.id,view:'studio',session:id}:{source:state.source.id})}`;
// How a client connects, as lines an agent can act on: CLIs run the command; apps need the person.
const connectLines=(client,url)=>client.connect?[...client.connect(url),'If that needs a restart or a sign-in step, tell me and stop.']:[`Ask me to add the MCP server ${url} in ${client.name} (${client.where}) and sign in, then stop until I say it is connected.`];
// The brief is what the designer pastes into the agent: how to connect, then what to do. The
// working rules come from the host's own skill (get_skill), so they never drift from the host.
function agentBrief(client,sessionId){const url=mcpUrl(),systemId=state.source.systemId;return[`TimDS: work in the ${state.source.name} design system${sessionId?' session':''} as me.`,'',`MCP server (remote HTTP; OAuth with PKCE, allow timds:read and timds:write): ${url}`,`Design System: ${systemId}`,...(sessionId?[`Session: ${sessionId}`]:[]),`Studio: ${studioUrl(sessionId)}`,'',`If the ${MCP_NAME} MCP server is not connected yet, connect it first:`,...connectLines(client,url).map(line=>`  ${line}`),'','Then:',`1. Call get_skill with systemId ${systemId}, save it at the path it names inside your skills folder, and follow it from now on.`,sessionId?`2. join_session with sessionId ${sessionId}, then get_session and get_active_work for it.`:`2. get_system and get_active_work for ${systemId}, then start_session on it with a new idempotencyKey.`,'3. Do the task below, submit it for review, report the submission id and Preview URL, and stop. Do not publish unless I ask.','','Task: <describe the change you want>'].join('\n');}
// The skill is served by the host (get_skill) so Studio shows exactly what the agent will fetch.
const readSkill=()=>mcpCall('get_skill',{systemId:state.source.systemId},'The skill could not be loaded from the host. Try again in a moment.');
function downloadText(name,value,type){const href=URL.createObjectURL(new Blob([value],{type})),anchor=node('a',{href,download:name,hidden:true});document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(href),2000);}
function agentDialog(sessionId){const url=mcpUrl(),where=sessionId?'this session':state.source.name;let client=AGENT_CLIENTS.find(row=>row.id===read('agent'))||AGENT_CLIENTS[0];
  const tabs=node('div',{class:'tabs agent-tabs',role:'group','aria-label':'Your agent'}),connect=node('div',{class:'agent-step'}),brief=node('div',{class:'agent-step'}),skill=node('div',{class:'agent-step'});
  const render=()=>{tabs.replaceChildren(...AGENT_CLIENTS.map(row=>node('button',{type:'button','aria-pressed':String(row===client),onclick:()=>{client=row;save('agent',row.id);render();}},row.name)));
    const open=client.open?node('a',{class:'button primary',href:client.open(url)},client.openLabel):null;
    replaceContent(connect,title('h3','1 · Connect once'),open?node('div',{class:'actions'},open):null,client.connect?snippet(client.connect(url)):null,client.steps?node('ol',{class:'agent-steps'},...client.steps.map(step=>title('li',step))):null,client.steps?snippet([url]):null,title('p',client.after,{class:'help'}));
    const briefValue=agentBrief(client,sessionId),briefCode=title('pre',briefValue,{class:'code agent-brief',tabIndex:0});
    replaceContent(brief,title('h3',`2 · Send it into ${where}`),title('p','Paste this into your agent and replace the last line with what you want changed. It joins as you and submits for review here.',{class:'help'}),briefCode,node('div',{class:'actions'},button('Copy the brief',()=>copyText(briefValue,briefCode),'primary')));
  };
  const skillStatus=loadingLine('Loading the skill from the host…');
  const loadSkill=async()=>{replaceContent(skill,title('h3','3 · Or keep it as a skill'),skillStatus);try{const data=await readSkill();if(!skill.isConnected)return;const value=String(data?.skill||''),path=String(data?.path||'SKILL.md');if(!value)throw new Error('The host returned an empty skill.');const code=title('pre',value,{class:'code agent-brief',tabIndex:0});
      replaceContent(skill,title('h3','3 · Or keep it as a skill'),title('p',`Served by this host as get_skill, so your agent can fetch it itself. Save it as ${path} in your agent’s skills folder (for example ~/.claude/skills/ or .agents/skills/) and every later conversation knows how to reach ${state.source.name}.`,{class:'help'}),code,node('div',{class:'actions'},button('Copy SKILL.md',()=>copyText(value,code),'small'),button('Download SKILL.md',()=>downloadText('SKILL.md',value,'text/markdown'),'small quiet')));}
    catch(error){if(!skill.isConnected)return;replaceContent(skill,title('h3','3 · Or keep it as a skill'),title('p',error.message||'The skill could not be loaded.',{class:'error-text',role:'alert'}),node('div',{class:'actions'},button('Try again',loadSkill,'small')));}};
  render();void loadSkill();showDialog(sessionId?'Send your agent into this session':`Send your agent to ${state.source.name}`,title('p','Pick the agent you use. Connecting is a one-time step per machine; after that, the brief alone is enough.'),tabs,connect,brief,skill,node('div',{class:'dialog-actions'},button('Done',()=>$('#dialog').close(),'primary')));}
async function joinFromLink(id){
  // Drop the flag first so a reload or a forwarded tab does not join again.
  history.replaceState(null,'',`#${new URLSearchParams({source:state.source.id,view:'studio',session:id})}`);state.routeHash=location.hash;
  try{await api(`/api/timds/sessions/${enc(id)}/join`,{});notice('You joined this session.');}catch(error){notice(error.message||'This invite link could not be used.',true);}}
function claims(){const rows=state.session.claims||[];return rows.length?node('div',{},...rows.map(claim=>node('div',{class:'claim'},title('strong',claim.name||short(claim.principalId)),node('div',{},title('code',claim.patterns.join(', '))),claim.note?title('p',claim.note,{class:'help'}):null))):title('p','No working areas claimed. Agents claim the files they work on so collaborators can see overlaps.',{class:'help'});}
async function reloadSession(){const id=state.session.session.id,generation=state.generation;const result=await api(`/api/timds/sessions/${enc(id)}/status`);if(generation!==state.generation||state.session?.session.id!==id)return;state.session=result;renderMain();}
function destroySessionDialog(row){
  if(!row.canManage||!['starting','open','closing'].includes(row.status))throw new Error('You cannot destroy this workspace.');
  const target={id:row.id,sourceId:row.sourceId||state.source.id,principalId:state.principal.id,name:sessionLabel(row),kind:row.kind||'session'},key=destructionKey(target.sourceId,target.id),prior=state.destructions.get(key),operation=prior?.target.principalId===target.principalId?prior:{target,busy:false,error:null};
  operation.host=node('div',{class:'destroy-workspace'});state.destructions.set(key,operation);showDialog(`Destroy ${target.kind==='draft'?'draft':'session'} ${target.name}?`,operation.host);renderDestroySession(operation);
}
function renderDestroySession(operation){
  if(state.principal?.id!==operation.target.principalId||!operation.host.isConnected||!$('#dialog').open)return;
  const target=operation.target;replaceContent(operation.host,title('p','This permanently discards unpublished changes and removes the workspace’s working files and previews. Its live view and agent will stop.'),target.kind==='draft'?title('p','Every active session based on this draft will also be destroyed, including sessions owned by other collaborators.',{class:'destroy-cascade'}):null,title('p','Published releases and recorded history remain available. Pending submissions are closed.',{class:'help'}),operation.busy?loadingLine('Destroying the workspace and stopping its agent…'):null,operation.error?title('p',operation.error,{class:'error-text',role:'alert'}):null,node('div',{class:'dialog-actions'},button(operation.busy?'Close dialog':'Cancel',()=>$('#dialog').close()),operation.busy?null:button(operation.error?'Retry destroy':target.kind==='draft'?'Destroy draft and child sessions':'Destroy session',()=>destroySession(operation),'danger')));
}
function patchWorkspaces(){const target=$('#work-list');if(target)target.replaceWith(workList(state.view==='sessions'));if(state.view==='studio'&&state.session)patchStudio();}
async function destroySession(operation){
  if(operation.busy)return;const target=operation.target;
  if(state.principal?.id!==target.principalId)throw new Error('Sign in again before destroying this workspace.');
  operation.busy=true;operation.error=null;renderDestroySession(operation);if(state.source?.id===target.sourceId)patchWorkspaces();
  try{
    const result=await api(`/api/timds/sessions/${enc(target.id)}/close`,{});
    if(result.session?.id!==target.id||result.session.sourceId!==target.sourceId||!['closed','expired'].includes(result.session.status))throw new Error('Cleanup is not confirmed. Refresh the workspace list, then retry this same workspace.');
    if(state.principal?.id!==target.principalId)return;
    state.destructions.delete(destructionKey(target.sourceId,target.id));
    if(operation.host.isConnected&&$('#dialog').open)$('#dialog').close();
    notice(`${target.name} destroyed. Its recorded history is retained.`);
    if(state.source?.id!==target.sourceId)return;
    const affected=row=>row.id===target.id||target.kind==='draft'&&row.draftSessionId===target.id;
    for(const row of [...(state.work?.sessions||[]),...(state.work?.drafts||[])])if(affected(row))row.status='closed';
    if(state.session&&affected(state.session.session)){state.session=null;navigate('sessions');}
    else{patchWorkspaces();try{await refresh(false);}catch(error){notice(`Workspace destroyed. Refresh to update the remaining list: ${error.message}`,true);}}
  }catch(error){if(state.principal?.id===target.principalId){operation.error=error.message;notice(error.message,true);if(state.source?.id===target.sourceId)try{await refresh(false);}catch{}}}
  finally{operation.busy=false;if(state.principal?.id===target.principalId){renderDestroySession(operation);if(state.source?.id===target.sourceId)patchWorkspaces();}}
}

// ---- Studio: the live canvas in the middle, chat and events on the left, the session rail on the right.
// Built once per session; feed events and refreshes patch the stream, rail and head and never rebuild the frame.
const requestIdOf=event=>detailsOf(event).requestId||event.originating_request_id||null;
const actorName=event=>event.actor_name||event.principal_name||(event.actor_principal_id?short(event.actor_principal_id):'TimDS');
const STEP_WORDS={request_received:'Request received',request_started:'Designer started',updated:'Changed the source',submitted:'Submitted for review',request_submitted:'Done',member_joined:'Joined the session'};
function stepWords(event){const type=String(event.event_type||''),detail=detailsOf(event);if(type==='live_state')return`Live view ${detail.state||'changed'}`;if(type==='claimed')return`Claimed ${Array.isArray(detail.patterns)&&detail.patterns.length?detail.patterns.join(', '):'a working area'}`;if(type==='request_failed')return detail.error||'Could not finish this Request';return STEP_WORDS[type]||eventWords(event);}
const NOW_WORDS={queued:'Waiting for the designer',starting:'Designer starting',running:'Designer working',submitting:'Submitting for review',unknown:'Sending'};
// The stream holds this session's own events, oldest first. Releases published from
// this session's submissions carry its id and appear; the source's wider history
// stays on the dashboard Activity page.
// Requests become chat threads: the prompt as the requester's message, the designer's
// progress as steps beneath it. Everything else is an event row.
function streamItems(){
  const id=state.session.session.id,threads=new Map(),items=[];
  const events=(state.work?.events||[]).filter(event=>event.session_id===id).sort((a,b)=>eventOrder(b,a));
  for(const event of events){
    const type=String(event.event_type||''),requestId=requestIdOf(event);
    if(requestId&&/^request_/.test(type)&&!threads.has(requestId)){const thread={kind:'thread',requestId,prompt:event.note||'',requester:type==='request_received'?actorName(event):null,requesterId:type==='request_received'?event.actor_principal_id:null,createdAt:event.created_at,steps:type==='request_received'?[]:[event]};threads.set(requestId,thread);items.push(thread);continue;}
    if(requestId&&threads.has(requestId)&&type!=='member_joined'){threads.get(requestId).steps.push(event);continue;}
    items.push({kind:'event',createdAt:event.created_at,event});
  }
  for(const own of state.requestRows){const target=own.sessionId||own.targetSessionId;if(target!==id)continue;const thread=threads.get(own.requestId);if(thread){thread.own=own;if(!thread.requester){thread.requester=state.principal?.name||'You';thread.requesterId=state.principal?.id;}if(!thread.prompt)thread.prompt=own.prompt;}else items.push({kind:'thread',requestId:own.requestId,prompt:own.prompt,requester:state.principal?.name||'You',requesterId:state.principal?.id,createdAt:own.createdAt,steps:[],own});}
  items.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
  return items.length?items.map(item=>item.kind==='thread'?threadView(item):eventRow(item.event)):[node('li',{class:'evt'},node('span',{class:'dot'}),node('div',{class:'text'},empty('A quiet session','Ask the designer for a change below. Its progress and everyone else’s work appear here.')))];
}
function threadView(thread){
  const mine=thread.requesterId&&thread.requesterId===state.principal?.id,who=mine?'You':thread.requester||'A teammate';
  const last=String(thread.steps.at(-1)?.event_type||''),terminal=['request_submitted','request_failed'].includes(last);
  const steps=thread.steps.map(event=>node('li',{class:event.event_type==='request_failed'?'fail':'done'},stepWords(event),title('time',ago(event.created_at),{dateTime:event.created_at||'',title:date(event.created_at)})));
  if(!terminal){const step=thread.own?requestStep(thread.own)||thread.own.status:thread.steps.length?'running':'queued';if(step&&!['submitted','failed','conflicted'].includes(step))steps.push(node('li',{class:'now'},NOW_WORDS[step]||step));if(step==='conflicted')steps.push(node('li',{class:'fail'},'Overlaps a newer change; see the conflict below'));}
  const submissionId=thread.own?.submissionId||thread.steps.map(event=>detailsOf(event).submissionId).find(Boolean);
  const retry=thread.own&&['unknown','failed','dead_letter','cancelled'].includes(thread.own.status)?button('Retry this Request',async()=>{await sendRequest(thread.own);await refresh(true);},'small'):null;
  return node('li',{class:`msg${mine?' me':''}`,'data-request':thread.requestId},title('span',initials(who),{class:'avatar',title:who}),node('div',{class:'msg-body'},node('div',{class:'who'},title('strong',who),title('time',ago(thread.createdAt),{dateTime:thread.createdAt||'',title:date(thread.createdAt)})),title('p',thread.prompt||'(Request)',{class:'bubble request-prompt'}),
    steps.length?node('div',{class:'reply'},node('div',{class:'who'},title('strong','Designer'),title('span','agent',{class:'agent-tag inline'})),node('ul',{class:'steps-list'},...steps),thread.own?.error?title('p',thread.own.error,{class:'error-text'}):null,submissionId||retry?node('div',{class:'actions'},submissionId?button('Review and publish',()=>reviewSubmission(submissionId),'small primary'):null,retry):null):null));
}
function eventRow(event){const type=String(event.event_type||''),release=/^(published|publication_|rollback)/.test(type);return node('li',{class:`evt${release?' main':''}`},node('span',{class:'dot'}),node('div',{class:'text'},title('strong',actorName(event)),' ',eventWords(event),event.note&&type!=='claimed'?title('span',` · ${String(event.note).slice(0,140)}`,{class:'muted'}):null,title('time',ago(event.created_at),{dateTime:event.created_at||'',title:date(event.created_at)})));}
function reviewSubmission(submissionId){const full=state.submissions.find(item=>item.id===submissionId)||(state.session?.submissions||[]).find(item=>item.id===submissionId);if(full&&state.work?.canPublish&&!full.targetDraftSessionId&&['submitted','publishing'].includes(full.status))return publicationDialog(full);state.previews.add(submissionId);navigate('review');}
function streamHead(){const tabs=[['all','All'],['chat','Chat'],['events','Events']];return node('div',{class:'stream-head'},title('h2','Stream'),node('div',{class:'tabs',role:'group','aria-label':'Filter the stream'},...tabs.map(([key,label])=>node('button',{type:'button','aria-pressed':String(state.studio.filter===key),onclick:event=>{state.studio.filter=key;$('#studio-stream')?.setAttribute('data-filter',key);for(const other of event.currentTarget.parentElement.children)other.setAttribute('aria-pressed',String(other===event.currentTarget));scrollStream(true);}},label))));}
function scrollStream(force=false){const list=$('#studio-stream');if(!list)return;if(force||list.scrollHeight-list.scrollTop-list.clientHeight<120)list.scrollTop=list.scrollHeight;}
function patchStream(){const list=$('#studio-stream');if(!list||!state.session||editing(list))return;const atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<120;list.replaceChildren(...streamItems());if(atBottom)scrollStream(true);}
function studioComposer(row,canRequest){if(!canRequest)return row.status==='starting'?loadingLine('The session is starting. You can send Requests once it is open.'):title('p',row.status==='open'?'Only the owner or a publisher can send Requests in this session.':'This session is closed. Open another from the dashboard.',{class:'help compose-note'});
  const prompt=node('textarea',{id:'session-prompt',placeholder:`Ask the designer to change something in this ${row.kind==='draft'?'draft':'session'}…`,maxLength:32768,value:state.composer.here,oninput:event=>state.composer.here=event.currentTarget.value,onkeydown:event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey))event.currentTarget.closest('.studio-compose').querySelector('button.primary').click();}});
  return node('div',{},node('label',{htmlFor:'session-prompt',class:'visually-hidden'},'Your Request'),prompt,node('div',{class:'row-between'},title('span','The agent makes the change here; the live view reloads when it lands.',{class:'help'}),button('Send',async()=>{const value=state.composer.here.trim();if(!value)throw new Error('Describe the change you want to make.');await sendTracked(value,row.id);state.composer.here='';prompt.value='';await refresh(false);patchStudio();scrollStream(true);},'primary')));}
function setStudioWidth(width){state.studio.width=width;$('#studio-stage')?.setAttribute('data-width',width);for(const control of $$('.widths button'))control.setAttribute('aria-pressed',String(control.dataset.width===width));}
function studioCanvas(row){return node('section',{class:'studio-canvas','aria-label':'Live view'},node('div',{class:'studio-chrome'},stateStrip(row),title('span',safeUrl(row.liveUrl)||'The live view appears once the session has started.',{id:'studio-url',class:'studio-url'}),node('div',{class:'widths',role:'group','aria-label':'Frame width'},...[['desktop','Desktop'],['phone','Phone']].map(([key,label])=>node('button',{type:'button','data-width':key,'aria-pressed':String(state.studio.width===key),onclick:()=>setStudioWidth(key)},label))),link('Open in new tab ↗',row.liveUrl)),node('div',{id:'studio-stage',class:'studio-stage','data-width':state.studio.width},frameView({url:row.liveUrl,sessionId:row.id,label:`Live view of ${sessionLabel(row)}`})));}
const currentRelease=()=>[...(state.work?.publicationEvents||[])].filter(event=>event.action==='publish').sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0]||null;
// A release in flight stays visible from every view: the dashboard top bar, the Studio header and the Studio rail.
const activePublications=()=>(state.submissions||[]).filter(row=>['queued','running','closing'].includes(row.publication?.status));
const publishingStage=pub=>pub.status==='queued'?(pub.queuePosition?`queued #${pub.queuePosition}`:'queued'):pub.status==='closing'?'finishing':pub.stage||'starting';
function publishingIndicator(){const rows=activePublications();if(!rows.length)return null;const [row]=rows,pub=row.publication,what=pub.result?.version||row.note||`Submission ${short(row.id)}`;
  return node('a',{id:'publishing-status',class:'publishing-indicator',href:'#'+new URLSearchParams({source:state.source?.id||'',view:'review'}),title:`${what}${rows.length>1?` and ${rows.length-1} more`:''} · open Review for the stage strip`,onclick:event=>{event.preventDefault();navigate('review');}},'Publishing',title('span',publishingStage(pub),{class:'publishing-stage'}));}
const publishingSlot=()=>node('span',{class:'publishing-slot',role:'status','aria-live':'polite'},publishingIndicator());
function renderPublishing(){for(const slot of $$('.publishing-slot'))replaceContent(slot,publishingIndicator());}
function publishingRow(){const [row]=activePublications();return row?node('div',{class:'rail-kv'},title('span','Publishing',{class:'k'}),title('span',publishingStage(row.publication),{class:'badge warning'})):null;}
// The rail stays basic: the current version, this session's publish/preview, and its state.
function studioRail(){const data=state.session,row=data.session,release=currentRelease(),live=liveStateOf(row),runner=sessionStep(row);return[
  node('section',{class:'rail-section'},title('h3','Version'),node('div',{class:'rail-kv'},title('span','Published',{class:'k'}),title('strong',release?.version_label||'None yet',{class:'mono'})),release?node('div',{class:'rail-kv'},title('span','Since',{class:'k'}),title('span',ago(release.created_at),{title:date(release.created_at)})):null,publishingRow()),
  sessionChanges(),
  node('section',{class:'rail-section'},title('h3','Publish'),sessionSubmissions(pendingChanges(row.id).length>0)),
  node('section',{class:'rail-section'},title('h3','People'),members(),row.status==='open'?node('div',{class:'actions'},button('Send to your agent…',()=>agentDialog(row.id),'small primary'),data.canInvite?button('Invite…',()=>inviteDialog(row.id),'small'):null):null),
  node('section',{class:'rail-section'},title('h3','State'),node('div',{class:'rail-kv'},title('span','Session',{class:'k'}),badge(row.status)),node('div',{class:'rail-kv'},title('span','Live view',{class:'k'}),badge(live)),node('div',{class:'rail-kv'},title('span','Designer',{class:'k'}),badge(runner||runnerText(row.runner)||'idle')),row.queueLength?node('div',{class:'rail-kv'},title('span','Queued',{class:'k'}),title('span',`${row.queueLength} Request${row.queueLength===1?'':'s'}`)):null,row.expiresAt?node('div',{class:'rail-kv'},title('span','Expires',{class:'k'}),title('span',date(row.expiresAt))):null),
  data.canManage&&['starting','open','closing'].includes(row.status)?node('div',{},destructionFor(row)?.error?title('p',destructionFor(row).error,{class:'error-text',role:'alert'}):null,node('div',{class:'actions'},destroySessionButton({...row,canManage:data.canManage}))):null];}
function studioTop(){const current=state.source,row=state.session?.session,release=currentRelease();
  return node('header',{id:'studio-top',class:'studio-top'},node('span',{class:'wordmark'},'timds',title('span','.',{class:'brand-dot'})),node('nav',{class:'crumbs','aria-label':'Breadcrumb'},node('a',{href:'#'+new URLSearchParams({source:current.id,view:'overview'}),onclick:event=>{event.preventDefault();navigate('overview');}},'Dashboard'),title('span','/',{class:'sep'}),title('span',current.name,{class:'crumb'}),row?title('span','/',{class:'sep'}):null,row?title('strong',sessionLabel(row)):null,row?badge(row.status):null),release?title('span',release.version_label,{class:'chip mono',title:`Current release · ${date(release.created_at)}`}):null,publishingSlot(),node('span',{class:'grow'}),row?avatars(row.id):null,feedIndicator(),button('Disconnect',()=>disconnect(),'small quiet'));}
function renderStudio(main){const row=state.session.session,page=$('#studio');if(page&&main.contains(page)&&page.dataset.session===row.id&&page.dataset.url===(row.liveUrl||'')){patchStudio();return;}
  const canRequest=canRequestIn();
  main.replaceChildren(node('div',{id:'studio',class:'studio','data-session':row.id,'data-url':row.liveUrl||''},
    node('aside',{class:'studio-stream','aria-label':'Chat and events'},streamHead(),node('ol',{id:'studio-stream',class:'stream-list','data-filter':state.studio.filter,'aria-live':'polite'},...streamItems()),node('div',{id:'studio-conflicts',class:'studio-conflicts'},sessionConflicts(row,canRequest)),node('div',{id:'studio-compose',class:'studio-compose'},studioComposer(row,canRequest))),
    studioCanvas(row),
    node('aside',{id:'studio-rail',class:'studio-rail','aria-label':'Session'},...studioRail())));
  const top=$('#studio-top');if(top)top.replaceWith(studioTop());
  scrollStream(true);}
function patchStudio(){if(!state.session)return;const row=state.session.session,page=$('#studio');if(!page||page.dataset.session!==row.id)return;if(page.dataset.url!==(row.liveUrl||'')){renderStudio($('#main'));return;}
  const canRequest=canRequestIn(),swap=(id,content)=>{const target=document.getElementById(id);if(target&&!editing(target))target.replaceChildren(...[content].flat().filter(Boolean));};
  const top=$('#studio-top');if(top)top.replaceWith(studioTop());
  patchStream();swap('studio-conflicts',sessionConflicts(row,canRequest));swap('studio-rail',studioRail());swap('studio-compose',studioComposer(row,canRequest));
  const url=$('#studio-url');if(url)url.textContent=safeUrl(row.liveUrl)||'The live view appears once the session has started.';
  if(!safeUrl(row.liveUrl)){const stage=$('#studio-stage');if(stage)stage.replaceChildren(frameView({url:row.liveUrl,sessionId:row.id,label:`Live view of ${sessionLabel(row)}`}));}}

// ---- Refresh (the safety net under the feed) -------------------------------
async function refresh(paint=false,reloadDelivery=false){
  if(state.view==='systems')return;
  if(!state.source||!state.token)return;
  const generation=state.generation,id=state.source.id,base=`/api/timds/design-systems/${enc(id)}`;
  const requestReads=Promise.all(read(`requests.${id}`,[]).map(async row=>{if(row.status==='unknown'&&!row.error&&Date.now()-Date.parse(row.createdAt||'')<30000)return row;try{return{...row,...await api(`${base}/requests/${enc(row.requestId)}`)};}catch(error){return{...row,error:error.status===404?'The host has not acknowledged this Request. Retry with the same reference.':error.message};}}));
  const [work,reviews]=await Promise.all([api(base+'/active-work'),api(base+'/submissions')]);
  if(generation!==state.generation)return;
  // Keep feed events newer than this page so the rail never steps backwards.
  const fetched=new Set((work.events||[]).map(row=>row.id)),newest=Math.max(0,...(work.events||[]).map(row=>Number(row.seq)||0));
  work.events=[...(state.work?.events||[]).filter(row=>!fetched.has(row.id)&&(Number(row.seq)||0)>newest),...(work.events||[])];
  const hadWork=Boolean(state.work);state.work=work;state.submissions=reviews.submissions||[];state.polledAt=Date.now();renderPublishing();
  const fresh=state.session&&work.sessions?.find(row=>row.id===state.session.session.id);
  if(fresh){const {members,claims,submissions,canManage,canInvite,...session}=fresh;state.session={...state.session,members,claims,submissions,canManage,canInvite,session:{...state.session.session,...session}};}
  if(paint||!hadWork)renderMain();else{const target=$('#work-list');if(target&&!editing(target))target.replaceWith(workList(state.view==='sessions'));patchReviewList();renderRails();renderReleaseLists();renderStateStrips();if(state.view==='studio')patchStudio();}
  void loadDeliverables(reloadDelivery);
  // A cold native runner must not hold the session page or release list open.
  const requests=await requestReads;if(generation!==state.generation)return;
  const stored=new Map(ownRequests().map(row=>[row.requestId,row]));state.requestRows=requests.map(row=>row.status==='unknown'?stored.get(row.requestId)||row:row);save(`requests.${id}`,state.requestRows);renderRequestLists();
}

// ---- Live feed: one WebSocket per selected source, opened with a single-use ticket.
// Events apply in seq order; reconnects resume after the last seq received.
const feed={socket:null,status:'off',sourceId:null,seq:0,attempt:0,generation:0,timer:null,ping:null,pong:null,refresh:null,viewing:'null',requests:new Set()};
const feedLabels={live:'Live',connecting:'Connecting',reconnecting:'Reconnecting',off:'Polling'};
const feedRefreshTypes=/^(session_started|draft_created|member_joined|claimed|updated|submitted|closed|request_|publication_|published|live_state)/;
function feedIndicator(){const viewers=state.presence||[],others=new Set(viewers.filter(row=>row.principalId!==state.principal?.id).map(row=>row.principalId));return node('span',{id:'feed-status',class:'live-indicator','data-state':feed.status,role:'status',title:[...new Set(viewers.map(row=>row.name||short(row.principalId)))].join(', ')},feedLabels[feed.status]||'Polling',others.size?` · ${others.size} here`:'');}
function feedRender(){const target=$('#feed-status');if(target)target.replaceWith(feedIndicator());renderPresence();}
function feedSetStatus(status){feed.status=status;feedRender();}
function feedDetach(){const socket=feed.socket;feed.socket=null;clearTimeout(feed.timer);feed.timer=null;clearInterval(feed.ping);clearTimeout(feed.pong);if(socket){socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;try{socket.close(1000,'Studio closed the feed');}catch{}}}
function feedStop(){feed.generation++;feedDetach();clearTimeout(feed.refresh);feed.sourceId=null;feed.seq=0;feed.attempt=0;feed.viewing='null';feed.requests.clear();state.presence=[];feedSetStatus('off');}
function feedStart(){if(!state.token||!state.source){feedStop();return;}if(feed.sourceId===state.source.id&&feed.status!=='off')return;feedStop();feed.sourceId=state.source.id;feed.seq=Math.max(0,...(state.work?.events||[]).map(row=>Number(row.seq)||0));feedConnect(feed.generation);}
function feedRetry(generation,delay=null){if(generation!==feed.generation)return;const wait=delay??Math.min(1000*2**feed.attempt,30000);feed.attempt++;state.presence=[];feedSetStatus('reconnecting');feed.timer=setTimeout(()=>feedConnect(generation),wait);}
async function feedConnect(generation){
  feed.timer=null;if(generation!==feed.generation||!state.token||!state.source)return;
  feedSetStatus(feed.attempt?'reconnecting':'connecting');
  let ticket;
  try{ticket=await api(`${sourcePath()}/feed/tickets`,{});}
  catch(error){if(generation!==feed.generation||!state.token)return;if([403,404,409,410].includes(error.status)){feedSetStatus('off');return;}feedRetry(generation);return;}
  if(generation!==feed.generation)return;
  const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${sourcePath()}/feed?${new URLSearchParams({ticket:ticket.ticket,after:String(feed.seq)})}`);
  feed.socket=socket;
  socket.onopen=()=>{if(feed.socket!==socket)return;feed.attempt=0;feedSetStatus('live');feed.ping=setInterval(()=>feedPing(socket,generation),25000);feedViewing(true);};
  socket.onmessage=event=>feedMessage(socket,event.data);
  socket.onclose=event=>{if(feed.socket!==socket)return;feedDetach();if(generation!==feed.generation)return;state.presence=[];if(event.code===4410){feedSetStatus('off');return;}feedRetry(generation,event.code===4100?0:null);};
}
function feedPing(socket,generation){if(feed.socket!==socket||socket.readyState!==1)return;socket.send('ping');clearTimeout(feed.pong);feed.pong=setTimeout(()=>{if(feed.socket!==socket)return;feedDetach();feedRetry(generation);},10000);}
function feedMessage(socket,data){
  if(feed.socket!==socket)return;
  if(data==='pong'){clearTimeout(feed.pong);return;}
  let message;try{message=JSON.parse(data);}catch{return;}
  if(message.type==='event'&&Number.isSafeInteger(message.seq))feedEvent(message.seq,message.event);
  else if(message.type==='presence'&&Array.isArray(message.viewers)){state.presence=message.viewers;feedRender();}
  // Replay finished after a (re)connect: viewing again refreshes the LiveSession keepalive.
  else if(message.type==='ready')feedViewing(true);
}
function feedEvent(seq,event){
  if(seq<=feed.seq||!event||typeof event!=='object')return;feed.seq=seq;
  if(state.work&&!(state.work.events||[]).some(row=>row.id===event.id)){state.work.events=[{...event,seq:Number(event.seq)||seq},...(state.work.events||[])].slice(0,200);renderRails();if(state.view==='studio')patchStream();}
  const type=String(event.event_type||''),sessionId=event.session_id||null,detail=detailsOf(event),requestId=detail.requestId||event.originating_request_id||null;
  if(requestId&&/^request_/.test(type))feed.requests.add(requestId);
  if(sessionId&&type==='live_state'){if(detail.state==='ready')state.waking.delete(sessionId);renderStateStrips(sessionId);}
  // The embedded live view reloads when the agent's change lands or the container is ready.
  if(sessionId&&(type==='updated'||type==='request_submitted'||type==='live_state'&&detail.state==='ready'))reloadFrames(sessionId);
  if(/^(publication_(queued|stage|failed)|published)$/.test(type))applyPublicationEvent(event);
  if(!feedRefreshTypes.test(type))return;
  const openId=state.session?.session.id;
  clearTimeout(feed.refresh);feed.refresh=setTimeout(()=>feedRefresh(Boolean(sessionId&&sessionId===openId)),400);
}
async function feedRefresh(session){
  if(state.polling){feed.refresh=setTimeout(()=>feedRefresh(session),400);return;}
  state.polling=true;
  try{await refresh(false);if(session&&state.session)await reloadSession();}catch{}finally{state.polling=false;}
}
function feedViewing(force=false){const row=state.view==='studio'?state.session?.session:null,viewing=row?(row.kind==='draft'?{draftId:row.id}:{sessionId:row.id}):null,key=JSON.stringify(viewing);if(!force&&key===feed.viewing)return;feed.viewing=key;if(feed.socket?.readyState===1)feed.socket.send(JSON.stringify({type:'viewing',viewing}));}
async function route(){if(!state.principal)return;state.routeHash=location.hash;const params=new URLSearchParams(location.hash.slice(1)),managing=state.principal.admin&&(params.get('view')==='systems'||!state.systems.length),source=managing?null:state.systems.find(row=>row.id===params.get('source'))||state.systems[0]||null,id=params.get('session');const changed=source?.id!==state.source?.id;state.generation++;state.source=source;let view=managing?'systems':['overview','deliverables','sessions','review','activity','studio'].includes(params.get('view'))?params.get('view'):'overview';if(view==='sessions'&&id)view='studio';else if(view==='studio'&&!id)view='sessions';state.view=view;const joining=view==='studio'&&Boolean(id)&&params.get('join')==='1';if(state.session?.session.id!==id)state.session=null;if(changed){state.session=null;state.work=null;state.delivery=null;state.submissions=[];state.requestRows=[];state.composer={here:''};state.waking.clear();state.conflicts.clear();state.resolving.clear();state.previews.clear();state.directory=null;state.inviteChoice='';}renderShell();if(!source){feedStop();if(managing)await busy(loadManagement());return;}feedViewing();if(joining)await joinFromLink(id);await busy(Promise.all([refresh(true),state.view==='studio'?openSession(id):null]));feedStart();}
function loadFailure(error){const message=error.name==='TimeoutError'?'The workspace is taking longer to respond. Your connection is still active.':error.message;if(state.source&&!state.work&&$('#main'))$('#main').replaceChildren(pageHead('CONNECTING','Your workspace is still opening.',message,button('Try again',()=>refresh(true),'primary')));notice(message,true);}
async function boot(){try{await busy(completeAuthorization());if(!signedIn()){renderWelcome();return;}const [me,catalog]=await busy(Promise.all([api('/api/timds/me'),api('/api/timds/design-systems')]));state.principal=me.principal;state.systems=catalog.systems||[];await route();}catch(error){if(state.principal)renderShell();else renderWelcome();loadFailure(error);}}
window.addEventListener('hashchange',()=>route().catch(loadFailure));
// Safety-net poll: every 12 s while the feed is down, every 60 s while it is live.
setInterval(async()=>{if(state.polling||!state.token||!state.source||document.hidden||feed.status==='live'&&Date.now()-state.polledAt<60000)return;state.polling=true;try{await refresh(false);if(!feed.sourceId)feedStart();}catch(error){notice(error.message,true);}finally{state.polling=false;}},12000);
// Request poll: every 3 s while one of this tab's Requests is queued or running,
// until it is terminal or the live feed has started reporting it.
setInterval(async()=>{if(state.requestPolling||!state.token||!state.source||document.hidden)return;const rows=state.requestRows.filter(row=>['queued','running'].includes(row.status)&&!(feed.status==='live'&&feed.requests.has(row.requestId)));if(!rows.length)return;state.requestPolling=true;const generation=state.generation,sourceId=state.source.id,base=sourcePath();
  try{const updates=new Map((await Promise.all(rows.map(row=>api(`${base}/requests/${enc(row.requestId)}`).then(result=>[row.requestId,result]).catch(()=>null)))).filter(Boolean));if(generation!==state.generation||!updates.size)return;let moved=false;
    state.requestRows=state.requestRows.map(row=>{const next=updates.get(row.requestId);if(!next)return row;if(next.status!==row.status||next.runner?.state!==row.runner?.state)moved=true;return{...row,...next};});save(`requests.${sourceId}`,state.requestRows);renderRequestLists();
    if(moved&&!state.polling){state.polling=true;try{await refresh(false);if(state.session&&state.view==='studio')await reloadSession();}catch{}finally{state.polling=false;}}}
  finally{state.requestPolling=false;}},3000);
// Relative times in the rail, and the waking timeout, need a slow tick.
setInterval(()=>{if(document.hidden||!state.work)return;renderRails();renderStateStrips();},30000);
// LiveSession keepalive: every viewing message (open, feed ready, every 5 minutes,
// hidden or not) keeps the watched container awake; leaving sends viewing:null.
setInterval(()=>{if(feed.viewing!=='null')feedViewing(true);},300000);
window.addEventListener('pagehide',()=>{if(feed.viewing!=='null'&&feed.socket?.readyState===1)try{feed.socket.send(JSON.stringify({type:'viewing',viewing:null}));}catch{}});
await boot();
