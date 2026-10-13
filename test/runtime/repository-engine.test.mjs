import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { sessionFilePath } from "../../src/domain/paths.mjs";
import { createSandboxRepositoryEngine as createDesignSystemSessionRepository, parseGitBlobBatch } from "../../runtime/repository-engine.mjs";

const exec = promisify(execFile);
const g = async (cwd, ...args) => (await exec("git", ["-c", "user.name=TimDS", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
const file = (path, text, mode = "100644") => ({ path, encoding: "base64", content: Buffer.from(text).toString("base64"), mode });
const textOf = (snapshot, path) => Buffer.from(snapshot.files.find(f => f.path === path).content, "base64").toString();

test('bulk Git blob framing preserves arbitrary bytes and rejects malformed or incomplete output', () => {
  const oid = 'a'.repeat(40), empty = 'b'.repeat(40);
  const payload = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from(`${empty} blob 0\n\n`)]);
  const response = Buffer.concat([Buffer.from(`${oid} blob ${payload.length}\n`), payload, Buffer.from(`\n${empty} blob 0\n\n`)]);
  const expected = [{ oid, size: payload.length }, { oid: empty, size: 0 }];
  const parsed = parseGitBlobBatch(response, expected);
  assert.deepEqual(Buffer.from(parsed.get(oid).content, 'base64'), payload);
  assert.equal(parsed.get(empty).content, '');
  for (const malformed of [
    response.subarray(0, -1), Buffer.concat([response, Buffer.from('\n')]),
    Buffer.from(response.toString('latin1').replace(`${oid} blob`, `${empty} blob`), 'latin1'),
    Buffer.from(response.toString('latin1').replace(`${oid} blob`, `${oid} tree`), 'latin1'),
    Buffer.from(`${oid} missing\n`),
    Buffer.concat([Buffer.from(`${oid} blob ${payload.length}\n`), payload, Buffer.from(`X${empty} blob 0\n\n`)]),
  ]) assert.throws(() => parseGitBlobBatch(malformed, expected), /Invalid Git blob batch response/);
  assert.throws(() => parseGitBlobBatch(response, [{ oid, size: payload.length + 1 }]), /Invalid Git blob batch response/);
  assert.throws(() => parseGitBlobBatch(response, [{ oid, size: 10 * 1024 * 1024 + 1 }]), /Invalid Git blob batch response/);
});
test('history reads the source after cleanup removes the session fork', async () => {
  const calls = [];
  const repository = createDesignSystemSessionRepository({ artifacts: { log: async (namespace, repo) => { calls.push([namespace, repo]); return []; } } });
  const source = { artifacts_namespace: 'org', artifacts_repository: 'source' };
  for (const status of ['open', 'closing', 'closed', 'expired']) await repository.history(source, { status, fork_repository: 'session-fork' });
  assert.deepEqual(calls, [['org', 'session-fork'], ['org', 'source'], ['org', 'source'], ['org', 'source']]);
});

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "timds-git-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "source.git"), checkout = join(dir, "checkout");
  await g(dir, "init", "--bare", "--initial-branch=main", repo);
  await g(dir, "clone", repo, checkout);
  await writeFile(join(checkout, "tokens.json"), '{"color":"blue"}\n');
  await writeFile(join(checkout, "timds.json"), '{"systemId":"example"}\n');
  await writeFile(join(checkout, ".gitignore"), "dist/\nprivate.txt\n");
  await g(checkout, "add", "."); await g(checkout, "commit", "-m", "Initial"); await g(checkout, "push", "origin", "main");
  const repos = new Map([["source", repo]]), tokens = new Map(), previews = [], previewSources = [];
  const artifacts = {
    getRepository: async (_, name) => repos.has(name) ? { remote: repos.get(name) } : null,
    forkRepository: async (_, name, { sourceRepository }) => { const target = join(dir, name); await g(dir, "clone", "--bare", repos.get(sourceRepository), target); repos.set(name, target); tokens.set(randomUUID(), name); return { token: "automatic-fork-secret" }; },
    mintToken: async (_, name) => { const id = randomUUID(); tokens.set(id, name); return { id, token: "test-secret" }; },
    listTokens: async (_, name) => { if (!repos.has(name)) throw Object.assign(new Error("Repository not found"), { statusCode: 404 }); return [...tokens].filter(([, repo]) => repo === name).map(([id]) => ({ id })); },
    revokeToken: async (_, id) => { tokens.delete(id); },
    deleteRepository: async (_, name) => { if (repos.has(name)) await rm(repos.get(name), { recursive: true, force: true }); repos.delete(name); },
    log: async () => [],
  };
  const repository = createDesignSystemSessionRepository({ artifacts, previewUrl: (source, branch) => { previewSources.push(source); return `https://${branch}-test.example.workers.dev`; }, deletePreview: async (_, branch) => previews.push(branch), ...options });
  const source = { artifacts_namespace: "org", artifacts_repository: "source" };
  const started = await repository.start(source, { sessionId: randomUUID() });
  assert.equal(tokens.size, 0, "start revokes the automatic fork credential and temporary Git token");
  const session = { fork_repository: started.forkRepository, base_revision: started.baseRevision };
  return { repository, source, session, started, tokens, repos, repo, checkout, previews, previewSources, change: (snapshot, changedFiles = [], deletedPaths = []) => ({ baseRevision: snapshot.baseRevision, changedFiles, deletedPaths }) };
}

