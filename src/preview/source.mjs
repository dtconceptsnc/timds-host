import {isDeepStrictEqual} from 'node:util';

export const previewSourcePins = Object.freeze({
  '@dtconcepts/timds':'0.1.464',
  '@cloudflare/vite-plugin':'2.0.0-beta.sha-91c870c02',
  cf:'1.0.0-beta.14',
  vite:'8.3.4',
});

const json = value => `${JSON.stringify(value,null,2)}\n`;
const encode = (path,content) => ({path,encoding:'base64',content:Buffer.from(content).toString('base64'),mode:'100644'});
const fail = message => {throw new Error(`Preview source conversion: ${message}`);};

/** A reviewable conversion of the known .464 hosted standalone scaffold only.
 * Source/framework build scripts remain authoritative. npm owns the lockfile;
 * callers must install and prove the output before provisioning this tree. */
export function prepareCfPreviewFiles(files,{workerName}={}) {
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName||''))fail('provide an explicit valid Worker name');
  if(!Array.isArray(files))fail('files must be a source file array');
  const byPath=new Map();
  for(const file of files) {
    if(!file||typeof file.path!=='string'||file.encoding!=='base64'||typeof file.content!=='string'||Buffer.from(file.content,'base64').toString('base64')!==file.content||byPath.has(file.path))fail('source files must have unique paths and canonical base64 content');
    byPath.set(file.path,file);
  }
  const read = name => {const file=byPath.get(name);if(!file)fail(`${name} is required`);if(file.mode&&file.mode!=='100644'&&file.mode!=='100755')fail(`${name} must be a regular file`);return Buffer.from(file.content,'base64').toString('utf8');};
  const parse = name => {try{return JSON.parse(read(name));}catch{fail(`${name} must be valid JSON`);}};
  const manifest=parse('timds.json'),pkg=parse('package.json');
  if(manifest.schemaVersion!==2||manifest.provider?.kind!=='hosted'||manifest.artifact?.entry!=='index.html'||manifest.artifact?.publishRef!=='timds-published'||!isDeepStrictEqual(manifest.workspace?.build,['node','scripts/build.mjs'])||!isDeepStrictEqual(manifest.workspace?.check,['node','scripts/check.mjs']))fail('only the .464 hosted standalone custom build is supported; review other framework conversions separately');
  if(pkg.scripts?.timds!=='timds'||pkg.scripts?.['build:preview']!=='npm run timds -- check')fail('preserve and explicitly review the source build:preview command');
  read('scripts/build.mjs');read('scripts/check.mjs');
  if(!['0.1.x','0.1.464'].includes(pkg.devDependencies?.['@dtconcepts/timds']))fail('the source must use toolkit 0.1.464 or its fresh scaffold 0.1.x range');
  if(byPath.has('package-lock.json')) {
    const lock=parse('package-lock.json');
    if(lock.packages?.['node_modules/@dtconcepts/timds']?.version!=='0.1.464')fail('existing lockfile must already resolve toolkit 0.1.464');
  }
  for(const file of files)if(file.path==='index.html'||/^(?:vite\.config\.|cloudflare\.config\.|wrangler\.(?:json$|toml$|config\.))/.test(file.path))fail(`existing ${file.path} requires a separate reviewed conversion`);
  const legacy=parse('wrangler.jsonc');
  if(!isDeepStrictEqual(Object.keys(legacy).sort(),['assets','compatibility_date','name','previews'])||!isDeepStrictEqual(legacy.assets,{directory:'./dist'})||!isDeepStrictEqual(legacy.previews,{})||!/^\d{4}-\d{2}-\d{2}$/.test(legacy.compatibility_date||'')||pkg.devDependencies.wrangler!=='^4.135.0')fail('Wrangler configuration differs from the fresh .464 static scaffold');
  for(const name of Object.keys(previewSourcePins))if(pkg.dependencies?.[name])fail(`${name} is already a runtime dependency; review its conversion separately`);
  const devDependencies={...pkg.devDependencies,...previewSourcePins};delete devDependencies.wrangler;
  const cloudflare=`// TimDS .464 static Preview packaging; source build remains build:preview.\nimport {defineConfig} from 'cf/config';\nexport default defineConfig({worker:{name:${JSON.stringify(workerName)},compatibilityDate:${JSON.stringify(legacy.compatibility_date)},assets:{htmlHandling:'auto-trailing-slash'}}});\n`;
  const vite=`// The toolkit builds dist. Vite copies public assets without transforming HTML.\nimport {existsSync} from 'node:fs';\nimport {fileURLToPath} from 'node:url';\nimport {defineConfig} from 'vite';\nimport {cloudflare} from '@cloudflare/vite-plugin';\nconst root=fileURLToPath(new URL('.',import.meta.url));\nif(existsSync(new URL('./index.html',import.meta.url)))throw new Error('TimDS static Preview cannot accept a root index.html; review source conversion');\nif(!existsSync(new URL('./dist/index.html',import.meta.url)))throw new Error('Run npm run build:preview before cf build or deploy');\nexport default defineConfig({root,publicDir:fileURLToPath(new URL('./dist',import.meta.url)),plugins:[cloudflare()]});\n`;
  const ignore=byPath.has('.gitignore')?read('.gitignore'):'';
  const ignores=['.cloudflare/','.vite/'].filter(line=>!ignore.split(/\r?\n/).includes(line));
  return {
    changedFiles:[encode('package.json',json({...pkg,devDependencies})),encode('cloudflare.config.ts',cloudflare),encode('vite.config.mjs',vite),...(ignores.length?[encode('.gitignore',`${ignore}${ignore&&!ignore.endsWith('\n')?'\n':''}${ignores.join('\n')}\n`)]:[])],
    deletedPaths:['wrangler.jsonc'],
    pins:{...previewSourcePins},
    verification:{buildCommand:'npm run build:preview',packageCommand:'npx --no-install cf build',assetDirectory:'.cloudflare/output/v0/workers/default/assets',requiresNpmInstall:true},
  };
}
