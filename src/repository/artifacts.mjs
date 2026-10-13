// Server-only Cloudflare Artifacts control plane. Repo tokens are secrets and
// authenticate Git only; callers must never serialize them into portal rows.
import {requestDiagnostic} from '../requests/diagnostics.mjs';
const segment = (value, label) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.length > 100) throw new Error(`Invalid Artifacts ${label}`);
  return encodeURIComponent(value);
};

const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const repositoryInfo=(value,namespace)=>({id:value.id,name:value.name,namespace,remote:value.remote,default_branch:value.defaultBranch,
  created_at:value.createdAt,updated_at:value.updatedAt,last_push_at:value.lastPushAt,source:value.source,read_only:value.readOnly});
const commitInfo=value=>value&&({...value,tree_hash:value.treeHash,authored_at:value.authoredAt,committed_at:value.committedAt});

function createBindingArtifactsAdapter(binding,namespace) {
  async function operation(stage,task,{allowMissing=false}={}) {
    try {return await task();}
    catch(cause) {
      if(allowMissing&&cause?.code==='NOT_FOUND')return null;
      const statusCode=cause?.statusCode||({NOT_FOUND:404,ALREADY_EXISTS:409,CREATE_IN_PROGRESS:503,IMPORT_IN_PROGRESS:503,FORK_IN_PROGRESS:503,INVALID_INPUT:400,INVALID_REPO_NAME:400,INVALID_TTL:400,UPSTREAM_UNAVAILABLE:502}[cause?.code])||502;
      const error=requestDiagnostic(fail(statusCode,'Cloudflare Artifacts binding operation failed'),stage,'cloudflare-artifacts');
      if(Number.isSafeInteger(cause?.numericCode))Object.assign(error.requestDiagnostic,{providerCodes:[cause.numericCode]});
      throw error;
    }
  }
  async function repository(name,task) {
    segment(name,'repository name');
    const handle=await binding.get(name);
    try{return await task(handle);}finally{handle[Symbol.dispose]();}
  }
  async function created(name,task) {
    const value=await task();
    // Revoke the creation capability before exposing public metadata. No token
    // or disposable RPC handle is returned or persisted by this adapter.
    try{await repository(name,handle=>handle.revokeToken(value.token));}
    catch(cause){
      await repository(name,async handle=>{if(String((await handle.info()).id)===String(value.id))await binding.delete(name);}).catch(()=>{});
      throw cause;
    }
    return repositoryInfo(value,namespace);
  }
  return {
    getNamespace:()=>operation('other',async()=>{await binding.list({limit:1});return {namespace,binding:true};},{allowMissing:true}),
    // Cloudflare creates a configured namespace upon its first repository.
    // This receipt promises that operation, not an already-created resource.
    createNamespace:async()=>({namespace,binding:true,creation:'implicit-on-repository-create'}),
    listRepositories:()=>operation('other',async()=>{
      const result=[];let cursor;
      for(let page=0;page<100;page++){
        const value=await binding.list({limit:200,...(cursor?{cursor}:{})});
        if(!Array.isArray(value?.repos))throw fail(502,'Invalid Artifacts repository list');
        result.push(...value.repos.map(value=>repositoryInfo(value,namespace)));
        if(!value.cursor)return result;
        if(value.cursor===cursor)throw fail(502,'Artifacts repository cursor did not advance');
        cursor=value.cursor;
      }
      throw fail(502,'Artifacts repository list limit exceeded');
    }),
    getRepository:(_namespace,name)=>operation('repository-read',()=>repository(name,async handle=>repositoryInfo(await handle.info(),namespace)),{allowMissing:true}),
    createRepository:(_namespace,name)=>operation('other',()=>{segment(name,'repository name');return created(name,()=>binding.create(name,{setDefaultBranch:'main'}));}),
    forkRepository:(_namespace,name,{sourceNamespace=namespace,sourceRepository,ref='main'})=>operation('other',()=>{
      if(sourceNamespace!==namespace||ref!=='main')throw fail(400,'Artifacts sessions fork main within one namespace');
      segment(name,'fork name');return created(name,()=>repository(sourceRepository,handle=>handle.fork(name,{defaultBranchOnly:true})));
    }),
    deleteRepository:(_namespace,name)=>operation('other',()=>{segment(name,'repository name');return binding.delete(name);}),
    mintToken:(_namespace,name,{permission='write',ttlSeconds=3600}={})=>operation('token-mint',()=>{
      if(!['read','write'].includes(permission)||!Number.isInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>31_536_000)throw fail(400,'Invalid Artifacts token scope or TTL');
      return repository(name,async handle=>{const value=await handle.createToken(permission,ttlSeconds);return {id:value.id,token:value.plaintext,expiresAt:value.expiresAt};});
    }),
    revokeToken:(_namespace,id,name)=>operation('token-revoke',()=>{segment(id,'token ID');return repository(name,handle=>handle.revokeToken(id));},{allowMissing:true}),
    listTokens:(_namespace,name)=>operation('tokens-list',()=>repository(name,async handle=>{
      const value=await handle.listTokens();
      if(!Array.isArray(value?.tokens)||value.total!==value.tokens.length)throw fail(502,'Artifacts token inventory is incomplete');
      return value.tokens.filter(value=>value.state==='active').map(value=>({id:value.id,scope:value.scope,state:value.state,created_at:value.createdAt,expires_at:value.expiresAt}));
    })),
    log:(_namespace,name,options={})=>operation('other',()=>repository(name,async handle=>(await handle.log(options)).map(commitInfo))),
    readCommit:(_namespace,name,hash)=>operation('other',()=>repository(name,async handle=>commitInfo(await handle.readCommit(hash)))),
    readTree:(_namespace,name,hash)=>operation('other',()=>repository(name,handle=>handle.readTree(hash))),
    readFile:(_namespace,name,path,ref='main')=>operation('other',()=>repository(name,async handle=>{const blob=await handle.readFile({ref,path});if(!blob)throw fail(404,'Artifacts file not found');return Buffer.from(await blob.arrayBuffer());})),
  };
}