test('successful fork pushes notify immediately while notification failures, rejected Git pushes and unrelated writes remain isolated',async t=>{
 const events=[];let f;
 f=await fixture(t,{onForkPushed:async event=>{assert.equal(await g(f.repos.get(event.repository),'rev-parse','refs/heads/main'),event.headCommit,'notification follows the accepted remote write');events.push(event);throw Error('Notification unavailable');}});
 const changes=f.change(f.started,[file('tokens.json','{"color":"red"}\n')]);
 const updated=await f.repository.update(f.source,f.session,changes);assert.equal(events.length,1);assert.equal(events[0].headCommit,updated.baseRevision);
 await f.repository.update(f.source,f.session,changes);await f.repository.snapshot(f.source,f.session);assert.equal(events.length,1,'idempotent replay and reads do not notify');
 const submissionId=randomUUID(),reviewBranch='review-notification-proof';
 const submitted=await f.repository.submit(f.source,f.session,f.change(updated),{submissionId,reviewBranch});assert.equal(events.length,1,'review-only push does not notify');
 await f.repository.merge(f.source,f.session,{id:submissionId,head_commit:submitted.headCommit,review_branch:reviewBranch});assert.equal(events.length,1,'publication to source main does not notify');
 const hook=join(f.repos.get(f.session.fork_repository),'hooks','pre-receive');await writeFile(hook,'#!/bin/sh\nexit 1\n');await chmod(hook,0o755);
 await assert.rejects(f.repository.update(f.source,f.session,f.change(updated,[file('README.md','Rejected change')])));assert.equal(events.length,1,'rejected Git push never notifies');await rm(hook);
 await g(f.checkout,'pull','--ff-only','origin','main');await writeFile(join(f.checkout,'tokens.json'),'{"color":"green"}\n');await g(f.checkout,'add','.');await g(f.checkout,'commit','-m','Other author');await g(f.checkout,'push','origin','main');
 const conflict=await f.repository.update(f.source,f.session,f.change(updated,[file('tokens.json','{"color":"purple"}\n')]));assert.ok(conflict.conflicts.length);assert.equal(events.length,1,'merge conflicts do not notify');
});
test('trusted daemon emits only a bounded credential-free notification after an actual fork mutation',async t=>{
 const f=await fixture(t);process.env.TIMDS_REPOSITORY_TEST_IMPORT='1';const {dispatch}=await import('../../runtime/repository-daemon.mjs');delete process.env.TIMDS_REPOSITORY_TEST_IMPORT;
 const requests=[],prior=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://timds-repository.internal/fork-pushed');assert.equal(options.method,'POST');assert.deepEqual(options.headers,{'Content-Type':'application/json'});assert.equal(options.redirect,'error');assert.ok(Buffer.byteLength(options.body)<1024);const event=JSON.parse(options.body);assert.deepEqual(Object.keys(event).sort(),['headCommit','repository']);assert.equal(await g(f.repos.get(event.repository),'rev-parse','refs/heads/main'),event.headCommit);requests.push(event);return new Response('Queue fallback',{status:503});};
 try{
  const result=await dispatch({method:'update',source:f.source,args:[f.session,f.change(f.started,[file('tokens.json','{"color":"gold"}\n')])],repositories:[...f.repos].map(([repository,remote])=>({namespace:'org',repository,remote}))});
  assert.equal(requests.length,1);assert.equal(result.baseRevision,requests[0].headCommit);assert.equal(textOf(result,'tokens.json'),'{"color":"gold"}\n');
 }finally{globalThis.fetch=prior;}
});

