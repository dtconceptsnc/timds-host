import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const contract = JSON.parse(await readFile(new URL('../docs/api/timds-host.openapi.json', import.meta.url), 'utf8'));

/** Validate the vendored OpenAPI 3.1 schemas, including nested refs and headers. */
export function createContractValidator(spec = contract) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'urn:timds:host:v1', components: spec.components });
  const resolve = value => value?.$ref
    ? value.$ref.slice(2).split('/').reduce((part, key) => part[key], spec)
    : value;
  const compile = schema => ajv.compile({ ...schema, $id: undefined, $defs: undefined,
    // OpenAPI local refs resolve through the versioned schema document.
    ...JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"urn:timds:host:v1#/components/')) });
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({
    ...operation, method: method.toUpperCase(), path,
    pattern: new RegExp(`^${path.split('/').map(part => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`),
    responses: Object.fromEntries(Object.entries(operation.responses).map(([status, response]) => {
      response = resolve(response);
      return [status, { ...response, validators: Object.fromEntries(Object.entries(response.content || {}).map(([type, item]) => [type, compile(item.schema)])),
        // Preserve the inherited contract's mandatory headers unless an
        // additive header explicitly opts out with required: false.
        headerValidators: Object.fromEntries(Object.entries(response.headers || {}).map(([name, header]) => {
          header = resolve(header);
          return [name, { required: header.required !== false, validate: compile(header.schema) }];
        })) }];
    })),
  })));
  const describe = errors => errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ');
  return async function validate(url, init, response) {
    const method = (init?.method || 'GET').toUpperCase();
    const pathname = new URL(url).pathname;
    const operation = operations.find(item => item.method === method && item.pattern.test(pathname));
    if (!operation) throw new Error(`No v1 contract operation: ${method} ${pathname}`);
    const label = `${operation.operationId} HTTP ${response.status}`;
    const definition = operation.responses[response.status] || operation.responses[`${Math.floor(response.status / 100)}XX`];
    if (!definition) throw new Error(`${label}: undocumented response status`);
    for (const [name, { required, validate: validateHeader }] of Object.entries(definition.headerValidators)) {
      const value = response.headers.get(name);
      if (value === null && !required) continue;
      if (!validateHeader(value)) throw new Error(`${label}: ${name} ${describe(validateHeader.errors)}`);
    }
    if (method === 'HEAD') {
      // HEAD omits representation bytes, not its media type. The vendored
      // contract intentionally omits HEAD content; use its matching GET type.
      const get = operations.find(item => item.method === 'GET' && item.path === operation.path);
      const representation = get?.responses[response.status] || get?.responses[`${Math.floor(response.status / 100)}XX`];
      const types = Object.keys(representation?.validators || {});
      const mediaType = response.headers.get('content-type')?.split(';')[0].trim();
      if (types.length && !types.includes(mediaType)) throw new Error(`${label}: undocumented Content-Type ${mediaType || '(absent)'}`);
      if ((await response.clone().text()) !== '') throw new Error(`${label}: HEAD must have an empty body`);
      return operation.operationId;
    }
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim();
    const validateBody = definition.validators[mediaType];
    if (!validateBody) throw new Error(`${label}: undocumented Content-Type ${mediaType || '(absent)'}`);
    let body;
    try { body = mediaType === 'application/json' ? await response.clone().json() : await response.clone().text(); }
    catch { throw new Error(`${label}: malformed ${mediaType} response`); }
    if (!validateBody(body)) throw new Error(`${label}: ${describe(validateBody.errors)}`);
    return operation.operationId;
  };
}
