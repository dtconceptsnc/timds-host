import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { mergeFileTrees } from "@dtconcepts/timds/merge";
const artifactsGitEnvironment = () => process.env; // Credentials are injected outside this container.

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const revision = value => /^[a-f0-9]{40}$/.test(value || "");
const same = (a, b) => a?.oid === b?.oid && a?.mode === b?.mode;
const MAX_CHANGESET_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
// Only a single trusted repository operation owns each temporary checkout.
// Reuse immutable blobs across its validation, three-way merge and response.
const blobCaches = new Map();

export function sessionFilePath(value) {
  if (typeof value !== "string" || value.length > 500 || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some(p => !p || [".", ".."].includes(p) || /^(?:\.git|node_modules|\.github|dist)$/i.test(p)) || /\.(?:pem|key|p12|pfx)$/i.test(value) || /(^|\/)\.timds\/(?:session|start|auth)(?:[./]|$)/i.test(value) || /(^|\/)\.env(?:\.|$)/i.test(value) && !value.endsWith(".env.example")) {
    throw fail(400, "Change set contains an unsafe or private path");
  }
  return value;
}

// All commits use Git object/index plumbing. Uploaded files are never executed
// or written through repository symlinks, and hooks/global Git config are off.
async function git(cwd, args, { input, env = process.env, allowFailure = false, maxOutputBytes = MAX_CHANGESET_BYTES * 2, binary = false } = {}) {
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "TimDS", GIT_AUTHOR_EMAIL: "timds@localhost", GIT_COMMITTER_NAME: "TimDS", GIT_COMMITTER_EMAIL: "timds@localhost" };
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = []; let size = 0, oversized = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
    child.stdout.on("data", chunk => { size += chunk.length; if (size > maxOutputBytes) { oversized = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.stderr.resume(); // Remote diagnostics can contain credentials; never propagate them.
    child.on("error", () => { clearTimeout(timer); reject(fail(503, "The server Git client is unavailable")); });
    child.on("close", (code, signal) => { clearTimeout(timer); if (oversized) reject(fail(413, "Design System source exceeds the session limit")); else if (timedOut || signal || code === null) reject(fail(504, "Design System Git operation was interrupted; retry the session operation")); else if (code && !allowFailure) reject(fail(502, "Design System Git operation failed; retry the session operation")); else { const bytes = Buffer.concat(chunks); resolve({ code, bytes, text: binary ? undefined : bytes.toString("utf8").trim() }); } });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function tree(cwd, ref) {
  const result = await git(cwd, ["ls-tree", "-r", "-z", ref]);
  const entries = new Map();
  for (const record of result.bytes.toString().split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t"); const [mode, type, oid] = record.slice(0, tab).split(" "); const path = sessionFilePath(record.slice(tab + 1));
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) throw fail(409, "Gitless sessions require plain files and relative links; remove source submodules first");
    entries.set(path, { path, mode, oid });
    if (entries.size > 4000) throw fail(413, "Design System has too many source files for a session");
  }
  return entries;
}

// Git's batch protocol is binary-safe only when payloads are consumed by the
// declared byte count. Never split the entire output on newlines or decode it.
export function parseGitBlobBatch(bytes, expected) {
  const result = new Map(); let offset = 0;
  for (const { oid, size } of expected) {
    const header = Buffer.from(`${oid} blob ${size}\n`);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CHANGESET_BYTES || !bytes.subarray(offset, offset + header.length).equals(header)) throw fail(502, "Invalid Git blob batch response");
    offset += header.length;
    if (offset + size >= bytes.length || bytes[offset + size] !== 10) throw fail(502, "Invalid Git blob batch response");
    result.set(oid, { size, content: bytes.subarray(offset, offset + size).toString('base64') });
    offset += size + 1;
  }
  if (offset !== bytes.length) throw fail(502, "Invalid Git blob batch response");
  return result;
}

async function files(cwd, ref, entries) {
  entries ||= await tree(cwd, ref);
  const result = [], unique = [...new Set([...entries.values()].map(entry => entry.oid))];
  if (!unique.length) return result;
  const input = unique.join('\n') + '\n';
  const metadata = (await git(cwd, ['cat-file', '--batch-check'], { input })).text.split('\n');
  if (metadata.length !== unique.length) throw fail(502, 'Invalid Git blob metadata');
  const sizes = new Map();
  for (const [index, line] of metadata.entries()) {
    const match = line.match(/^([a-f0-9]{40}) blob (0|[1-9]\d*)$/), size = Number(match?.[2]);
    if (!match || match[1] !== unique[index] || !Number.isSafeInteger(size)) throw fail(502, 'Invalid Git blob metadata');
    sizes.set(match[1], size);
  }
  let total = 0;
  for (const entry of entries.values()) {
    const size = sizes.get(entry.oid); total += size;
    if (size > MAX_CHANGESET_BYTES || total > MAX_SNAPSHOT_BYTES) throw fail(413, 'Design System source exceeds 10 MiB per file or 50 MiB per session; keep media in R2');
  }
  const cache = blobCaches.get(cwd), blobs = new Map(), missing = [];
  for (const oid of unique) {
    const cached = cache?.blobs.get(oid);
    if (cached && cached.size === sizes.get(oid)) blobs.set(oid, cached);
    else missing.push({ oid, size: sizes.get(oid) });
  }
  if (missing.length) {
    const maxOutputBytes = missing.reduce((sum, { oid, size }) => sum + Buffer.byteLength(`${oid} blob ${size}\n`) + size + 1, 0);
    const response = await git(cwd, ['cat-file', '--batch'], { input: missing.map(entry => entry.oid).join('\n') + '\n', maxOutputBytes, binary: true });
    for (const [oid, blob] of parseGitBlobBatch(response.bytes, missing)) {
      blobs.set(oid, blob);
      // Bound retained cache bytes across multiple revisions of a checkout.
      if (cache && cache.bytes + blob.size <= MAX_SNAPSHOT_BYTES) { cache.blobs.set(oid, blob); cache.bytes += blob.size; }
    }
  }
  for (const entry of entries.values()) {
    const blob = blobs.get(entry.oid);
    if (entry.mode === '120000') safeLink(entry.path, Buffer.from(blob.content, 'base64'));
    result.push({ path: entry.path, encoding: 'base64', content: blob.content, mode: entry.mode });
  }
  validateLinks(result);
  return result;
}

function safeLink(path, bytes) {
  const target = bytes.toString("utf8"); const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  const segments = target.split("/");
  if (!target || path === ".timds" || target.startsWith("/") || /^[A-Za-z]:/.test(target) || /[\\\x00-\x1f\x7f]/.test(target) || segments.includes(".") || segments.includes("") || segments.findIndex(part => part !== "..") < segments.lastIndexOf("..") || resolved === ".." || resolved.startsWith("../")) throw fail(400, "Source link leaves the Design System or uses an unsafe target");
  sessionFilePath(resolved);
  return resolved;
}

function validateLinks(files) {
  const entries = new Map(files.map(file => [file.path, file]));
  for (const file of files) {
    if (file.mode !== "120000") continue;
    let target = safeLink(file.path, Buffer.from(file.content, "base64"));
    const visited = new Set([file.path]);
    while (true) {
      const parts = target.split("/"); let linked = false;
      for (let index = 1; index <= parts.length; index++) {
        const candidate = parts.slice(0, index).join("/"); const entry = entries.get(candidate);
        if (entry?.mode !== "120000") continue;
        if (visited.has(candidate)) throw fail(400, "Source tree contains a cyclic link");
        visited.add(candidate); // At most one visit per link in the bounded tree.
        target = posix.join(safeLink(candidate, Buffer.from(entry.content, "base64")), ...parts.slice(index));
        sessionFilePath(target);
        linked = true; break;
      }
      if (!linked) break;
    }
  }
}

async function changedTree(cwd, base, changes) {
  if (!revision(changes.baseRevision) || changes.baseRevision !== base || !Array.isArray(changes.changedFiles) || !Array.isArray(changes.deletedPaths)) throw fail(400, "Invalid session change set");
  if (changes.changedFiles.length + changes.deletedPaths.length > 4000) throw fail(413, "Too many changed paths");
  const seen = new Set(); let total = 0;
  await git(cwd, ["read-tree", base]);
  const tracked = await tree(cwd, base);
  const deletedPaths = changes.deletedPaths.map(sessionFilePath);
  const finalPaths = new Set(tracked.keys());
  for (const name of deletedPaths) finalPaths.delete(name);
  for (const file of changes.changedFiles) finalPaths.add(sessionFilePath(file?.path));
  const ordered = [...finalPaths].sort();
  if (ordered.some((name, index) => index && name.startsWith(`${ordered[index - 1]}/`))) throw fail(400, "Change set contains conflicting file and directory paths");
  for (const path of deletedPaths) {
    if (seen.has(path)) throw fail(400, "Duplicate changed or deleted path"); seen.add(path);
    await git(cwd, ["update-index", "--force-remove", "--", path]);
  }
  for (const file of changes.changedFiles) {
    const path = sessionFilePath(file.path);
    if (seen.has(path)) throw fail(400, "Duplicate changed path"); seen.add(path);
    if (file.encoding !== "base64" || typeof file.content !== "string") throw fail(400, "Changed files must contain base64 bytes");
    if (file.content.length > Math.ceil(MAX_CHANGESET_BYTES / 3) * 4) throw fail(413, "Change set exceeds 10 MiB; keep media in R2");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content) throw fail(400, "Changed files must contain canonical base64 bytes");
    total += bytes.length;
    if (total > MAX_CHANGESET_BYTES) throw fail(413, "Change set exceeds 10 MiB; keep media in R2");
    const mode = file.mode || tracked.get(path)?.mode || "100644";
    if (!["100644", "100755", "120000"].includes(mode)) throw fail(400, "Unsupported source file mode");
    if (mode === "120000") safeLink(path, bytes);
    const oid = (await git(cwd, ["hash-object", "-w", "--stdin"], { input: bytes })).text;
    await git(cwd, ["update-index", "--add", "--cacheinfo", mode, oid, path]);
  }
  const desired = (await git(cwd, ["write-tree"])).text;
  await files(cwd, desired); // Check size, links and the complete tree before checkout or push.
  // Materialize the candidate only for Git's ignore engine. checkout-index does
  // not execute hooks or filters; symlinks never participate in our file writes.
  await git(cwd, ["checkout-index", "--all", "--force"]);
  const addedPaths = changes.changedFiles.map(f => f.path).filter(path => !tracked.has(path));
  if (addedPaths.length) {
    const ignored = await git(cwd, ["check-ignore", "--no-index", "--stdin", "-z"], { input: Buffer.from(addedPaths.join("\0") + "\0"), allowFailure: true });
    if (ignored.code !== 1) throw fail(400, "Change set includes ignored files");
  }
  return desired;
}

