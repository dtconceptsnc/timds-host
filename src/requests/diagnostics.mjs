// Only these generated identifiers may cross the safe HTTP error boundary.
// Never attach exception messages, stacks, request prompts or provider results.
const stages = {
  'native-repository': new Set(['operation','capability-release','container-cleanup','checkout-release','lease-yield']),
  'native-build-metadata': new Set(['input','start','lifetime','outbound','outbound-binding','outbound-http','outbound-https','manifest','mkdir','copy','control-input','control-exec','result','persist','cleanup-alarm','cleanup-container']),
  'native-build': new Set(['input','manifest','dependencies','start','lifetime','backup','outbound','outbound-binding','outbound-http','outbound-https','restore','source','links','ownership','check','stop-writers','result','persist','cleanup-alarm','cleanup-container','result-protocol']),
  'native-build-dependencies': new Set(['input','start','lifetime','backup','outbound','outbound-binding','outbound-http','outbound-https','runtime','cache-read','package-copy','install','archive','cache-write','cleanup-alarm','cleanup-container']),
  'host-boundary': new Set(['coordinator-rpc','coordinator-operation','mutation-prepare','mutation-cleanup']),
  'publication-preflight': new Set(['authority','merge','metadata','commit','build','stamp']),
  'designer-request-create': new Set(['source','authority','configuration','input','target','reservation','projection','schedule']),
  'designer-request-execute': new Set(['lease','source','identity','principal','authority','target','recovery','designer','finish']),
  'designer-start': new Set(['configuration','identity','input','principal','preview','session','session-identity','claims','runtime-status','credentials','runtime-start']),
  'cloudflare-preview': new Set(['worker-list','worker-write','worker-delete','worker-subdomain','account-subdomain','build-token-verify','build-token-list','build-worker-read','build-worker-create','build-worker-delete','build-preview-migrate','build-triggers-list','build-preview-list','build-connection-delete','branch-preview-delete','unknown']),
  'cloudflare-artifacts': new Set(['repository-read','tokens-list','token-mint','token-revoke','other']),
};
const classes = new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','AbortError','TimeoutError','SandboxFileError','SandboxProtocolError']);
const faults = new Map([
  ['missing-method', /\bis not a function\b|\bmethod (?:is )?not (?:found|implemented)\b/i],
  ['invalid-argument', /unknown option|invalid (?:argument|parameter)|must be (?:a |an )?(?:string|object|boolean|absolute|numeric|AbortSignal)|stream chunks must be Uint8Array/i],
  ['missing-property', /cannot read (?:properties|property) of (?:undefined|null)|undefined is not an object/i],
  ['stream-state', /(?:stream|reader|writer|body).*(?:locked|disturbed|already used|closed|cancelled|canceled)|(?:locked|disturbed).*(?:stream|body)/i],
  ['subrequest-limit', /too many (?:subrequests|api requests)|subrequest limit/i],
  ['cpu-limit', /exceeded.*cpu|cpu.*limit/i],
  ['memory-limit', /memory limit|out of memory/i],
  ['io-context', /different request|i\/o.*context|i\/o.*request/i],
  ['object-reset', /durable object.*reset|object.*reset|code was updated|storage.*reset/i],
  ['rpc-cancelled', /rpc.*cancel|rpc.*dispos|rpc.*session|destination object no longer exists/i],
  ['unresolved-promise', /never generate a response|hanging promise|promise will never/i],
  ['timeout', /timed? ?out|timeout|deadline/i],
  ['connection', /connection.*(?:closed|lost|reset)|disconnected|network/i],
]);
export function requestDiagnostic(error, stage, operation = 'designer-request-create') {
  if (safeRequestDiagnostic(error?.requestDiagnostic)) return error;
  const value = { operation, stage, errorClass:classes.has(error?.name) ? error.name : 'Error',
    fault:[...faults].find(([,pattern])=>pattern.test(String(error?.message||'')))?.[0] || 'unclassified',
    ...(Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? {statusCode:error.statusCode} : {}) };
  if (stages[operation]?.has(stage)) error.requestDiagnostic=value;
  return error;
}
export function safeRequestDiagnostic(value) {
  return Object.hasOwn(stages,value?.operation || '') && stages[value.operation].has(value.stage) && classes.has(value.errorClass)
    ? { operation:value.operation, stage:value.stage, errorClass:value.errorClass,
      ...(faults.has(value.fault)||value.fault==='unclassified'?{fault:value.fault}:{}),
      ...(Number.isInteger(value.statusCode) && value.statusCode >= 400 && value.statusCode <= 599 ? {statusCode:value.statusCode} : {}),
      ...(['cloudflare-preview','cloudflare-artifacts'].includes(value.operation)&&Number.isInteger(value.providerStatus)&&value.providerStatus>=100&&value.providerStatus<=599?{providerStatus:value.providerStatus}:{}),
      ...(['cloudflare-preview','cloudflare-artifacts'].includes(value.operation)&&Array.isArray(value.providerCodes)?{providerCodes:value.providerCodes.filter(code=>Number.isSafeInteger(code)&&code>=0&&code<=1_000_000_000).slice(0,8)}:{}) } : null;
}

