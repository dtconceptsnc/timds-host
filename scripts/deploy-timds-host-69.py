"""Deployment helper for the timds-host-69 installation (studio.timds.com).

Usage, from any checkout or worktree of this repository:

    python3 scripts/deploy-timds-host-69.py import-secrets|resources|catalog|lock|deploy|public

No secret is stored here or anywhere in the repository. At run time the script
reads the Cloudflare CLI OAuth tokens from the local wrangler and cloudflare
CLI config files and the runtime secrets from this checkout's private,
gitignored, owner-only `.env`, and hands them to `cf deploy --secrets-file`
through a fifo that is removed afterwards. `import-secrets` fills that `.env`
once from the retired portal VPS over SSH (plus the local bootstrap and
transfer secret files) so nothing depends on that machine afterwards.
The nonsecret installation record (account, Worker name, origins, Access
audience, designer principal, Artifacts bindings) lives in environment();
resource ids are in scripts/deploy-timds-host-69.state.json. Logs and the
fifo go to TIMDS69_DEPLOY_DIR (default /tmp/timds-host-69-deploy).
See docs/operations.md, "The timds-host-69 installation".
"""
from pathlib import Path
import os,sys,json,tomllib,subprocess,re
ROOT=Path(__file__).resolve().parents[1];WORK=Path(os.environ.get('TIMDS69_DEPLOY_DIR','/tmp/timds-host-69-deploy'));STATE=Path(os.environ.get('TIMDS69_DEPLOY_STATE',ROOT/'scripts/deploy-timds-host-69.state.json'));ACCOUNT='e25df25724ba27024ad08e3096b5bd37';NAME='timds-host-69'
def state():
 WORK.mkdir(parents=True,exist_ok=True);return json.loads(STATE.read_text()) if STATE.exists() else {}
def save(s):STATE.write_text(json.dumps(s,indent=2)+'\n')
ENV=ROOT/'.env';RUNTIME_KEYS=['CLOUDFLARE_API_TOKEN','TIMDS_BUILDS_API_TOKEN','OPENAI_API_KEY','TIMDS_BOOTSTRAP_SECRET','TIMDS_PORTAL_TRANSFER_SECRET']
def read_env():
 if not ENV.is_file() or ENV.is_symlink() or ENV.stat().st_mode&0o077:raise RuntimeError('Private .env unavailable: create it with import-secrets (owner-only file mode required)')
 values={}
 for line in ENV.read_text().splitlines():
  line=line.strip()
  if not line or line.startswith('#') or '=' not in line:continue
  key,value=line.split('=',1);value=value.strip()
  if len(value)>=2 and value[0]==value[-1] and value[0] in '"\'':value=value[1:-1]
  values[key.strip()]=value
 return values
def write_env(values):
 fd=os.open(ENV,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600);os.fchmod(fd,0o600)
 with os.fdopen(fd,'w') as f:f.write('# timds-host-69 runtime secrets. Local only: gitignored, owner-only. Never commit or print.\n'+''.join(f'{k}={v}\n' for k,v in values.items()))
def credentials():
 broad=tomllib.loads((Path.home()/'Library/Preferences/.wrangler/config/default.toml').read_text())['oauth_token'];builds=json.loads((Path.home()/'Library/Preferences/cloudflare/config/default.json').read_text())['oauth_token'];return broad,builds
