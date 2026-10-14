"""Deployment helper for a timds-host installation.

Usage, from any checkout or worktree of this repository:

    python3 scripts/deploy-host.py import-secrets|resources|catalog|lock|deploy|public

Nothing installation-specific lives in this file. The checkout's private,
gitignored, owner-only `.env` holds both the nonsecret installation record
(account, Worker name, origins, Access audience, designer principal, Artifacts
bindings) and the runtime secrets; `.env.example` lists the
keys. Created resource ids go to `.env.deploy-state.json` (also gitignored).
Every Cloudflare API call runs under the cf CLI's own sign-in (`cf auth login`);
its OAuth token is read from the cloudflare CLI config file only to be redacted
from logs. No wrangler sign-in is involved. `import-secrets` fills the runtime secrets once from a
legacy server over SSH (TIMDS_SECRETS_SSH_HOST and TIMDS_SECRETS_SSH_FILE in
`.env`); afterwards nothing depends on that machine. Logs and the secrets fifo
go to TIMDS_DEPLOY_DIR (default /tmp/timds-host-deploy).
"""
from pathlib import Path
import os,sys,json,subprocess,re
ROOT=Path(__file__).resolve().parents[1];ENV=ROOT/'.env'
INSTALLATION=['CLOUDFLARE_ACCOUNT_ID','TIMDS_WORKER_NAME','TIMDS_HOST_ORIGIN','TIMDS_STUDIO_ORIGIN','TIMDS_PUBLIC_ORIGIN','TIMDS_PORTAL_ORIGIN','TIMDS_AGENT_PUSH_QUEUE_ID','TIMDS_ACCESS_TEAM_DOMAIN','TIMDS_ACCESS_AUD','TIMDS_DESIGNER_PRINCIPAL_ID','TIMDS_DESIGNER_MODEL','TIMDS_ARTIFACTS_BINDINGS','TIMDS_ARTIFACTS_REST_FALLBACK','TIMDS_WORKERS_SUBDOMAIN_ALIASES','TIMDS_MEDIA_LEGACY_BINDINGS','TIMDS_MEDIA_ALLOWED_ORIGINS','TIMDS_LEGACY_PUBLIC_HOSTS','TIMDS_STUDIO_FRAME_ORIGINS','TIMDS_ACCESS_INVITATIONS_ENABLED','TIMDS_LIVE_INSTANCE_TYPE']
RUNTIME_KEYS=['CLOUDFLARE_API_TOKEN','TIMDS_BUILDS_API_TOKEN','OPENAI_API_KEY','TIMDS_BOOTSTRAP_SECRET','TIMDS_PORTAL_TRANSFER_SECRET']
def read_env():
 if not ENV.is_file() or ENV.is_symlink() or ENV.stat().st_mode&0o077:raise RuntimeError('Private .env unavailable: copy .env.example to .env, chmod 600, fill it in')
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
 with os.fdopen(fd,'w') as f:f.write('# timds-host installation record and runtime secrets. Local only: gitignored, owner-only. Never commit or print.\n'+''.join(f'{k}={v}\n' for k,v in values.items()))
CONFIG=read_env()
for key in ['CLOUDFLARE_ACCOUNT_ID','TIMDS_WORKER_NAME','TIMDS_HOST_ORIGIN']:
 if not CONFIG.get(key):raise SystemExit(f'{key} is required in .env')
ACCOUNT=CONFIG['CLOUDFLARE_ACCOUNT_ID'];NAME=CONFIG['TIMDS_WORKER_NAME']
WORK=Path(os.environ.get('TIMDS_DEPLOY_DIR','/tmp/timds-host-deploy'));STATE=Path(os.environ.get('TIMDS_DEPLOY_STATE',ROOT/'.env.deploy-state.json'))
def state():
 WORK.mkdir(parents=True,exist_ok=True);return json.loads(STATE.read_text()) if STATE.exists() else {}
def save(s):STATE.write_text(json.dumps(s,indent=2)+'\n')
def credentials():
 # The cf CLI authenticates every call with its own sign-in (`cf auth login`).
 # Its token is read here only so logs and error output can redact it.
 try:return (json.loads((Path.home()/'Library/Preferences/cloudflare/config/default.json').read_text())['oauth_token'],)
 except (OSError,KeyError,ValueError):raise RuntimeError('Cloudflare CLI sign-in unavailable: run `node_modules/.bin/cf auth login`')
def environment():
 e=os.environ.copy();s=state();e.pop('CLOUDFLARE_API_TOKEN',None)
 e.update({k:CONFIG[k] for k in INSTALLATION if CONFIG.get(k) is not None})
 e.update({'TIMDS_AGENT_PUSH_QUEUE_ID':CONFIG.get('TIMDS_AGENT_PUSH_QUEUE_ID') or s.get('queueId','')})
 return e
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
  host,file=CONFIG.get('TIMDS_SECRETS_SSH_HOST'),CONFIG.get('TIMDS_SECRETS_SSH_FILE')
  if not host or not file:raise RuntimeError('Set TIMDS_SECRETS_SSH_HOST and TIMDS_SECRETS_SSH_FILE in .env, or write the runtime secrets into .env by hand')
  script="process.loadEnvFile(process.argv[1]); process.stdout.write(JSON.stringify(Object.fromEntries(['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','OPENAI_API_KEY','TIMDS_BUILDS_API_TOKEN'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))));"
  remote=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=12',host,'node -e '+shlex.quote(script)+' '+shlex.quote(file)],capture_output=True,text=True,timeout=25)
  if remote.returncode:raise RuntimeError('Existing server credentials unavailable')
  values=json.loads(remote.stdout)
  if values.pop('CLOUDFLARE_ACCOUNT_ID',None)!=ACCOUNT or any(not values.get(k) for k in ['CLOUDFLARE_API_TOKEN','TIMDS_BUILDS_API_TOKEN','OPENAI_API_KEY']):raise RuntimeError('Existing runtime credentials unavailable or belong to another account')
  values['TIMDS_BOOTSTRAP_SECRET']=CONFIG.get('TIMDS_BOOTSTRAP_SECRET') or secrets.token_urlsafe(48)
  values['TIMDS_PORTAL_TRANSFER_SECRET']=CONFIG.get('TIMDS_PORTAL_TRANSFER_SECRET') or ''
  if not values['TIMDS_PORTAL_TRANSFER_SECRET']:raise RuntimeError('TIMDS_PORTAL_TRANSFER_SECRET must be set in .env')
  write_env({**CONFIG,**values});print(json.dumps({'env':str(ENV),'keys':sorted(values)}))
 elif action=='deploy':
  import threading
  values={k:v for k,v in CONFIG.items() if k in RUNTIME_KEYS}
  missing=[k for k in RUNTIME_KEYS if not values.get(k)]
  if missing:raise RuntimeError('Missing runtime secrets in .env: '+', '.join(missing))
  if os.environ.get('TIMDS_USE_MANAGED_ARTIFACTS_AUTH')=='1':values['CLOUDFLARE_API_TOKEN']=credentials()[0]
  pipe=(WORK/'secrets.json');pipe.unlink(missing_ok=True);os.mkfifo(pipe,0o600)  # an interrupted run can leave the fifo behind
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