async function traceGit(t, run) {
  const directory = await mkdtemp(join(tmpdir(), 'timds-git-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = join(directory, 'events.json'), previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try { await run(); }
  finally { if (previous === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previous; }
  return (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => event.event === 'start').map(event => event.argv);
}

test('a 41 MiB binary source submits with bounded Git processes and exact files and modes', async t => {
  const f = await fixture(t), expected = new Map();
  await mkdir(join(f.checkout, 'assets'));
  for (let index = 0; index < 41; index++) {
    const content = randomBytes(1024 * 1024), path = `assets/brand ${index}.bin`;
    await writeFile(join(f.checkout, path), content);
    expected.set(path, createHash('sha256').update(content).digest('hex'));
  }
  for (let index = 0; index < 300; index++) await writeFile(join(f.checkout, `assets/note-${index}.txt`), `Note ${index}\n`);
  await writeFile(join(f.checkout, 'empty'), '');
  await writeFile(join(f.checkout, 'executable'), '#!/bin/sh\nexit 0\n'); await chmod(join(f.checkout, 'executable'), 0o755);
  await symlink('assets/brand 0.bin', join(f.checkout, 'brand-link'));
  await g(f.checkout, 'add', '.'); await g(f.checkout, 'commit', '-m', 'Large binary source'); await g(f.checkout, 'push', 'origin', 'main');
  const started = await f.repository.start(f.source, { sessionId: randomUUID() });
  const session = { fork_repository: started.forkRepository, base_revision: started.baseRevision }, id = randomUUID();
  let submitted;
  const began = performance.now();
  const calls = await traceGit(t, async () => {
    submitted = await f.repository.submit(f.source, session, f.change(started, [file('tokens.json', '{"color":"green"}\n')]), { submissionId: id, reviewBranch: `review-${id.slice(0, 8)}` });
  });
  const elapsedMs = Math.round(performance.now() - began);
  for (const [path, digest] of expected) assert.equal(createHash('sha256').update(Buffer.from(submitted.files.find(file => file.path === path).content, 'base64')).digest('hex'), digest);
  assert.equal(submitted.files.find(file => file.path === 'executable').mode, '100755');
  assert.equal(submitted.files.find(file => file.path === 'brand-link').mode, '120000');
  assert.equal(textOf(submitted, 'brand-link'), 'assets/brand 0.bin');
  assert.equal(textOf(submitted, 'empty'), '');
  assert.equal(textOf(submitted, 'tokens.json'), '{"color":"green"}\n');
  assert.equal(calls.filter(args => args.includes('cat-file') && args.includes('blob')).length, 0);
  assert(calls.filter(args => args.includes('cat-file') && args.includes('--batch')).length <= 3, 'immutable blobs are reused across validation, merge and response');
  assert(calls.filter(args => args.includes('hash-object')).length <= 2, 'unchanged binary objects are reused');
  assert(calls.filter(args => args.includes('update-index')).length <= 3, 'merged index entries are written together');
  assert.equal(f.tokens.size, 0);
  t.diagnostic(`41 MiB / ${submitted.files.length} files submitted in ${elapsedMs}ms; ${calls.length} Git processes including transport internals`);
});

test('bulk reads enforce logical snapshot and per-file limits before reading blob bodies', async t => {
  const f = await fixture(t), asset = Buffer.alloc(10 * 1024 * 1024, 0xff);
  for (let index = 0; index < 6; index++) await writeFile(join(f.checkout, `same-${index}.bin`), asset);
  await g(f.checkout, 'add', '.'); await g(f.checkout, 'commit', '-m', 'Repeated oversized source'); await g(f.checkout, 'push', 'origin', 'main');
  let calls = await traceGit(t, () => assert.rejects(f.repository.readSource(f.source), error => error.statusCode === 413));
  assert.equal(calls.filter(args => args.includes('cat-file') && args.includes('--batch')).length, 0, 'six references to one 10 MiB blob still exceed 50 MiB');
  await g(f.checkout, 'rm', '--', ...Array.from({ length: 6 }, (_, index) => `same-${index}.bin`));
  await writeFile(join(f.checkout, 'too-large.bin'), Buffer.alloc(10 * 1024 * 1024 + 1, 0xff));
  await g(f.checkout, 'add', '.'); await g(f.checkout, 'commit', '-m', 'Oversized individual source'); await g(f.checkout, 'push', 'origin', 'main');
  calls = await traceGit(t, () => assert.rejects(f.repository.readSource(f.source), error => error.statusCode === 413));
  assert.equal(calls.filter(args => args.includes('cat-file') && args.includes('--batch')).length, 0);
  assert.equal(f.tokens.size, 0);
});

test('reusing a cached link blob still validates its new path before merging', async t => {
  const f = await fixture(t);
  await mkdir(join(f.checkout, 'nested')); await writeFile(join(f.checkout, 'target'), 'safe');
  await symlink('../target', join(f.checkout, 'nested/alias'));
  await g(f.checkout, 'add', '.'); await g(f.checkout, 'commit', '-m', 'Safe source link'); await g(f.checkout, 'push', 'origin', 'main');
  const started = await f.repository.start(f.source, { sessionId: randomUUID() });
  await symlink('../target', join(f.checkout, 'escaping-alias'));
  await g(f.checkout, 'add', '.'); await g(f.checkout, 'commit', '-m', 'Same blob at unsafe path'); await g(f.checkout, 'push', 'origin', 'main');
  const session = { fork_repository: started.forkRepository, base_revision: started.baseRevision };
  await assert.rejects(f.repository.update(f.source, session, f.change(started, [file('tokens.json', '{"color":"green"}\n')])), error => error.statusCode === 400 && /Source link leaves/.test(error.message));
  assert.equal((await f.repository.snapshot(f.source, session)).baseRevision, started.baseRevision);
  assert.equal(f.tokens.size, 0);
});

test("fork, submit/retry, merge and close keep source isolated and revoke every Git credential", async t => {
  const f = await fixture(t); const { repository: r, source: s, session } = f;
  const originalMain = await g(f.repo, "rev-parse", "main");
  const id = randomUUID(), options = { submissionId: id, reviewBranch: `review-${id.slice(0, 8)}` };
  const changes = f.change(f.started, [file("tokens.json", '{"color":"green"}\n')]);
  const submitted = await r.submit(s, session, changes, options);
  assert.equal(await g(f.repo, "rev-parse", "main"), originalMain);
  assert.match(submitted.diff, /-\{"color":"blue"\}/);
  assert.match(submitted.previewUrl, /review-/);
  assert.equal((await r.submit(s, session, changes, options)).headCommit, submitted.headCommit);
  const merged = await r.merge(s, session, { id, head_commit: submitted.headCommit, review_branch: options.reviewBranch });
  assert.equal(await g(f.repo, "rev-parse", "main"), merged.headCommit);
  assert.equal((await r.merge(s, session, { id, head_commit: submitted.headCommit, review_branch: options.reviewBranch })).headCommit, merged.headCommit);
  f.tokens.set("orphan-fork-token", session.fork_repository);
  await r.close(s, session, { reviewBranches: [options.reviewBranch] });
  await r.close(s, session, { reviewBranches: [options.reviewBranch] });
  assert.equal(f.repos.has(session.fork_repository), false);
  assert.equal(f.tokens.size, 0);
});

test("file-level update preserves independent edits and explicitly resolves concurrent JSON changes", async t => {
  const f = await fixture(t); const { repository: r, source: s, session } = f;
  await writeFile(join(f.checkout, "tokens.json"), '{"color":"red"}\n');
  await writeFile(join(f.checkout, "new.txt"), "upstream");
  await g(f.checkout, "add", "."); await g(f.checkout, "commit", "-m", "Other designer"); await g(f.checkout, "push", "origin", "main");
  const changes = f.change(f.started, [file("tokens.json", '{"color":"green"}\n'), file("local.txt", "local")]);
  const conflict = await r.update(s, session, changes);
  assert.deepEqual(conflict.conflicts.map(item => item.path), ["tokens.json"]);
  assert.equal(conflict.baseRevision, f.started.baseRevision);
  const updated = await r.update(s, session, { ...changes, resolvedPaths: ["tokens.json"], mainRevision: conflict.mainRevision });
  assert.deepEqual(updated.conflicts, []);
  assert.equal(textOf(updated, "tokens.json"), '{"color":"green"}\n');
  assert.equal(textOf(updated, "new.txt"), "upstream");
  assert.equal(textOf(updated, "local.txt"), "local");
  const id = randomUUID();
  const submitted = await r.submit(s, session, f.change(updated), { submissionId: id, reviewBranch: `review-${id.slice(0, 8)}` });
  assert.equal(submitted.headCommit, updated.baseRevision);
  assert.equal(f.tokens.size, 0);
});

test("Preview URL uses the submitted manifest entry instead of the published source entry", async t => {
  const f = await fixture(t), id = randomUUID();
  const manifest = { systemId:'example', artifact:{ entry:'design-system/index.html' } };
  await f.repository.submit({ ...f.source, manifest_json:{ artifact:{ entry:'index.html' } } }, f.session, f.change(f.started, [file('timds.json', JSON.stringify(manifest))]), { submissionId:id, reviewBranch:`review-${id.slice(0, 8)}` });
  assert.deepEqual(f.previewSources.at(-1).manifest_json, manifest);
});

test("a baseline above 10 MiB supports small edits while changes remain bounded to 10 MiB", async t => {
  const f = await fixture(t), asset = Buffer.alloc(6 * 1024 * 1024, 'a');
  await writeFile(join(f.checkout, 'brand-one.bin'), asset);
  await writeFile(join(f.checkout, 'brand-two.bin'), asset);
  await g(f.checkout, 'add', '.'); await g(f.checkout, 'commit', '-m', 'Existing brand assets'); await g(f.checkout, 'push', 'origin', 'main');
  const started = await f.repository.start(f.source, { sessionId:randomUUID() });
  assert(started.files.reduce((sum, file) => sum + Buffer.from(file.content, 'base64').length, 0) > 10 * 1024 * 1024);
  const session = { fork_repository:started.forkRepository, base_revision:started.baseRevision };
  const id = randomUUID();
  const submitted = await f.repository.submit(f.source, session, f.change(started, [file('tokens.json', '{"color":"green"}\n')]), { submissionId:id, reviewBranch:`review-${id.slice(0, 8)}` });
  assert.equal(textOf(submitted, 'tokens.json'), '{"color":"green"}\n');
  const nextId = randomUUID();
  await assert.rejects(f.repository.submit(f.source, session, f.change(submitted, [file('brand-one.bin', Buffer.alloc(asset.length, 'b')), file('brand-two.bin', Buffer.alloc(asset.length, 'b'))]), { submissionId:nextId, reviewBranch:`review-${nextId.slice(0, 8)}` }), /Change set exceeds 10 MiB/);
});

test("rejects ignored/private/escaping writes before changing the fork", async t => {
  const f = await fixture(t); const { repository: r, source: s, session } = f;
  const id = randomUUID(), options = { submissionId: id, reviewBranch: `review-${id.slice(0, 8)}` };
  for (const entry of [file("private.txt", "secret"), file("dist/index.html", "built"), file("escape", "../../outside", "120000"), file(".git/config", "unsafe"), file(".env", "unsafe")]) {
    await assert.rejects(r.submit(s, session, f.change(f.started, [entry]), options), error => error.statusCode === 400);
  }
  assert.equal((await r.snapshot(s, session)).baseRevision, f.started.baseRevision);
  assert.equal(f.tokens.size, 0);
  for (const path of ["../outside", "A/.GIT/config", "a\\b", ".timds/session.json"]) assert.throws(() => sessionFilePath(path));
});

test("two sessions cannot overwrite main and stale conflict resolutions fail", async t => {
  const f = await fixture(t); const r = f.repository, s = f.source;
  const other = await r.start(s, { sessionId: randomUUID() });
  const sessions = [f.session, { fork_repository: other.forkRepository, base_revision: other.baseRevision }];
  const submissions = [];
  for (const [i, session] of sessions.entries()) {
    const id = randomUUID(), reviewBranch = `review-${id.slice(0, 8)}`;
    const result = await r.submit(s, session, { baseRevision: session.base_revision, changedFiles: [file("tokens.json", JSON.stringify({ color: i }))], deletedPaths: [] }, { submissionId: id, reviewBranch });
    submissions.push({ id, review_branch: reviewBranch, head_commit: result.headCommit });
  }
  await r.merge(s, sessions[0], submissions[0]);
  await assert.rejects(r.merge(s, sessions[1], submissions[1]), error => error.statusCode === 409 && error.conflicts.some(item => item.path === "tokens.json"));
  await assert.rejects(r.update(s, sessions[1], { baseRevision: submissions[1].head_commit, changedFiles: [], deletedPaths: [], resolvedPaths: ["tokens.json"], mainRevision: f.started.baseRevision }), error => error.statusCode === 409);
});

test("update retry after a remote commit returns the same revision", async t => {
  const f = await fixture(t);
  const changes = f.change(f.started, [file("tokens.json", '{"color":"green"}\n')]);
  const first = await f.repository.update(f.source, f.session, changes);
  const retry = await f.repository.update(f.source, f.session, changes);
  assert.equal(retry.baseRevision, first.baseRevision);
  assert.equal(textOf(retry, "tokens.json"), '{"color":"green"}\n');
  assert.equal((await f.repository.snapshot(f.source, f.session)).baseRevision, first.baseRevision);
  assert.equal(f.tokens.size, 0);
});

test("tracked files remain editable when ignored while new ignored paths are rejected", async t => {
  const f = await fixture(t);
  await writeFile(join(f.checkout, "private.txt"), "tracked\n");
  await g(f.checkout, "add", "--force", "private.txt"); await g(f.checkout, "commit", "-m", "Track an intentionally ignored file"); await g(f.checkout, "push", "origin", "main");
  const started = await f.repository.start(f.source, { sessionId: randomUUID() });
  const session = { fork_repository: started.forkRepository, base_revision: started.baseRevision };
  const id = randomUUID(), options = { submissionId: id, reviewBranch: `review-${id.slice(0, 8)}` };
  const submitted = await f.repository.submit(f.source, session, f.change(started, [file("private.txt", "updated\n")]), options);
  assert.equal(textOf(submitted, "private.txt"), "updated\n");
  const next = randomUUID();
  await assert.rejects(f.repository.submit(f.source, session, f.change(submitted, [file(".gitignore", "private.txt\nnew.ignore\n"), file("new.ignore", "ignored")]), { submissionId: next, reviewBranch: `review-${next.slice(0, 8)}` }), error => error.statusCode === 400);
  assert.equal((await f.repository.snapshot(f.source, session)).baseRevision, submitted.baseRevision);
});

test("links retain scaffold aliases and reject cycles and chained parent traversal", async t => {
  const f = await fixture(t);
  const id = randomUUID(), options = { submissionId: id, reviewBranch: `review-${id.slice(0, 8)}` };
  const submitted = await f.repository.submit(f.source, f.session, f.change(f.started, [file(".agents/skills/edit/SKILL.md", "skill"), file(".claude/skills", "../.agents/skills", "120000"), file("skill-alias", ".claude/skills/edit", "120000")]), options);
  assert.equal(submitted.files.find(file => file.path === ".claude/skills").mode, "120000");
  for (const entries of [
    [file("a", "b", "120000"), file("b", "a", "120000")],
    [file("a", "deep/b/../../outside", "120000"), file("deep/b", "../d", "120000"), file("d/info", "inside")],
    [file(".timds", "inside", "120000")],
  ]) {
    const next = randomUUID();
    await assert.rejects(f.repository.submit(f.source, f.session, f.change(submitted, entries), { submissionId: next, reviewBranch: `review-${next.slice(0, 8)}` }), error => error.statusCode === 400);
  }
  await symlink("cycle-b", join(f.checkout, "cycle-a")); await symlink("cycle-a", join(f.checkout, "cycle-b"));
  await g(f.checkout, "add", "."); await g(f.checkout, "commit", "-m", "Invalid source links"); await g(f.checkout, "push", "origin", "main");
  await assert.rejects(f.repository.start(f.source, { sessionId: randomUUID() }), error => error.statusCode === 400);
  assert.equal(f.tokens.size, 0);
});

test("file/directory transitions require explicit deletions and preserve large file bytes", async t => {
  const f = await fixture(t);
  const submit = async (base, changedFiles, deletedPaths = []) => {
    const id = randomUUID();
    return f.repository.submit(f.source, f.session, f.change(base, changedFiles, deletedPaths), { submissionId: id, reviewBranch: `review-${id.slice(0, 8)}` });
  };
  const first = await submit(f.started, [file("folder/child", "nested"), file("large.txt", "x".repeat(1024 * 1024))]);
  await assert.rejects(submit(first, [file("folder", "flat")]), error => error.statusCode === 400);
  const second = await submit(first, [file("folder", "flat")], ["folder/child"]);
  assert.equal(textOf(second, "folder"), "flat");
  const third = await submit(second, [file("folder/new", "nested again")], ["folder"]);
  assert.equal(textOf(third, "folder/new"), "nested again");
  assert.equal(textOf(third, "large.txt").length, 1024 * 1024);
});

test('publication merges and versions locally, pushes atomically, and resumes the same source and artifact', async t => {
  const f = await fixture(t), id = randomUUID(), reviewBranch = `review-${id.slice(0, 8)}`;
  const submitted = await f.repository.submit(f.source, f.session, f.change(f.started, [file('tokens.json', '{"color":"purple"}\n')]), { submissionId: id, reviewBranch });
  const submission = { id, head_commit: submitted.headCommit, review_branch: reviewBranch, created_at: '2026-10-12T00:00:00Z' };
  let headCommit;
  const artifact = [{ path: 'index.html', content: Buffer.from('built viewer') }, { path: 'bundle/theme.css', content: Buffer.from([0, 255, 13, 10]) }];
  await f.repository.withCheckout(f.source, submission, async checkout => {
    assert.equal(checkout.resumed, false);
    assert.equal(await g(f.repo, 'rev-parse', 'main'), f.started.baseRevision);
    assert.equal(textOf({ files: checkout.priorFiles }, 'tokens.json'), '{"color":"blue"}\n');
    ({ headCommit } = await checkout.commitSource({ files: [file('timds.json', '{"systemId":"example","version":"1.0.1"}\n')] }));
    assert.equal(await g(checkout.cwd, 'status', '--porcelain'), '');
    assert.equal(textOf({ files: await checkout.sourceFiles() }, 'timds.json'), '{"systemId":"example","version":"1.0.1"}\n');
    assert.equal(textOf({ files: await checkout.sourceFiles() }, 'tokens.json'), '{"color":"purple"}\n');
    assert.equal(f.tokens.size, 0);
    await checkout.pushMain();
    await checkout.pushPublished({ files: artifact, stamp: { schemaVersion: 1, sourceCommit: headCommit, systemId: 'example', version: '1.0.1', contentDigest: 'a'.repeat(64) } });
  });
  assert.equal(await g(f.repo, 'rev-parse', 'main'), headCommit);
  const published = await g(f.repo, 'rev-parse', 'timds-published');
  assert.equal(JSON.parse(await g(f.repo, 'show', 'timds-published:.timds-artifact.json')).sourceCommit, headCommit);
  await f.repository.withCheckout(f.source, submission, async checkout => {
    assert.equal(checkout.resumed, true);
    assert.equal((await checkout.commitSource({ files: [] })).headCommit, headCommit);
    await checkout.pushMain();
    await checkout.pushPublished({ files: artifact, stamp: { schemaVersion: 1, sourceCommit: headCommit, systemId: 'example', version: '1.0.1', contentDigest: 'a'.repeat(64) } });
  }, { sourceCommit: headCommit, parentRevision: f.started.baseRevision });
  assert.equal(await g(f.repo, 'rev-parse', 'timds-published'), published);
  assert.equal(f.tokens.size, 0);
});

test('provisioning and source deletion preserve remote identity', async t => {
  const f = await fixture(t), operationId = randomUUID();
  const emptyRepo = join(f.checkout, '..', 'new.git');
  await g(f.checkout, 'init', '--bare', '--initial-branch=main', emptyRepo);
  f.repos.set('new', emptyRepo);
  const source = { ...f.source, artifacts_repository: 'new' };
  f.tokens.set('auto-create-token', 'new');
  const first = await f.repository.provisionFiles(source, { operationId, files: [file('timds.json', '{"systemId":"new"}\n')] });
  assert.equal(f.tokens.size, 0);
  assert.equal((await f.repository.provisionFiles(source, { operationId, files: [] })).headCommit, first.headCommit);
  assert.equal((await f.repository.readSource(source)).baseRevision, first.headCommit);
  await assert.rejects(f.repository.provisionFiles(source, { operationId: randomUUID(), files: [] }), error => error.statusCode === 409);
  await assert.rejects(f.repository.removeSource(source), error => error.statusCode === 409);
  assert.equal(f.repos.has('new'), true);
});

test('ten concurrent sessions merge independent contract keys; same key gives exact values and resolutions', async t => {
  const f = await fixture(t), r = f.repository, s = f.source;
  const original = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`key${index}`, { value: index }]));
  await mkdir(join(f.checkout, 'tokens'));
  await writeFile(join(f.checkout, 'tokens/color.brand.json'), JSON.stringify(original));
  await g(f.checkout, 'add', '.'); await g(f.checkout, 'commit', '-m', 'Grouped contract'); await g(f.checkout, 'push', 'origin', 'main');
  const work = [];
  for (let index = 0; index < 10; index++) {
    const started = await r.start(s, { sessionId: randomUUID() }), id = randomUUID();
    const session = { fork_repository: started.forkRepository, base_revision: started.baseRevision };
    const result = await r.submit(s, session, { baseRevision: started.baseRevision, changedFiles: [file('tokens/color.brand.json', JSON.stringify({ ...original, [`key${index}`]: { value: index + 100 } }))], deletedPaths: [] }, { submissionId: id, reviewBranch: `review-${id.slice(0,8)}` });
    assert.equal(result.conflicts?.length || 0, 0);
    work.push({ session, submission: { id, head_commit: result.headCommit, review_branch: `review-${id.slice(0,8)}` } });
  }
  for (const { session, submission } of work) await r.merge(s, session, submission);
  const final = JSON.parse(await g(f.repo, 'show', 'main:tokens/color.brand.json'));
  for (let index = 0; index < 10; index++) assert.equal(final[`key${index}`].value, index + 100);
  const one = await r.start(s, { sessionId: randomUUID() }), two = await r.start(s, { sessionId: randomUUID() });
  const submit = async (started, value) => { const id = randomUUID(); const result = await r.submit(s, { fork_repository: started.forkRepository }, { baseRevision: started.baseRevision, changedFiles: [file('tokens/color.brand.json', JSON.stringify({ ...final, key0: { value } }))], deletedPaths: [] }, { submissionId:id,reviewBranch:`review-${id.slice(0,8)}` }); return { id,head_commit:result.headCommit,review_branch:`review-${id.slice(0,8)}` }; };
  const submission = await submit(one, 200); await r.merge(s, { fork_repository: one.forkRepository }, submission);
  const changes = { baseRevision: two.baseRevision, changedFiles: [file('tokens/color.brand.json', JSON.stringify({ ...final, key0: { value: 300 } }))], deletedPaths: [] };
  const conflict = await r.update(s, { fork_repository: two.forkRepository }, changes);
  assert.deepEqual(conflict.conflicts, [{ path:'tokens/color.brand.json',key:'key0.value',base:100,mine:300,theirs:200 }]);
  const resolved = await r.update(s, { fork_repository: two.forkRepository }, { ...changes, mainRevision:conflict.mainRevision,resolvedPaths:['tokens/color.brand.json#key0.value=theirs'] });
  assert.equal(JSON.parse(textOf(resolved, 'tokens/color.brand.json')).key0.value, 200);
  const stale = await r.update(s, { fork_repository: two.forkRepository }, changes);
  assert.equal(stale.stale, true); assert.equal(stale.baseRevision, resolved.baseRevision);
  assert.equal(f.tokens.size, 0);
});