def environment():
 broad,_=credentials();e=os.environ.copy();s=state();e.update({'CLOUDFLARE_API_TOKEN':broad,'CLOUDFLARE_ACCOUNT_ID':ACCOUNT,'TIMDS_WORKER_NAME':NAME,'TIMDS_HOST_ORIGIN':f'https://{NAME}.timds.workers.dev','TIMDS_STUDIO_ORIGIN':'https://studio.timds.com','TIMDS_STUDIO_FRAME_ORIGINS':os.environ.get('TIMDS_STUDIO_FRAME_ORIGINS','https://*.timds.workers.dev'),'TIMDS_PUBLIC_ORIGIN':f'https://{NAME}-public.timds.workers.dev','TIMDS_AGENT_PUSH_QUEUE_ID':s.get('queueId',''),'TIMDS_ACCESS_TEAM_DOMAIN':'https://timds.cloudflareaccess.com','TIMDS_ACCESS_AUD':'921c2c50fd5378eb09d45dc65fa471b3e2036d98a5e35099c05e6c6b33db7917','TIMDS_DESIGNER_PRINCIPAL_ID':'789e056d-9120-4fb3-8610-5a10df98911d','TIMDS_DESIGNER_MODEL':'gpt-6-sol','TIMDS_ARTIFACTS_BINDINGS':json.dumps({'timds-host-69':'ARTIFACTS_TIMDS69','timds-b99845e8-0fe4-4333-9e1d-a62ac584f3e9':'ARTIFACTS_PIERCE','timds-45818fce-d0f8-48d9-bb1c-afe09281d558':'ARTIFACTS_WPL','timds-6323067b-ddf8-43d2-b83d-d01621c3547e':'ARTIFACTS_SPEED'}),'TIMDS_ARTIFACTS_REST_FALLBACK':'true','TIMDS_WORKERS_SUBDOMAIN_ALIASES':json.dumps({'ratebucket':'timds'}),'TIMDS_MEDIA_LEGACY_BINDINGS':json.dumps({'timds-public-assets':'MEDIA_LEGACY_PORTAL'}),'TIMDS_PORTAL_ORIGIN':'https://portal.dtconcepts.net','TIMDS_LEGACY_PUBLIC_HOSTS':json.dumps({'plg-ds.timds.com': 'f7cfb345-391a-40ba-80f4-fc08359696bb', 'plg-ds.speed.style': 'f7cfb345-391a-40ba-80f4-fc08359696bb', 'wpl-ds.timds.com': '5b69a328-c6a2-4a40-aa0c-0c7588ae4c0c', 'wpl-ds.speed.style': '5b69a328-c6a2-4a40-aa0c-0c7588ae4c0c', 'ds.timds.com': 'd9465b2e-3c19-48de-a3ee-7d1c4770c8ad', 'ds.speed.style': 'd9465b2e-3c19-48de-a3ee-7d1c4770c8ad'})});return e
def cf(args,parse=True,extra=None,stdin=None,pass_fds=(),cwd=ROOT):
 e=environment();e.update(extra or {});r=subprocess.run([str(ROOT/'node_modules/.bin/cf'),*args],env=e,cwd=cwd,capture_output=True,text=True,input=stdin,pass_fds=pass_fds)
 if r.returncode:
  # Never expose full API results, headers, arbitrary logs or capabilities.
  text=r.stderr+'\n'+r.stdout
  safe={'command':args[:3],'exitCode':r.returncode,'statusCodes':re.findall(r'(?:status|HTTP)[ :]+([45][0-9]{2})',text),'errorCodes':re.findall(r'"code"\s*:\s*([0-9]+)',text)}
  for token in credentials():text=text.replace(token,'[REDACTED]')
  if 'artifacts' not in args:(WORK/'last-error.log').write_text(text)
  print(json.dumps(safe));raise SystemExit(r.returncode)
 return json.loads(r.stdout) if parse else r.stdout
