import { setTimeout as delay } from 'node:timers/promises';

const transientCodes = new Set(['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
function transientNetworkError(error, depth = 0) {
  if (!error || depth > 4) return false;
  if (Array.isArray(error.errors)) return error.errors.length > 0 && error.errors.length <= 8 && error.errors.every(cause => transientNetworkError(cause, depth + 1));
  if (error.cause) return transientNetworkError(error.cause, depth + 1);
  return transientCodes.has(error.code);
}

// Only the toolkit's anonymous verification GET may retry. The publisher that
// committed the pointer is outside this boundary and must never run again here.
export function createAnonymousPublicReadFetch({ fetchImpl = fetch, sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    const headers = new Headers(init?.headers || request?.headers);
    const method = String(init?.method || request?.method || 'GET').toUpperCase();
    const signal = init?.signal || request?.signal;
    const anonymous = method === 'GET' && !headers.has('authorization') && !headers.has('cookie');
    const waits = [200, 800];
    for (let attempt = 0; ; attempt++) {
      try { return await fetchImpl(input, init); }
      catch (error) {
        if (!anonymous || signal?.aborted || attempt >= waits.length || !transientNetworkError(error)) throw error;
        await sleep(waits[attempt], signal);
        signal?.throwIfAborted();
      }
    }
  };
}

export const fetchAnonymousPublicRead = createAnonymousPublicReadFetch();

export async function verifyPublishedRead({root,stamp,fetchImpl=fetchAnonymousPublicRead}) {
 const url=new URL('.timds-artifact.json',root);
 // Workerd supports manual/follow only. The non-OK check rejects redirects.
 const response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(30_000)});
 if(!response.ok)throw new Error('Published public stamp is unavailable');
 const reader=response.body?.getReader(),chunks=[];let size=0;
 while(reader){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64*1024){await reader.cancel();throw new Error('Published public stamp exceeds limit');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 let actual;try{actual=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('Published public stamp is invalid');}
 for(const field of ['schemaVersion','systemId','version','sourceCommit','contentDigest'])if(actual?.[field]!==stamp[field])throw new Error('Published public stamp identity differs');
 return true;
}