/** Each organization namespace must have an explicitly deployed binding.
 * REST is an opt-in operational fallback, never an implicit runtime downgrade. */
export function createArtifactsAdapter({env={},fetchImpl=fetch,onRequest=()=>{}}={}) {
  let configured;
  try{configured=JSON.parse(env.TIMDS_ARTIFACTS_BINDINGS||'{}');}catch{throw fail(503,'Invalid Artifacts binding configuration');}
  if(!configured||Array.isArray(configured)||typeof configured!=='object')throw fail(503,'Invalid Artifacts binding configuration');
  const adapters=new Map(),names=new Set();
  for(const [namespace,name] of Object.entries(configured)){
    segment(namespace,'namespace');
    if(typeof name!=='string'||!/^ARTIFACTS_[A-Z0-9_]+$/.test(name)||names.has(name)||typeof env[name]?.get!=='function'||typeof env[name]?.list!=='function')throw fail(503,'Artifacts namespace binding is unavailable');
    names.add(name);adapters.set(namespace,createBindingArtifactsAdapter(env[name],namespace));
  }
  const rest=env.TIMDS_ARTIFACTS_REST_FALLBACK==='true'?createRestArtifactsAdapter({env,fetchImpl,onRequest}):null;
  const select=namespace=>{segment(namespace,'namespace');const adapter=adapters.get(namespace)||(rest?.configured?rest:null);if(!adapter)throw fail(503,'Deploy an Artifacts binding for this namespace before provisioning or authoring');return adapter;};
  const result={configured:adapters.size>0||Boolean(rest?.configured),listNamespaces:async()=>rest?.configured?rest.listNamespaces():[...adapters.keys()].map(namespace=>({namespace,binding:true}))};
  for(const method of ['getNamespace','createNamespace','listRepositories','getRepository','createRepository','forkRepository','deleteRepository','mintToken','revokeToken','listTokens','log','readCommit','readTree','readFile'])result[method]=(namespace,...args)=>select(namespace)[method](namespace,...args);
  return result;
}

