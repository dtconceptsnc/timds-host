// Server-only Cloudflare Artifacts control plane. Repo tokens are secrets and
// authenticate Git only; callers must never serialize them into portal rows.
const segment = (value, label) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.length > 100) throw new Error(`Invalid Artifacts ${label}`);
  return encodeURIComponent(value);
};

export function createArtifactsAdapter({ env = {}, fetchImpl = fetch, onRequest = () => {} } = {}) {
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

