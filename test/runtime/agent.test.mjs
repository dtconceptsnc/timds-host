import test from 'node:test';
import assert from 'node:assert/strict';
import {runBoundedCommand} from '../../runtime/agent.mjs';
import {safeTaskDiagnostics} from '../../runtime/policy.mjs';
test('process diagnostics retain only enumerated metadata while draining model output', async () => {
  const progress=[];
  const result=await runBoundedCommand(process.execPath,['-e',`console.log(JSON.stringify({type:'turn.started',message:'secret'}));console.log(JSON.stringify({type:'secret',message:'secret'}));console.error('secret');`],{onProgress:value=>progress.push(value)});
  assert.equal(result.exitCode,0);assert.deepEqual(result.eventTypes,['turn.started']);assert.doesNotMatch(JSON.stringify(progress),/secret/);
  assert.deepEqual(safeTaskDiagnostics({stage:'secret',signal:'secret',error:'secret',eventTypes:['secret']}),{eventTypes:[]});
});
test('timeout kills descendants inheriting stdout and returns bounded metadata', { timeout:2000 }, async () => {
  const result=await runBoundedCommand(process.execPath,['-e',`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)`],{timeoutMs:50});
  assert.equal(result.timedOut,true);assert.equal(result.signal,'SIGKILL');
});
