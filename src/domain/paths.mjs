// Pure validators from dtconceptsnc/toperator at 74bceaa.
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export function sessionFilePath(value) {
  if (typeof value !== "string" || value.length > 500 || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some(p => !p || [".", ".."].includes(p) || /^(?:\.git|node_modules|\.github|dist)$/i.test(p)) || /\.(?:pem|key|p12|pfx)$/i.test(value) || /(^|\/)\.timds\/(?:session|start|auth)(?:[./]|$)/i.test(value) || /(^|\/)\.env(?:\.|$)/i.test(value) && !value.endsWith(".env.example")) {
    throw fail(400, "Change set contains an unsafe or private path");
  }
  return value;
}

export function parseSessionResolution(value) {
  if (typeof value !== 'string') throw fail(400, 'Invalid conflict resolution');
  const match = value.match(/^(.*?)#(.+)=(mine|theirs)$/);
  if (!match) return { path: sessionFilePath(value), key: null, choice: 'mine', raw: value };
  if (match[2].length > 1000 || /[\x00-\x1f\x7f]/.test(match[2])) throw fail(400, 'Invalid conflict key');
  return { path: sessionFilePath(match[1]), key: match[2], choice: match[3], raw: value };
}