function createRestArtifactsAdapter({ env = {}, fetchImpl = fetch, onRequest = () => {} } = {}) {
  const account = env.TIMDS_ARTIFACTS_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.TIMDS_ARTIFACTS_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const configured = Boolean(account && token);
  const accountBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account || "")}/artifacts`;
  const nsPath = namespace => `/namespaces/${segment(namespace, "namespace")}`;
  const repoPath = (namespace, repo) => `${nsPath(namespace)}/repos/${segment(repo, "repository name")}`;
  const query = values => {
    const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return params.size ? `?${params}` : "";
  };
  async function request(route, { method = "GET", body, raw = false, allowMissing = false } = {}) {
    if (!configured) throw new Error("Configure the server-only Cloudflare account ID and Artifacts API token");
    let response;
    try {
      response = await fetchImpl(`${accountBase}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000), redirect: "manual",
      });
    } catch { throw new Error(`Cloudflare Artifacts ${method} request failed`); }
    onRequest({ method, route, status: response.status });
    if (allowMissing && response.status === 404) return null;
    if (response.ok && raw) return Buffer.from(await response.arrayBuffer());
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success !== true) {
      // Cloudflare errors may reflect input. Expose status/codes, never the body.
      const codes = (payload.errors || []).map(error => Number(error.code)).filter(Number.isFinite);
      const error = new Error(`Cloudflare Artifacts ${method} failed (${response.status}; codes ${codes.join(",") || "unknown"})`);
      error.statusCode = response.status;
      error.codes = codes;
      const stage=method==='GET'&&/\/repos\/[^/]+\/tokens\?/.test(route)?'tokens-list'
        :method==='GET'&&/\/repos\/[^/?]+$/.test(route)?'repository-read'
        :method==='POST'&&/\/tokens$/.test(route)?'token-mint'
        :method==='DELETE'&&/\/tokens\/[^/]+$/.test(route)?'token-revoke':'other';
      requestDiagnostic(error,stage,'cloudflare-artifacts');
      Object.assign(error.requestDiagnostic,{providerStatus:response.status,providerCodes:codes});
      throw error;
    }
    return payload.result;
  }
  async function tokens(namespace,repo) {
    const found=[];
    for(let page=1;page<=100;page++){
      const rows=await request(`${repoPath(namespace,repo)}/tokens?state=active&per_page=100&page=${page}`);
      if(!Array.isArray(rows))throw new Error('Invalid Artifacts token list');
      found.push(...rows);if(rows.length<100)return found;
    }
    throw new Error('Artifacts token list limit exceeded');
  }
  async function created(namespace,repo,route,body){
    const result=await request(route,{method:'POST',body});
    // Creation issues an automatic capability. Never return it to a caller.
    // Enumerate/revoke before exposing the immutable identity; callers mint
    // bounded operation credentials separately. Errors never include result.
    try{for(const capability of await tokens(namespace,repo))await request(`${nsPath(namespace)}/tokens/${segment(capability.id,'token ID')}`,{method:'DELETE',allowMissing:true});}
    catch{await request(repoPath(namespace,repo),{method:'DELETE',allowMissing:true}).catch(()=>{});throw new Error('Initial Artifacts capability cleanup failed');}
    return {id:result.id,name:result.name||repo,namespace,remote:result.remote,default_branch:result.default_branch};
  }
  return {
    configured,
    listNamespaces: () => request("/namespaces?limit=200"),
    getNamespace: namespace => request(nsPath(namespace), { allowMissing: true }),
    createNamespace: namespace => request("/namespaces", { method: "POST", body: { namespace: decodeURIComponent(segment(namespace, "namespace")) } }),
    listRepositories: namespace => request(`${nsPath(namespace)}/repos?limit=200`),
    getRepository: (namespace, repo) => request(repoPath(namespace, repo), { allowMissing: true }),
    createRepository: (namespace, repo) => created(namespace,repo,`${nsPath(namespace)}/repos`,{ name: decodeURIComponent(segment(repo, "repository name")), default_branch: "main" }),
    forkRepository: (namespace, name, { sourceNamespace = namespace, sourceRepository, ref = "main" }) => {
      if (sourceNamespace !== namespace || ref !== "main") throw new Error("Artifacts sessions fork main within one namespace");
      return created(namespace,name,`${repoPath(namespace, sourceRepository)}/fork`,{ name: decodeURIComponent(segment(name, "fork name")), default_branch_only: true });
    },
    deleteRepository: (namespace, repo) => request(repoPath(namespace, repo), { method: "DELETE", allowMissing: true }),
    mintToken: async (namespace, repo, { permission = "write", ttlSeconds = 3600 } = {}) => {
      const scope = permission, ttl = ttlSeconds;
      segment(repo, "repository name");
      if (!["read", "write"].includes(scope) || !Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) throw new Error("Invalid Artifacts token scope or TTL");
      const result = await request(`${nsPath(namespace)}/tokens`, { method: "POST", body: { repo, scope, ttl } });
      return { id: result.id, token: result.plaintext, expiresAt: result.expires_at };
    },
    revokeToken: (namespace, id) => request(`${nsPath(namespace)}/tokens/${segment(id, "token ID")}`, { method: "DELETE", allowMissing: true }),
    listTokens: tokens,
    log: (namespace, repo, { ref = "main", limit = 20, offset = 0 } = {}) => request(`${repoPath(namespace, repo)}/log${query({ ref, limit, offset })}`),
    readCommit: (namespace, repo, hash) => request(`${repoPath(namespace, repo)}/commit/${segment(hash, "commit")}`),
    readTree: (namespace, repo, hash) => request(`${repoPath(namespace, repo)}/tree/${segment(hash, "tree")}`),
    readFile: (namespace, repo, path, ref = "main") => request(`${repoPath(namespace, repo)}/file${query({ ref, path })}`, { raw: true }),
  };
}