test('contract merge covers key deletion, arrays, manifest metadata and explicit resolutions', async () => {
  const { mergeContractValues } = await import('@dtconcepts/timds/merge');
  const base = { one:1,two:2 }, mine = { one:1 }, theirs = { one:3,two:2 };
  assert.deepEqual(JSON.parse(JSON.stringify(mergeContractValues('tokens/core.json',base,mine,theirs).value)),{one:3});
  const conflict = mergeContractValues('media/assets.json',{logo:['old']},{logo:['mine']},{logo:['theirs']});
  assert.deepEqual(conflict.conflicts,[{path:'media/assets.json',key:'logo',base:['old'],mine:['mine'],theirs:['theirs']}]);
  assert.equal(mergeContractValues('media/assets.json',{logo:['old']},{logo:['mine']},{logo:['theirs']},['media/assets.json#logo=theirs']).value.logo[0],'theirs');
  const manifest = mergeContractValues('timds.json',{artifact:{entry:'old',path:'dist'}},{artifact:{entry:'new',path:'dist'}},{artifact:{entry:'old',path:'bundle'}});
  assert.equal(manifest.conflicts[0].key,'artifact','unselected manifest keys remain atomic');
});

test('draft fork receives three child submissions without changing main, then publishes combined head', async t => {
  const f = await fixture(t), r = f.repository, s = f.source;
  const draft = await r.start(s, {sessionId:randomUUID()}), sourceHead = (await r.readSource(s)).baseRevision;
  const children = await Promise.all(Array.from({length:3},()=>r.start(s,{sessionId:randomUUID(),fromRepository:draft.forkRepository})));
  for (const [index,started] of children.entries()) {
    const id = randomUUID(), reviewBranch = `review-${id.slice(0,8)}`;
    const result = await r.submit(s,{fork_repository:started.forkRepository},{baseRevision:started.baseRevision,changedFiles:[file('tokens/color.brand.json',JSON.stringify({[`key${index}`]:{value:index}}))],deletedPaths:[]},{submissionId:id,reviewBranch,targetRepository:draft.forkRepository});
    assert.equal(result.conflicts?.length || 0,0);
    const integrated = await r.mergeIntoDraft(s,{fork_repository:draft.forkRepository},{id,head_commit:result.headCommit,review_branch:reviewBranch});
    assert.equal(integrated.conflicts.length,0);
  }
  assert.equal((await r.readSource(s)).baseRevision,sourceHead);
  const snapshot = await r.snapshot(s,{fork_repository:draft.forkRepository});
  assert.deepEqual(Object.keys(JSON.parse(textOf(snapshot,'tokens/color.brand.json'))).sort(),['key0','key1','key2']);
  const id = randomUUID(), reviewBranch = `review-${id.slice(0,8)}`;
  const submitted = await r.submit(s,{fork_repository:draft.forkRepository},{baseRevision:snapshot.baseRevision,changedFiles:[],deletedPaths:[]},{submissionId:id,reviewBranch});
  await r.merge(s,{fork_repository:draft.forkRepository},{id,head_commit:submitted.headCommit,review_branch:reviewBranch});
  assert.deepEqual(JSON.parse(await g(f.repo,'show','main:tokens/color.brand.json')),JSON.parse(textOf(snapshot,'tokens/color.brand.json')));
});

