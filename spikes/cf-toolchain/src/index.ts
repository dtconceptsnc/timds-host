import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
const ca = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
export class Outbound extends WorkerEntrypoint<Env, {remote:string;token:string}> {
  async fetch(request: Request) {
    const url = new URL(request.url), remote = new URL(this.ctx.props.remote);
    if (url.origin !== remote.origin || ![`${remote.pathname}/info/refs`,`${remote.pathname}/git-upload-pack`,`${remote.pathname}/git-receive-pack`].includes(url.pathname)) return new Response('Forbidden',{status:403});
    const headers = new Headers(request.headers); headers.set('Authorization', `Bearer ${this.ctx.props.token}`);
    return fetch(new Request(request,{headers,redirect:'manual'}));
  }
}
export class RepositorySandbox extends DurableObject<Env> {
  async probe(artifacts = false) {
    const c = this.ctx.container;
    if (!c) throw new Error('Container unavailable');
    if (!c.running) c.start({ image: c.images.git, instance: 'lite', enableInternet: false });
    await c.setInactivityTimeout(60_000);
    const run = async (args:string[],cwd='/tmp') => {
      const command = await c.exec(args,{cwd,env:{GIT_SSL_CAINFO:ca}});
      const result = await command.output();
      if(result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout);
    };
    const gitVersion = (await run(['git','--version'])).trim();
    if (!artifacts) return {gitVersion};
    const repoName = `probe-${crypto.randomUUID()}`;
    const created = await this.env.REPOS.create(repoName, {setDefaultBranch:'main'});
    using repo = await this.env.REPOS.get(repoName);
    await repo.revokeToken(created.token);
    const info = await repo.info(), token = await repo.createToken('write',60);
    try {
      const outbound = this.ctx.exports.Outbound({props:{remote:info.remote,token:token.plaintext}});
      await c.interceptAllOutboundHttp(outbound);
      await c.interceptOutboundHttps('*',outbound);
      const target = `/tmp/probe-${crypto.randomUUID()}`;
      await run(['git','-c','protocol.version=1','clone','--',info.remote,target]);
      await run(['git','checkout','-B','main'],target);
      await run(['git','-c','user.name=TimDS Phase0','-c','user.email=phase0@example.invalid','commit','--allow-empty','-m','Disposable cf phase zero git proof'],target);
      await run(['git','push','origin','HEAD:refs/heads/main'],target);
      const commit = (await run(['git','rev-parse','HEAD'],target)).trim();
      const d1 = await this.env.DB.prepare('SELECT 1 AS healthy').first();
      await this.env.RELEASES.put('probe.txt',commit);
      const r2 = await (await this.env.RELEASES.get('probe.txt'))!.text();
      await this.env.PUSHES.send({type:'phase0',commit});
      return {gitVersion,commit,d1,r2,queue:'sent',artifacts:'cloned and pushed'};
    } finally { await repo.revokeToken(token.id); }
  }
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/health') return Response.json({ok:true,bindings:['DB','RELEASES','PUSHES','REPOS'].filter(key => Boolean(env[key as keyof Env]))});
    if (!env.PROBE_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.PROBE_TOKEN}`) return new Response('Unauthorized', {status:401});
    if (new URL(request.url).pathname !== '/probe' || request.method !== 'POST') return new Response('Not found', {status:404});
    return Response.json(await ctx.exports.RepositorySandbox.getByName('disposable').probe(true));
  },
  async queue(batch) { batch.ackAll(); },
} satisfies ExportedHandler<Env>;
