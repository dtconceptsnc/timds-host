export async function portal(env, action, body, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(`/api/internal/timds/designer/${action}`, env.TIMDS_HOST_ORIGIN || env.PORTAL_ORIGIN), {
    method:'POST', headers:{ Authorization:`Bearer ${env.TIMDS_SANDBOX_RUNNER_TOKEN}`, 'Content-Type':'application/json' },
    body:JSON.stringify(body), signal:AbortSignal.timeout(60_000), redirect:'manual',
  }).catch(error => { console.info({ stage:'callback', status:'network_error', errorType:['TypeError','AbortError','TimeoutError'].includes(error.name) ? error.name : 'Error' }); throw error; });
  console.info({ stage:'callback', status:response.status });
  // Workers supports only manual/follow. Never forward the runner credential
  // to a redirect destination.
  if (response.status >= 300 && response.status < 400) throw new Error('Portal callback redirects are not permitted');
  return response;
}
