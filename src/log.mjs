// One JSON line per operational event, written with console.* so Workers Logs
// captures it with the invocation's own context (request, Durable Object,
// Workflow step, queue). Only the keys below cross into logs, and only as
// identifiers, labels and numbers: never error messages, stacks, prompts,
// model output, file contents, request bodies or credentials. Workers Logs is
// an operator tool; the per-source `events` table stays the user-visible log.
import { safeRequestDiagnostic } from './requests/diagnostics.mjs';
const LABELS = new Set(['event','operation','stage','outcome','errorClass','fault','diagnosticOperation','diagnosticStage','queue']);
const NUMBERS = new Set(['statusCode','durationMs','attempt','hit','blobsRead','blobsFound']);
const IDS = new Set(['sourceId','sessionId','publicationId','requestId']);
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function logEvent(fields, write = console) {
  const line = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value == null) continue;
    if (LABELS.has(key) && LABEL.test(String(value))) line[key] = String(value);
    else if (NUMBERS.has(key) && Number.isFinite(value)) line[key] = Math.round(value);
    else if (IDS.has(key) && UUID.test(String(value))) line[key] = String(value).toLowerCase();
  }
  if (!line.event) return null;
  const level = line.outcome === 'error' || line.statusCode >= 500 ? 'error' : line.outcome === 'failed' ? 'warn' : 'info';
  write[level](JSON.stringify({ timds: 1, ...line }));
  return line;
}
// The allowlisted diagnostic already attached to an error, as log fields. Its
// operation and stage are the container or host labels of the failing step,
// kept apart from the operation and stage of the line that reports it.
export function errorFields(error) {
  const diagnostic = safeRequestDiagnostic(error?.requestDiagnostic);
  return { errorClass: error?.name || 'Error', statusCode: error?.statusCode,
    ...(diagnostic ? { diagnosticOperation: diagnostic.operation, diagnosticStage: diagnostic.stage, fault: diagnostic.fault } : {}) };
}
