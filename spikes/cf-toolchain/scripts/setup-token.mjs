import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const path = new URL('../.dev.vars', import.meta.url);
try {
  await writeFile(path, `PROBE_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  console.log('Created private .dev.vars for this disposable spike.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .dev.vars retained.');
}