// The exact same pure merge contract runs in the toolkit and the repository service.
export async function mergeFiles(cwd, base, local, upstream, resolvedPaths = []) {
  const snapshots = [], existing = new Map();
  for (const ref of [base, local, upstream]) {
    const entries = await tree(cwd, ref), snapshot = await files(cwd, ref, entries);
    snapshots.push(snapshot);
    for (const file of snapshot) {
      const candidates = existing.get(file.path) || [];
      candidates.push({ content: file.content, oid: entries.get(file.path).oid }); existing.set(file.path, candidates);
    }
  }
  const result = mergeFileTrees(...snapshots, {resolvedPaths});
  if(result.conflicts.length) return result;
  await git(cwd,['read-tree','--empty']);
  const index = [];
  for(const file of result.files){
    const known = existing.get(file.path)?.find(candidate => candidate.content === file.content);
    const oid = known?.oid || (await git(cwd,['hash-object','-w','--stdin'],{input:Buffer.from(file.content,'base64')})).text;
    index.push(`${file.mode || '100644'} ${oid}\t${sessionFilePath(file.path)}\0`);
  }
  if (index.length) await git(cwd, ['update-index', '-z', '--index-info'], { input: index.join('') });
  return {...result,tree:(await git(cwd,['write-tree'])).text};
}