// Retain the actual operation failure when bounded cleanup also fails.
// Cleanup has one separate allowlisted receipt, never a chain of raw errors.
export async function finishCleanup(cleanup,primary,stage='checkout-release') {
  try{return await cleanup();}
  catch(cause){
    const error=requestDiagnostic(cause instanceof Error?cause:new Error('Cleanup failed'),stage,'native-repository');
    if(!primary)throw error;
    primary.cleanupDiagnostic=safeRequestDiagnostic(error.requestDiagnostic);
  }
}

// Native RPC carries only generated diagnostics, never provider messages/stacks.
// Preserve successful return values for callers on the preceding deployment.
// Only failures use an envelope to avoid RPC Error reconstruction losing stages.
export async function nativeBuildResult(operation, task) {
  let stage='input';
  const tag=cause=>requestDiagnostic(cause instanceof Error?cause:new Error('Native build failed'),stage,operation);
  try {return await task(value=>{stage=value;},tag);}
  catch(cause) {
    const error=tag(cause);
    const check=/^Isolated publication (workspace|token_reference|token_cycle|media_reference|artifact_reference) check failed$/.exec(error.message||'')?.[1];
    return {kind:'timds-native-build-result',ok:false,error:{requestDiagnostic:safeRequestDiagnostic(error.requestDiagnostic),...(safeRequestDiagnostic(error.cleanupDiagnostic)?{cleanupDiagnostic:safeRequestDiagnostic(error.cleanupDiagnostic)}:{}),...(check?{check}:{})}};
  }
}
const treeReceipt=value=>value?.kind==='timds-file-tree'&&typeof value.ref==='string'&&value.ref.startsWith('snapshots/')&&/^[a-f0-9]{64}$/.test(value.digest||'')&&Number.isSafeInteger(value.entryCount)&&value.entryCount>=0&&Number.isSafeInteger(value.totalBytes)&&value.totalBytes>=0;
function validBuildSuccess(value,operation){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  if(operation==='release-metadata')return typeof value.version==='string'&&value.version.length>0&&treeReceipt(value.files);
  if(operation==='stamp')return value.stamp&&typeof value.stamp==='object'&&typeof value.artifact?.entryPath==='string'&&Number.isSafeInteger(value.artifact.fileCount)&&Number.isSafeInteger(value.artifact.totalBytes);
  if(operation==='build')return treeReceipt(value.files)&&typeof value.cacheKey==='string'&&value.checks?.workspace===true;
  if(operation==='dependencies')return value.version===1&&typeof value.key==='string'&&typeof value.image==='string'&&value.runtime&&typeof value.backup?.sha256==='string';
  return false;
}
export async function unwrapNativeBuildResult(result,operation) {
  const receipt=await result;
  // Accept both the original result and the brief successful-envelope rollout.
  const value=receipt?.kind==='timds-native-build-result'&&receipt.ok===true?receipt.value:receipt;
  if(validBuildSuccess(value,operation))return value;
  if(receipt?.kind!=='timds-native-build-result'||receipt.ok!==false)throw requestDiagnostic(new Error('Invalid native build result'),'result-protocol','native-build');
  const diagnostic=safeRequestDiagnostic(receipt.error?.requestDiagnostic);
  const check=new Set(['workspace','token_reference','token_cycle','media_reference','artifact_reference']).has(receipt.error?.check)?receipt.error.check:null;
  const error=new Error(check?`Isolated publication ${check} check failed`:'Native build operation failed');
  if(diagnostic){error.name=diagnostic.errorClass;error.requestDiagnostic=diagnostic;if(diagnostic.statusCode)error.statusCode=diagnostic.statusCode;}
  if(safeRequestDiagnostic(receipt.error?.cleanupDiagnostic))error.cleanupDiagnostic=safeRequestDiagnostic(receipt.error.cleanupDiagnostic);
  throw error;
}