if __name__=='__main__':
 action=sys.argv[1];s=state()
 if action=='resources':
  queues=cf(['queues','list']);found=[x for x in queues if x['queue_name']==NAME+'-events']
  if found:raise RuntimeError('Name already exists; inspect ownership before using')
  queue=cf(['queues','create','--queue-name',NAME+'-events']);s['queueId']=queue['queue_id'];save(s);print(json.dumps({'queue':s['queueId']}))
  db=cf(['d1','create','--name',NAME+'-catalog']);s['catalogId']=db['uuid'];save(s);print(json.dumps({'catalog':s['catalogId']}))
  for suffix in ['snapshots','releases']:
   cf(['r2','buckets','create','--name',NAME+'-'+suffix]);s[suffix]=NAME+'-'+suffix;save(s);print(json.dumps({'bucket':s[suffix]}))
 elif action=='catalog':
  result=cf(['d1','query',s['catalogId'],'--body',json.dumps({'sql':(ROOT/'migrations/0001_catalog.sql').read_text()})]);print(json.dumps({'catalogApplied':True,'statements':len(result) if isinstance(result,list) else 1}))
 elif action=='lock':
  rules=[{'id':'immutable-releases','enabled':True,'prefix':'sources/','condition':{'type':'Indefinite'}}]
  cf(['r2','buckets','locks','update',s['releases'],'--rules',json.dumps(rules),'--force']);read=cf(['r2','buckets','locks','get',s['releases']]);print(json.dumps({'releaseBucket':s['releases'],'lock':read}))
 elif action=='import-secrets':
  import shlex,secrets
  script="process.loadEnvFile('/var/www/portal.dtconcepts.net/.env.server'); process.stdout.write(JSON.stringify(Object.fromEntries(['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','OPENAI_API_KEY','TIMDS_BUILDS_API_TOKEN'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))));"
  remote=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=12','root@ssh.dtconcepts.net','/root/.nvm/versions/node/v25.4.0/bin/node -e '+shlex.quote(script)],capture_output=True,text=True,timeout=25)
  if remote.returncode:raise RuntimeError('Existing server credentials unavailable')
  values=json.loads(remote.stdout)
  if values.pop('CLOUDFLARE_ACCOUNT_ID',None)!=ACCOUNT or any(not values.get(k) for k in ['CLOUDFLARE_API_TOKEN','TIMDS_BUILDS_API_TOKEN','OPENAI_API_KEY']):raise RuntimeError('Existing runtime credentials unavailable or belong to another account')
  bootstrap=Path('/tmp/timds69-bootstrap-secret');transfer=Path.home()/'.config/timds/host69-transfer-secret'
  current=read_env() if ENV.is_file() else {}
  values['TIMDS_BOOTSTRAP_SECRET']=current.get('TIMDS_BOOTSTRAP_SECRET') or (bootstrap.read_text().strip() if bootstrap.is_file() else secrets.token_urlsafe(48))
  values['TIMDS_PORTAL_TRANSFER_SECRET']=current.get('TIMDS_PORTAL_TRANSFER_SECRET') or (transfer.read_text().strip() if transfer.is_file() else '')
  if not values['TIMDS_PORTAL_TRANSFER_SECRET']:raise RuntimeError('Private transfer secret unavailable')
  write_env({**current,'CLOUDFLARE_ACCOUNT_ID':ACCOUNT,**values});print(json.dumps({'env':str(ENV),'keys':sorted(values)}))
 elif action=='deploy':
  import threading
  values={k:v for k,v in read_env().items() if k in RUNTIME_KEYS}
  missing=[k for k in RUNTIME_KEYS if not values.get(k)]
  if missing:raise RuntimeError('Missing runtime secrets in .env: '+', '.join(missing)+' (run import-secrets)')
  if read_env().get('CLOUDFLARE_ACCOUNT_ID',ACCOUNT)!=ACCOUNT:raise RuntimeError('.env belongs to another account')
  if os.environ.get('TIMDS69_USE_MANAGED_ARTIFACTS_AUTH')=='1':values['CLOUDFLARE_API_TOKEN']=credentials()[0]
  pipe=(WORK/'secrets.json');os.mkfifo(pipe,0o600)
  def supply():
   with pipe.open('w') as f:json.dump(values,f)
  writer=threading.Thread(target=supply,daemon=True);writer.start()
  try:
   env=environment();proc=subprocess.Popen([str(ROOT/'node_modules/.bin/cf'),'deploy','--secrets-file',str(pipe)],env=env,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
   with (WORK/'deploy.log').open('w') as log:
    for line in proc.stdout:
     for secret in [*values.values(),*credentials()]:
      if secret:line=line.replace(secret,'[REDACTED]')
     log.write(line);log.flush()
   code=proc.wait();print(json.dumps({'deployExit':code,'log':str(WORK/'deploy.log')}))
   if code:raise SystemExit(code)
  finally:pipe.unlink(missing_ok=True)
 elif action=='public':
  result=cf(['deploy'],parse=False,cwd=ROOT/'public-worker');(WORK/'public-deploy.log').write_text(result);print(json.dumps({'publicDeploy':True,'urls':re.findall(r'https://[^\s\x1b]+workers.dev',result)}))
