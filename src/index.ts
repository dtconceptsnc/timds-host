export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === '/health') {
      return Response.json({ service: 'timds-host', apiVersion: 1, ready: false, phase: 'conformance' });
    }
    return Response.json({ apiVersion: 1, error: 'The host is awaiting contract conformance acceptance.' }, { status: 503 });
  },
};