test('repository daemon publication RPC survives release and reconstructs deterministic source before both pushes',async t=>{
 const f=await fixture(t),id=randomUUID(),reviewBranch=`review-${id.slice(0,8)}`;
 const submitted=await f.repository.submit(f.source,f.session,f.change(f.started,[file('tokens.json','{"color":"purple"}\n')]),{submissionId:id,reviewBranch});
 const submission={id,review_branch:reviewBranch,head_commit:submitted.headCommit,created_at:'2026-10-13T00:00:00.000Z'};
 process.env.TIMDS_REPOSITORY_TEST_IMPORT='1';const {dispatch}=await import('../../runtime/repository-daemon.mjs');delete process.env.TIMDS_REPOSITORY_TEST_IMPORT;
 const invoke=(method,...args)=>dispatch({method,source:f.source,args,repositories:[{namespace:'org',repository:'source',remote:f.repo}]});
 t.after(()=>invoke('releaseCheckout'));
 const prepared=await invoke('preparePublication',submission),files=[file('tokens.json','{"color":"purple","version":"1"}\n')];
 assert.equal(JSON.parse(textOf(prepared,'tokens.json')).color,'purple');assert.equal('cwd'in prepared,false);
 const first=await invoke('commitSource',{files});await invoke('releaseCheckout');
 const resume=await invoke('preparePublication',submission,{parentRevision:prepared.parentRevision,sourceCommit:first.headCommit,commitDate:submission.created_at});
 const second=await invoke('commitSource',{files});assert.equal(second.headCommit,first.headCommit);assert.equal(resume.resumed,false);
 assert.equal((await invoke('pushMain')).headCommit,first.headCommit);
 await invoke('stagePublished',{reset:true,files:[file('index.html','<h1>Published</h1>')]});
 const stamp={sourceCommit:first.headCommit,version:'0.1.0',contentDigest:'test'};const published=await invoke('pushPublished',{stamp});
 assert.equal(await g(f.repo,'rev-parse','main'),first.headCommit);assert.equal(await g(f.repo,'rev-parse','timds-published'),published.headCommit);assert.equal(await g(f.repo,'show','timds-published:index.html'),'<h1>Published</h1>');
 await invoke('releaseCheckout');const resumed=await invoke('preparePublication',submission,{parentRevision:prepared.parentRevision,sourceCommit:first.headCommit});assert.equal(resumed.resumed,true);assert.equal((await invoke('commitSource',{files})).headCommit,first.headCommit);
});