async function rebasedChangeSet(cwd, head, mergedTree, note = '') {
  const [current, merged] = await Promise.all([files(cwd, head), files(cwd, mergedTree)]);
  const before = new Map(current.map(file => [file.path, file]));
  const after = new Set(merged.map(file => file.path));
  return { baseRevision: head, changedFiles: merged.filter(file => { const prior = before.get(file.path); return !prior || prior.content !== file.content || prior.mode !== file.mode; }), deletedPaths: current.filter(file => !after.has(file.path)).map(file => file.path), note };
}

export function createSandboxRepositoryEngine({ artifacts, ensurePreview = async () => {}, previewUrl = () => "", deletePreview = async () => {}, onForkPushed = async () => {}, sessionTtlMs = 24 * 60 * 60 * 1000 } = {}) {
  async function revokeForkTokens(source, repository) {
    let tokens;
    try { tokens = await artifacts.listTokens(source.artifacts_namespace, repository); }
    catch (error) { if (error.statusCode === 404) return; throw error; }
    for (const token of tokens) await artifacts.revokeToken(source.artifacts_namespace, token.id);
  }
  async function temporary(fn) { const cwd = await mkdtemp(join(tmpdir(), "timds-session-")); blobCaches.set(cwd, { blobs: new Map(), bytes: 0 }); try { await git(cwd, ["init", "--initial-branch=main"]); return await fn(cwd); } finally { blobCaches.delete(cwd); await rm(cwd, { recursive: true, force: true }); } }
  async function remote(source, repository, permission, fn) {
    const ns = source.artifacts_namespace;
    const repo = await artifacts.getRepository(ns, repository);
    if (!repo?.remote) throw fail(409, "Artifacts repository is unavailable");
    const token = await artifacts.mintToken(ns, repository, { permission, ttlSeconds: 300 });
    try { return await fn(repo.remote, artifactsGitEnvironment(token.token), token); }
    finally { await artifacts.revokeToken(ns, token.id); }
  }
  async function fetchRef(cwd, source, repository, ref, destination) {
    return remote(source, repository, "read", async (url, env) => {
      await git(cwd, ["fetch", "--no-tags", url, `${ref}:${destination}`], { env });
      return (await git(cwd, ["rev-parse", destination])).text;
    });
  }
  async function push(cwd, source, repository, commit, branch, expected) {
    const result = await remote(source, repository, "write", (url, env) => git(cwd, ["push", `--force-with-lease=refs/heads/${branch}:${expected || ""}`, url, `${commit}:refs/heads/${branch}`], { env }));
    if (branch === 'main' && /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(repository) && revision(commit)) {
      // A notification failure cannot undo or misreport an accepted Git write.
      // The provider's durable push queue remains the independent fallback.
      try { await onForkPushed({ repository, headCommit: commit }); } catch {}
    }
    return result;
  }
  async function currentRef(cwd, source, repository, branch) {
    return remote(source, repository, "read", async (url, env) => {
      const value = (await git(cwd, ["ls-remote", url, `refs/heads/${branch}`], { env })).text.split(/\s/)[0];
      return revision(value) ? value : "";
    });
  }
  async function commit(cwd, treeId, parents, message, date) {
    return (await git(cwd, ["commit-tree", treeId, ...[...new Set(parents)].flatMap(p => ["-p", p]), "-m", message], date ? { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } } : {})).text;
  }
  async function sessionTree(cwd, source, session) { return fetchRef(cwd, source, session.fork_repository, "refs/heads/main", "refs/session/main"); }
  return {
    async provisionFiles(source, { operationId, files: inputFiles }) {
      if (!/^[a-f0-9-]{36}$/.test(operationId || "")) throw fail(400, "Invalid creation operation");
      await revokeForkTokens(source, source.artifacts_repository);
      return temporary(async cwd => {
        const existing = await currentRef(cwd, source, source.artifacts_repository, "main");
        const message = `Initialize TimDS ${operationId}`;
        if (existing) {
          await fetchRef(cwd, source, source.artifacts_repository, "refs/heads/main", "refs/upstream/main");
          if ((await git(cwd, ["log", "-1", "--format=%s", existing])).text !== message) throw fail(409, "The Artifacts source already contains different work");
          return { headCommit: existing };
        }
        await git(cwd, ["read-tree", "--empty"]);
        const empty = await commit(cwd, (await git(cwd, ["write-tree"])).text, [], `Reserve TimDS ${operationId}`);
        const desired = await changedTree(cwd, empty, { baseRevision: empty, changedFiles: inputFiles, deletedPaths: [] });
        const headCommit = await commit(cwd, desired, [], message);
        await push(cwd, source, source.artifacts_repository, headCommit, "main", "");
        return { headCommit };
      });
    },
    async readSource(source, { ref = "main" } = {}) {
      if (ref !== "main" && !revision(ref)) throw fail(400, "Source ref must be main or a commit");
      return temporary(async cwd => {
        const baseRevision = await fetchRef(cwd, source, source.artifacts_repository, ref === "main" ? "refs/heads/main" : ref, "refs/source/main");
        return { baseRevision, files: await files(cwd, baseRevision) };
      });
    },
    async removeSource(source) {
      const repo = await artifacts.getRepository(source.artifacts_namespace, source.artifacts_repository);
      if (!repo) return;
      if (!source.artifacts_repository_id || String(repo.id) !== String(source.artifacts_repository_id)) throw fail(409, "Artifacts repository identity changed; review deletion again");
      await revokeForkTokens(source, source.artifacts_repository);
      await artifacts.deleteRepository(source.artifacts_namespace, source.artifacts_repository);
    },
    async withCheckout(source, submission, callback, resume = {}) {
      if (!/^review-[a-z0-9-]{1,45}$/.test(submission.review_branch || "") || !revision(submission.head_commit) || !/^[a-f0-9-]{36}$/.test(submission.id || "")) throw fail(400, "Invalid submission identity");
      return temporary(async cwd => {
        const head = await fetchRef(cwd, source, source.artifacts_repository, `refs/heads/${submission.review_branch}`, "refs/submission/main");
        if (head !== submission.head_commit) throw fail(409, "Submission changed before publish");
        const main = await fetchRef(cwd, source, source.artifacts_repository, "refs/heads/main", "refs/upstream/main");
        const message = `Publish TimDS submission ${submission.id}`;
        const resumed = (await git(cwd, ["log", "-1", "--format=%s", main])).text === message;
        const parentRevision = resumed ? (await git(cwd, ["rev-parse", `${main}^1`])).text : main;
        if (resume.parentRevision && resume.parentRevision !== parentRevision) throw fail(409, "Main changed while publication was pending");
        const priorFiles = await files(cwd, parentRevision);
        let committedHead = resumed ? main : "", mergeReceipt = { mergedKeys: [], conflictedKeys: [] }, autoRebased = false;
        if (resumed) {
          if ((await git(cwd, ["merge-base", "--is-ancestor", head, main], { allowFailure: true })).code || resume.sourceCommit && resume.sourceCommit !== main) throw fail(409, "Publication source no longer matches");
          await git(cwd, ["read-tree", main]);
        } else {
          const base = (await git(cwd, ["merge-base", main, head])).text;
          const merged = await mergeFiles(cwd, base, head, main);
          mergeReceipt = merged; autoRebased = base !== main;
          if (merged.conflicts.length) throw Object.assign(fail(409, "Update the session and resolve conflicting files before publishing"), { conflicts: merged.conflicts, mainRevision: main });
          await files(cwd, merged.tree);
          await git(cwd, ["read-tree", merged.tree]);
        }
        await git(cwd, ["checkout-index", "--all", "--force"]);
        // HEAD is needed by the trusted toolkit stamp implementation. No remote
        // or credential is written to this checkout. Builds receive a copy.
        await git(cwd, ["update-ref", "refs/heads/main", resumed ? main : head]);
        return callback({
          cwd, preparedFiles: await files(cwd, (await git(cwd, ["write-tree"])).text), parentRevision, priorFiles, resumed, autoRebased, mergedKeys: mergeReceipt.mergedKeys, conflictedKeys: mergeReceipt.conflictedKeys,
          sourceFiles: () => files(cwd, committedHead || head),
          async commitSource({ files: releaseFiles, message: _message }) {
            if (!committedHead) {
              const mergedTree = (await git(cwd, ["write-tree"])).text;
              const base = await commit(cwd, mergedTree, [main, head], message, resume.commitDate || submission.created_at);
              const desired = await changedTree(cwd, base, { baseRevision: base, changedFiles: releaseFiles, deletedPaths: [] });
              committedHead = await commit(cwd, desired, [main, head], message, resume.commitDate || submission.created_at);
              if (resume.sourceCommit && resume.sourceCommit !== committedHead) throw fail(409, "Publication source changed; retry the original release");
              await git(cwd, ["update-ref", "refs/heads/main", committedHead]);
            }
            return { headCommit: committedHead };
          },
          async pushMain() {
            if (!committedHead) throw fail(409, "Prepare the publication source first");
            if (!resumed) await push(cwd, source, source.artifacts_repository, committedHead, "main", parentRevision);
            return { headCommit: committedHead };
          },
          async pushPublished({ files: artifactFiles, stamp }) {
            if (!committedHead || stamp?.sourceCommit !== committedHead) throw fail(409, "Publication stamp does not match its source");
            await git(cwd, ["read-tree", "--empty"]);
            const seen = new Set(); let bytes = 0;
            for (const file of [...artifactFiles, { path: ".timds-artifact.json", content: Buffer.from(`${JSON.stringify(stamp, null, 2)}\n`) }]) {
              // Artifact paths may include dist; secrets and Git internals may not.
              const path = file.path;
              sessionFilePath(path.replace(/(^|\/)dist(?=\/)/g, "$1artifact-output"));
              if (seen.has(path)) throw fail(400, "Duplicate artifact path"); seen.add(path);
              const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, file.encoding || "utf8");
              bytes += content.length; if (bytes > 100 * 1024 * 1024 || seen.size > 10000) throw fail(413, "Publication artifact is too large");
              const oid = (await git(cwd, ["hash-object", "-w", "--stdin"], { input: content })).text;
              await git(cwd, ["update-index", "--add", "--cacheinfo", "100644", oid, path]);
            }
            const desired = (await git(cwd, ["write-tree"])).text;
            const prior = await currentRef(cwd, source, source.artifacts_repository, "timds-published");
            if (prior) {
              await fetchRef(cwd, source, source.artifacts_repository, "refs/heads/timds-published", "refs/published/main");
              if ((await git(cwd, ["rev-parse", `${prior}^{tree}`])).text === desired) return { headCommit: prior };
            }
            const published = await commit(cwd, desired, [], `TimDS ${stamp.version} ${stamp.contentDigest}`, resume.commitDate || submission.created_at);
            await push(cwd, source, source.artifacts_repository, published, "timds-published", prior);
            return { headCommit: published };
          },
        });
      });
    },
    async start(source, { sessionId, fromRepository = source.artifacts_repository, fromRevision = null }) {
      if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw fail(400, "Invalid session identity");
      const forkRepository = `session-${sessionId}`;
      // A DB reservation owns this UUID before the first external write.
      if (!await artifacts.getRepository(source.artifacts_namespace, forkRepository)) await artifacts.forkRepository(source.artifacts_namespace, forkRepository, { sourceRepository: fromRepository });
      // Fork returns a write token but no token ID. List/revoke its automatic
      // credential, including one left by a crash before this start checkpoint.
      await revokeForkTokens(source, forkRepository);
      return temporary(async cwd => {
        let baseRevision = await sessionTree(cwd, source, { fork_repository: forkRepository });
        if (fromRevision && fromRevision !== baseRevision) {
          const initial = await fetchRef(cwd, source, fromRepository, fromRevision, 'refs/origin/start');
          await push(cwd, source, forkRepository, initial, 'main', baseRevision); baseRevision = initial;
        }
        return { forkRepository, tokenId: null, expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(), baseRevision, files: await files(cwd, baseRevision) };
      });
    },
    async snapshot(source, session) { return temporary(async cwd => { const baseRevision = await sessionTree(cwd, source, session); return { baseRevision, files: await files(cwd, baseRevision) }; }); },
    async stale(source, session, changes) {
      return temporary(async cwd => {
        const head = await sessionTree(cwd, source, session);
        if ((await git(cwd, ['merge-base', '--is-ancestor', changes.baseRevision, head], { allowFailure: true })).code) throw fail(409, 'Session base is no longer available; pull before retrying');
        const desired = await changedTree(cwd, changes.baseRevision, changes);
        if (changes.resolvedPaths?.length && changes.mainRevision !== head) throw fail(409, 'Session changed since the conflict; pull before resolving');
        const merged = await mergeFiles(cwd, changes.baseRevision, desired, head, changes.resolvedPaths || []);
        return { baseRevision: head, mainRevision: head, files: await files(cwd, head), conflicts: merged.conflicts, mergedKeys: merged.mergedKeys, stale: true, ...(!merged.conflicts.length ? { rebasedChanges: await rebasedChangeSet(cwd, head, merged.tree, changes.note) } : {}) };
      });
    },
    async submit(source, session, changes, { submissionId, reviewBranch, targetRepository = source.artifacts_repository }) {
      if (!/^review-[a-z0-9-]{1,45}$/.test(reviewBranch) || !/^[a-f0-9-]{36}$/.test(submissionId)) throw fail(400, 'Invalid submission identity');
      return temporary(async cwd => {
        const head = await sessionTree(cwd, source, session), base = changes.baseRevision;
        if (!revision(base)) throw fail(400, 'Invalid base revision');
        if ((await git(cwd, ['merge-base', '--is-ancestor', base, head], { allowFailure: true })).code) throw fail(409, 'Session base changed; pull before submitting');
        const desired = await changedTree(cwd, base, changes);
        const currentTree = (await git(cwd, ['rev-parse', `${head}^{tree}`])).text;
        const message = `TimDS submission ${submissionId}`;
        if (head !== base && (await git(cwd, ['log', '-1', '--format=%s', head])).text !== message) {
          const stale = await mergeFiles(cwd, base, desired, head);
          return { baseRevision: head, mainRevision: head, files: await files(cwd, head), conflicts: stale.conflicts, stale: true, ...(!stale.conflicts.length ? { rebasedChanges: await rebasedChangeSet(cwd, head, stale.tree, changes.note) } : {}) };
        }
        const main = await fetchRef(cwd, source, targetRepository, 'refs/heads/main', 'refs/upstream/main');
        const common = (await git(cwd, ['merge-base', head, main])).text;
        if (changes.resolvedPaths?.length && changes.mainRevision !== main) throw fail(409, 'Main changed since the conflict; update again');
        const merged = await mergeFiles(cwd, common, head !== base ? head : desired, main, changes.resolvedPaths || []);
        if (merged.conflicts.length) return { baseRevision: head, mainRevision: main, files: await files(cwd, head), ...merged };
        const headCommit = currentTree === merged.tree ? head : await commit(cwd, merged.tree, [head, main], message);
        let manifest;
        try { manifest = JSON.parse((await git(cwd, ['show', `${headCommit}:timds.json`])).text); } catch { throw fail(400, 'A submission requires a valid timds.json manifest'); }
        const url = await previewUrl({ ...source, manifest_json: manifest }, reviewBranch);
        if (headCommit !== head) await push(cwd, source, session.fork_repository, headCommit, 'main', head);
        const prior = await currentRef(cwd, source, source.artifacts_repository, reviewBranch);
        if (prior && prior !== headCommit) throw fail(409, 'Submission changed; retry with a new submission');
        await ensurePreview(source);
        if (!prior) await push(cwd, source, source.artifacts_repository, headCommit, reviewBranch, '');
        const diff = (await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', main, headCommit])).text;
        return { baseRevision: headCommit, headCommit, files: await files(cwd, headCommit), diff, previewUrl: url, mergedKeys: merged.mergedKeys, conflictedKeys: merged.conflictedKeys };
      });
    },
    async update(source, session, changes, { targetRepository = source.artifacts_repository } = {}) {
      return temporary(async cwd => {
        const head = await sessionTree(cwd, source, session);
        const message = `TimDS update ${createHash('sha256').update(JSON.stringify(changes)).digest('hex')}`;
        if (head !== changes.baseRevision && (await git(cwd, ['log', '-1', '--format=%s', head])).text === message) return { baseRevision: head, files: await files(cwd, head), conflicts: [] };
        const desired = await changedTree(cwd, changes.baseRevision, changes);
        if (head !== changes.baseRevision) {
          if (changes.resolvedPaths?.length && changes.mainRevision !== head) throw fail(409, 'Session changed since the conflict; pull before resolving');
          const merged = await mergeFiles(cwd, changes.baseRevision, desired, head, changes.resolvedPaths || []);
          return { baseRevision: head, mainRevision: head, files: await files(cwd, head), conflicts: merged.conflicts, stale: true, ...(!merged.conflicts.length ? { rebasedChanges: await rebasedChangeSet(cwd, head, merged.tree, changes.note) } : {}) };
        }
        const main = await fetchRef(cwd, source, targetRepository, 'refs/heads/main', 'refs/upstream/main');
        const base = (await git(cwd, ['merge-base', head, main])).text;
        if (changes.resolvedPaths?.length && changes.mainRevision !== main) throw fail(409, 'Main changed since the conflict; update again before choosing a resolution');
        const merged = await mergeFiles(cwd, base, desired, main, changes.resolvedPaths || []);
        if (merged.conflicts.length) return { baseRevision: head, mainRevision: main, files: await files(cwd, head), ...merged };
        const updated = await commit(cwd, merged.tree, [head, main], message);
        await push(cwd, source, session.fork_repository, updated, 'main', head);
        return { baseRevision: updated, files: await files(cwd, updated), conflicts: [], mergedKeys: merged.mergedKeys, conflictedKeys: merged.conflictedKeys };
      });
    },
    async mergeIntoDraft(source, draft, submission) {
      return temporary(async cwd => {
        const head = await fetchRef(cwd, source, source.artifacts_repository, `refs/heads/${submission.review_branch}`, 'refs/submission/main');
        if (head !== submission.head_commit) throw fail(409, 'Submission changed before draft integration');
        const main = await sessionTree(cwd, source, draft);
        if (!(await git(cwd, ['merge-base', '--is-ancestor', head, main], { allowFailure: true })).code) return { headCommit: main, conflicts: [] };
        const base = (await git(cwd, ['merge-base', main, head])).text;
        const merged = await mergeFiles(cwd, base, head, main);
        if (merged.conflicts.length) return { ...merged, mainRevision: main };
        const headCommit = await commit(cwd, merged.tree, [main, head], `Integrate TimDS submission ${submission.id}`);
        await push(cwd, source, draft.fork_repository, headCommit, 'main', main);
        return { headCommit, conflicts: [], mergedKeys: merged.mergedKeys };
      });
    },
    async history(source, session) {
      // Cleanup removes the fork; the source log and persisted audit remain.
      const repo = ['closing', 'closed', 'expired'].includes(session.status) ? source.artifacts_repository : session.fork_repository;
      return { commits: await artifacts.log(source.artifacts_namespace, repo, { ref: "main", limit: 50 }) };
    },
    async close(source, session, { reviewBranches = [] } = {}) {
      for (const branch of reviewBranches) {
        if (!/^review-[a-z0-9-]{1,45}$/.test(branch)) throw fail(400, "Invalid review branch");
        await temporary(async cwd => { const prior = await currentRef(cwd, source, source.artifacts_repository, branch); if (prior) await push(cwd, source, source.artifacts_repository, "", branch, prior); });
        await deletePreview(source, branch);
      }
      if (session.token_id) await artifacts.revokeToken(source.artifacts_namespace, session.token_id);
      const fork = session.fork_repository || (/^[a-f0-9-]{36}$/.test(session.id || "") ? `session-${session.id}` : "");
      if (!fork.startsWith("session-") || fork === source.artifacts_repository) throw fail(409, "Session fork identity is unavailable");
      await revokeForkTokens(source, fork);
      await artifacts.deleteRepository(source.artifacts_namespace, fork);
    },
    async merge(source, session, submission) {
      return temporary(async cwd => {
        const head = await fetchRef(cwd, source, source.artifacts_repository, `refs/heads/${submission.review_branch}`, "refs/submission/main");
        if (head !== submission.head_commit) throw fail(409, "Submission changed before publish");
        const main = await fetchRef(cwd, source, source.artifacts_repository, "refs/heads/main", "refs/upstream/main");
        if (!(await git(cwd, ["merge-base", "--is-ancestor", head, main], { allowFailure: true })).code) return { headCommit: main };
        const base = (await git(cwd, ["merge-base", main, head])).text;
        const merged = await mergeFiles(cwd, base, head, main);
        if (merged.conflicts.length) throw Object.assign(fail(409, "Update the session and resolve conflicting files before publishing"), { conflicts: merged.conflicts, mainRevision: main });
        const headCommit = await commit(cwd, merged.tree, [main, head], `Publish TimDS submission ${submission.id}`);
        await push(cwd, source, source.artifacts_repository, headCommit, "main", main);
        return { headCommit };
      });
    },
  };
}
