#!/usr/bin/env node
// Operational migration tool. Default is read-only inventory; no database writes.
import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {Readable, Transform} from 'node:stream';
import {parseArgs} from 'node:util';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, detail = {}) => { throw Object.assign(new Error(code), {safe: {code, ...detail}}); };
const assert = (ok, code, detail) => { if (!ok) fail(code, detail); };
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\\\x00-\x1f\x7f%?#]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || '');
const hex = value => /^[a-f0-9]{64}$/.test(value || '');
const reserved = new Set(['.timds-artifact.json', '.timds-release.json']);
const log = value => process.stdout.write(JSON.stringify(value) + '\n');
const exists = async file => fs.lstat(file).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e));
async function save(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await fs.rename(temp, file);
}
async function mapBounded(items, fn, concurrency = 8) {
  const results = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await fn(items[index]); }
  }));
  return results;
}
async function hashStream(stream, maxBytes = Infinity) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of stream) { hash.update(chunk); size += chunk.length; assert(size <= maxBytes, 'body_exceeds_limit'); }
  return {size, sha256: hash.digest('hex')};
}
async function hashFile(file) {
  const before = await fs.lstat(file);
  assert(before.isFile(), 'non_regular_file');
  const digest = await hashStream(createReadStream(file));
  const after = await fs.lstat(file);
  assert(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && digest.size === after.size, 'local_file_changed');
  return digest;
}
async function walk(root, relative = '') {
  const result = [];
  for (const entry of (await fs.readdir(path.join(root, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    assert(safePath(name), 'unsafe_artifact_path');
    if (entry.isDirectory()) result.push(...await walk(root, name));
    else { assert(entry.isFile(), 'non_regular_artifact', {path: name}); if (!reserved.has(name)) result.push({path: name, mode: '100644', ...await hashFile(path.join(root, name))}); }
  }
  return result;
}
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.pdf':'application/pdf','.xml':'application/xml','.webmanifest':'application/manifest+json'};
const mime = name => types[path.extname(name).toLowerCase()] || 'application/octet-stream';
// Portal bundle fallbacks use their actual R2 ContentType; only absent metadata
// falls back to the legacy public handler's exact extension table.
const legacyTypes={...types,'.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8','.avif':'image/avif','.mp4':'video/mp4','.webm':'video/webm','.otf':'application/octet-stream','.xml':'application/octet-stream','.webmanifest':'application/octet-stream'};
const legacyMime=name=>legacyTypes[path.extname(name).toLowerCase()]||'application/octet-stream';
function bindings(system) {
  assert(system.source?.id === system.expectedSourceId && system.source.system_id === system.expectedSystemId && uuid(system.source.id) && safePath(system.source.system_id), 'source_identity_mismatch', {system: system.key});
  const versions = new Map(system.versions.map(v => [v.id, v]));
  const first = new Map();
  for (const event of [...system.publicationEvents].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    if (first.has(event.version_label)) continue;
    const version = versions.get(event.design_system_version_id);
    assert(event.design_system_source_id === system.source.id && version?.design_system_source_id === system.source.id && version.version_label === event.version_label && version.content_digest === event.content_digest, 'event_binding_mismatch', {system: system.key, eventId: event.id});
    first.set(event.version_label, {version: event.version_label, contentDigest: event.content_digest, sourceCommit: version.source_commit, eventId: event.id, versionId: version.id});
  }
  assert(first.size === system.firstLabelBindings.length, 'first_binding_count_changed');
  for (const row of system.firstLabelBindings) {
    const item = first.get(row.version_label);
    assert(item?.eventId === row.id && item.versionId === row.design_system_version_id && item.contentDigest === row.content_digest && item.sourceCommit === row.source_commit, 'first_binding_changed');
  }
  const current = {version: system.source.published_version, contentDigest: system.source.content_digest, sourceCommit: system.source.source_commit};
  assert(current.version && hex(current.contentDigest), 'current_binding_missing');
  const pinned = first.get(current.version);
  assert(!pinned || pinned.contentDigest === current.contentDigest && pinned.sourceCommit === current.sourceCommit, 'current_and_pinned_label_collision', {system: system.key, version: current.version});
  if (!pinned) first.set(current.version, {...current, eventId: null, versionId: null});
  return [...first.values()].sort((a, b) => a.version.localeCompare(b.version, 'en')).map(item => {
    assert(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(item.version) && hex(item.contentDigest) && /^[a-f0-9]{40,64}$/.test(item.sourceCommit || ''), 'invalid_release_identity');
    return item;
  });
}
function config(prefix, bucket) {
  assert(/^[A-Z][A-Z0-9_]*$/.test(prefix) && /^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket), 'invalid_r2_config');
  const read = key => process.env[`${prefix}_${key}`];
  const endpoint = read('ENDPOINT') || (read('ACCOUNT_ID') && `https://${read('ACCOUNT_ID')}.r2.cloudflarestorage.com`);
  let url; try { url = new URL(endpoint); } catch { fail('missing_r2_endpoint', {prefix}); }
  assert(url.protocol === 'https:' && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'invalid_r2_endpoint', {prefix});
  assert((read('ACCESS_KEY_ID') || read('ACCESS_KEY')) && read('SECRET_ACCESS_KEY'), 'missing_r2_credentials', {prefix});
  return {endpoint: url.origin, bucket, credentials: {accessKeyId: read('ACCESS_KEY_ID') || read('ACCESS_KEY'), secretAccessKey: read('SECRET_ACCESS_KEY')}};
}
function storage(sdk, conf) {
  const client = new sdk.S3Client({region: 'auto', endpoint: conf.endpoint, credentials: conf.credentials, maxAttempts: 3});
  const call = (name, args) => client.send(new sdk[name]({Bucket: conf.bucket, ...args}), {abortSignal: AbortSignal.timeout(120_000)});
  const cache = new Map();
  async function get(key, collect = false, fresh = false) {
    if (!fresh && !collect && cache.has(key)) return cache.get(key);
    let object; try { object = await call('GetObjectCommand', {Key: key}); } catch (e) { if (e.$metadata?.httpStatusCode === 404) { cache.set(key, null); return null; } throw e; }
    let result;
    if (collect) { assert(object.ContentLength <= 2 * 1024 * 1024, 'metadata_object_too_large', {key}); const bytes = Buffer.from(await object.Body.transformToByteArray()); result = {size: bytes.length, sha256: sha(bytes), bytes}; }
    else result = await hashStream(object.Body);
    result.metadataSha256 = object.Metadata?.sha256 || null;
    result.contentType = object.ContentType || null;
    cache.set(key, result); return result;
  }
  async function list(prefix) {
    const result = new Map(); let token;
    do { const page = await call('ListObjectsV2Command', {Prefix: prefix, ContinuationToken: token}); for (const item of page.Contents || []) result.set(item.Key, item.Size); token = page.IsTruncated ? page.NextContinuationToken : null; assert(!page.IsTruncated || token, 'truncated_r2_listing'); } while (token);
    return result;
  }
  return {conf, get, list, call};
}
async function verifyPublic(baseline, systems) {
  const allowed = new Set(systems.map(s => s.key));
  const receipts = [];
  for (const observed of baseline.publicReadBaseline.results) {
    const system = baseline.systems.find(s => s.key === observed.system);
    if (!system || system.source && (!allowed.has(system.key) || !observed.stamp)) continue;
    if (!system.source) assert(observed.status === 404, 'deleted_baseline_not_404');
    const url = new URL(observed.url);
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'unsafe_public_probe_url');
    const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(30_000)});
    assert(response.status === (system.source ? 200 : 404), 'public_status_changed', {system: system.key, status: response.status});
    const body = Buffer.from(await response.arrayBuffer()); assert(body.length <= 32_768, 'public_stamp_too_large');
    if (system.source) {
      let stamp; try { stamp = JSON.parse(body); } catch { fail('public_stamp_invalid', {system: system.key}); }
      for (const key of ['schemaVersion','systemId','version','sourceCommit','contentDigest']) assert(stamp[key] === observed.stamp[key], 'public_binding_changed', {system: system.key, field: key});
    } else assert(sha(body) === observed.sha256, 'deleted_public_body_changed', {system: system.key});
    receipts.push({url: observed.url, status: response.status, sha256: sha(body)});
  }
  for (const system of systems) assert(receipts.some(item => baseline.publicReadBaseline.results.some(o => o.url === item.url && o.system === system.key && o.kind === 'current-stamp')), 'current_public_stamp_probe_missing', {system: system.key});
  return receipts;
}
async function verifyDeleted(baseline, root, source, target, mode) {
  const receipts = [];
  for (const system of baseline.systems.filter(s => !s.source)) {
    assert(uuid(system.expectedSourceId) && safePath(system.expectedSystemId), 'invalid_deleted_identity');
    assert(!system.versions.length && !system.publicationEvents.length && system.local.deletedMarker && !await exists(path.join(root, system.expectedSourceId)) && await exists(path.join(root, '.deleted-sources', system.expectedSourceId)), 'deleted_source_changed', {system: system.key});
    const prefix = `${system.expectedSystemId}/artifact/`;
    assert((await source.list(prefix)).size === 0, 'deleted_source_r2_changed', {system: system.key});
    assert((await target.list(mode === 'legacy' ? prefix : `sources/${system.expectedSourceId}/`)).size === 0, 'deleted_target_r2_present', {system: system.key});
    receipts.push({system: system.key, sourceId: system.expectedSourceId, localMissing: true, deletionMarker: true, sourceObjects: 0, targetObjects: 0});
  }
  return receipts;
}
async function proveServedBundle(baseline, system, binding, file) {
  const pinnedStamp = baseline.publicReadBaseline.results.find(row => row.system === system.key && row.kind === 'first-label-stamp' && row.stamp?.version === binding.version);
  assert(pinnedStamp?.stamp?.contentDigest === binding.contentDigest && pinnedStamp.stamp.sourceCommit === binding.sourceCommit && pinnedStamp.url.endsWith('/.timds-artifact.json'), 'pinned_bundle_authority_missing', {system: system.key, version: binding.version});
  const probes = [{kind: 'first-event-pinned-bundle', url: pinnedStamp.url.replace(/\.timds-artifact\.json$/, 'bundle.json')}];
  if (system.source.published_version === binding.version) {
    const current = baseline.publicReadBaseline.results.find(row => row.system === system.key && row.kind === 'current-bundle');
    assert(current?.status === 200, 'current_bundle_authority_missing');
    probes.push({kind: 'current-pointer-bundle', url: current.url});
  }
  const proofs = [];
  for (const probe of probes) {
    const response = await fetch(probe.url, {redirect: 'error', signal: AbortSignal.timeout(30_000)});
    assert(response.ok && response.body, 'served_bundle_unavailable', {system: system.key, version: binding.version, status: response.status});
    const digest = await hashStream(Readable.fromWeb(response.body), 12_000_000);
    assert(digest.sha256 === file.sha256 && digest.size === file.size, 'served_bundle_differs_from_local', {system: system.key, version: binding.version, expectedSha256: file.sha256, actualSha256: digest.sha256});
    proofs.push({...probe, ...digest});
  }
  return proofs;
}
async function inventory({baseline, baselineDigest, opts, source, target}) {
  const names = opts.sources.split(','); assert(new Set(names).size === names.length, 'duplicate_source_selection');
  const systems = names.map(key => { const value = baseline.systems.find(s => s.key === key); assert(value?.source, 'selection_missing_or_deleted', {system: key}); return value; });
  const conflicts = [], releases = [], operations = [];
  const deleted = await verifyDeleted(baseline, opts['artifact-root'], source, target, opts.mode);
  const publicReads = await verifyPublic(baseline, systems);
  for (const system of systems) for (const binding of bindings(system)) {
    const localRoot = path.join(opts['artifact-root'], system.source.id, binding.contentDigest);
    assert((await fs.lstat(localRoot)).isDirectory() && (await fs.realpath(localRoot)) === localRoot, 'unsafe_artifact_directory');
    const metadata = JSON.parse(await fs.readFile(path.join(localRoot, '.timds-artifact.json'), 'utf8'));
    const expected = system.local.trees.find(t => t.contentDigest === binding.contentDigest);
    assert(expected?.requiredForCurrentOrFirstBinding && hex(metadata.contentDigest) && metadata.contentDigest === binding.contentDigest && safePath(metadata.entryPath) && JSON.stringify(metadata) === JSON.stringify(expected.metadata), 'artifact_metadata_changed', {system: system.key, version: binding.version});
    const files = await walk(localRoot);
    assert(files.some(f => f.path === metadata.entryPath) && files.length === metadata.fileCount && files.reduce((sum, f) => sum + f.size, 0) === metadata.totalBytes, 'local_artifact_counts_changed');
    const oldPrefix = `${system.source.system_id}/artifact/v/${binding.version}/`;
    const newPrefix = opts.mode === 'legacy' ? oldPrefix : `sources/${system.source.id}/v/${encodeURIComponent(binding.version)}/`;
    const existing = await source.list(oldPrefix);
    const byPath = new Map(files.map(f => [f.path, f]));
    const retained = [], aliases = [], supplements = [], reconciliations = [];
    const entryDir = path.posix.dirname(metadata.entryPath);
    const existingKeys = [...existing.keys()].filter(key => !reserved.has(key.slice(oldPrefix.length))).sort();
    const existingBodies = await mapBounded(existingKeys, key => source.get(key));
    for (const [existingIndex, key] of existingKeys.entries()) {
      const relative = key.slice(oldPrefix.length); assert(safePath(relative), 'unsafe_source_r2_key');
      if (reserved.has(relative)) continue;
      const remote = existingBodies[existingIndex];
      assert(remote, 'source_object_disappeared', {key});
      const exact = byPath.get(relative), alias = entryDir !== '.' && byPath.get(`${entryDir}/${relative}`);
      if (exact || alias) {
        const reference = exact || alias;
        if (remote.size !== reference.size || remote.sha256 !== reference.sha256) {
          const servedBundle = (entryDir !== '.' && byPath.get(`${entryDir}/bundle.json`)) || byPath.get('bundle.json');
          if (relative === 'bundle.json' && servedBundle?.path === reference.path) {
            const publicProofs = await proveServedBundle(baseline, system, binding, reference);
            reconciliations.push({publicPath: 'bundle.json', localPath: reference.path, size: reference.size, sha256: reference.sha256, mode: reference.mode, contentType: 'application/json', sidecarKey: `${system.source.system_id}/artifact/.timds-served/sha256/${reference.sha256}/bundle.json`, retainedLegacyObject: {bucket: source.conf.bucket, key, size: remote.size, sha256: remote.sha256}, publicProofs});
          } else conflicts.push({code: 'source_immutable_collision', key, localSha256: reference.sha256, r2Sha256: remote.sha256});
        }
        if (!exact) aliases.push({key, localPath: reference.path, sha256: remote.sha256, size: remote.size});
      } else if (relative === 'bundle.json' || relative.startsWith('bundle/')) {
        const contentType=remote.contentType||legacyMime(relative);
        assert(typeof contentType==='string'&&contentType.length<=200&&!/[\r\n\x00]/.test(contentType),'invalid_bundle_content_type');
        const supplement = {path: relative, mode: '100644', size: remote.size, sha256: remote.sha256, sourceKey: key, contentType};
        supplements.push(supplement); byPath.set(relative, supplement);
      } else retained.push({key, sha256: remote.sha256, size: remote.size});
    }
    const stamp = {schemaVersion: 1, systemId: system.source.system_id, version: binding.version, sourceCommit: binding.sourceCommit, contentDigest: binding.contentDigest, entry: 'index.html'};
    const oldStamp = await source.get(oldPrefix + '.timds-artifact.json', true);
    if (oldStamp) {
      let parsed; try { parsed = JSON.parse(oldStamp.bytes); } catch { fail('invalid_source_r2_stamp', {system: system.key, version: binding.version}); }
      for (const key of ['schemaVersion','systemId','version','sourceCommit','contentDigest']) assert(parsed[key] === stamp[key], 'source_r2_stamp_binding_collision', {system: system.key, version: binding.version, field: key});
    }
    const artifactFiles = [...files, ...supplements].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    assert(new Set(artifactFiles.map(f => f.path)).size === artifactFiles.length, 'duplicate_artifact_path');
    if (opts.mode === 'host-releases') assert(artifactFiles.length <= 2000 && artifactFiles.every(f => f.size <= 12_000_000) && artifactFiles.reduce((sum, f) => sum + f.size, 0) <= 80_000_000, 'host_release_limits_exceeded');
    const releaseOps = artifactFiles.map(file => ({key: newPrefix + file.path, path: file.path, size: file.size, sha256: file.sha256, contentType: file.contentType||mime(file.path), source: file.sourceKey ? {kind: 'r2', key: file.sourceKey} : {kind: 'local', sourceId: system.source.id, contentDigest: binding.contentDigest, path: file.path}, phase: 'file'}));
    if (opts.mode === 'legacy') for (const item of reconciliations) {
      const fileOperation = releaseOps.find(operation => operation.path === item.localPath);
      assert(fileOperation, 'reconciliation_file_missing');
      // If a conflicting legacy key is also the raw full path, the serving map
      // redirects that file to the sidecar. Nested raw paths stay independently
      // preserved; the root bundle uses the sidecar.
      if (fileOperation.key === item.retainedLegacyObject.key) fileOperation.key = item.sidecarKey;
      if (!releaseOps.some(operation => operation.key === item.sidecarKey)) releaseOps.push({...fileOperation, key: item.sidecarKey, phase: 'sidecar'});
    }
    // Legacy stamps preserve existing exact bytes. New stamps match the existing
    // portal's virtual stamp serialization; the internal local metadata is never public.
    const stampBytes = opts.mode === 'legacy' ? oldStamp?.bytes || Buffer.from(JSON.stringify(stamp)) : Buffer.from(JSON.stringify(stamp, null, 2) + '\n');
    releaseOps.push({key: newPrefix + '.timds-artifact.json', path: '.timds-artifact.json', size: stampBytes.length, sha256: sha(stampBytes), contentType: 'application/json', source: {kind: 'generated', text: stampBytes.toString('utf8')}, phase: 'stamp'});
    const manifest = {version: 1, files: artifactFiles.map(({path, mode, size, sha256}) => ({path, mode, size, sha256})), totalBytes: artifactFiles.reduce((sum, file) => sum + file.size, 0)};
    let releaseManifestDigest=null;
    if (opts.mode === 'host-releases') {
      assert(uuid(binding.eventId)&&uuid(binding.versionId),'host_release_requires_first_event');
      const text = JSON.stringify({schemaVersion: 1, sourceId: system.source.id, version: stamp.version, stamp, manifest});
      assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'host_receipt_too_large');
      releaseManifestDigest=sha(text);
      releaseOps.push({key: newPrefix + '.timds-release.json', path: '.timds-release.json', size: Buffer.byteLength(text), sha256: sha(text), contentType: 'application/json', source: {kind: 'generated', text}, phase: 'receipt'});
    }
    const servingMap = {
      schemaVersion: 1, kind: 'timds-legacy-serving-map', sourceId: system.source.id, systemId: system.source.system_id,
      version: binding.version, contentDigest: binding.contentDigest, sourceCommit: binding.sourceCommit,
      firstPublicationEventId: binding.eventId, versionId: binding.versionId, entryPath: metadata.entryPath,
      localPaths: files.map(file=>file.path),
      bundleFallbacks: supplements.map(file=>({path:file.path,contentType:file.contentType})),
      behavior: {files: 'byte-preserving', consumerBundle: 'byte-preserving', html: 'legacy-public-roots-rewrite-required', entry: 'legacy-meta-refresh-resolution-required', missingText: 'legacy-llms-synthesis-required'},
      files: artifactFiles.map(file => ({path: file.path, key: releaseOps.find(operation => operation.path === file.path).key, mode: file.mode, contentType: file.contentType||legacyMime(file.path), size: file.size, sha256: file.sha256})),
      publicOverrides: reconciliations.map(item => ({...item, storageStrategy: opts.mode === 'legacy' ? 'content-hashed-sidecar' : 'native-host-release', objectKey: opts.mode === 'legacy' ? item.sidecarKey : newPrefix + item.localPath})),
    };
    let servingMapRef = null;
    if (opts.mode === 'legacy') {
      const text = JSON.stringify(servingMap), digest = sha(text);
      assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'serving_map_too_large');
      servingMapRef = {key: `${system.source.system_id}/artifact/.timds-serving/${system.source.id}/v/${binding.version}/${binding.contentDigest}/${digest}.json`, sha256: digest, size: Buffer.byteLength(text)};
      releaseOps.push({...servingMapRef, path: '.timds-serving-map.json', contentType: 'application/json', source: {kind: 'generated', text}, phase: 'receipt'});
    }
    assert(new Set(releaseOps.map(operation => operation.key)).size === releaseOps.length, 'duplicate_target_key');
    const targetKeys = target === source ? existing : await target.list(newPrefix);
    const targetBodies = await mapBounded(releaseOps, operation => targetKeys.has(operation.key) || !operation.key.startsWith(newPrefix) ? target.get(operation.key) : null);
    for (const [operationIndex, operation] of releaseOps.entries()) {
      const prior = targetBodies[operationIndex];
      operation.status = prior ? 'verified' : 'missing';
      if (prior && (prior.size !== operation.size || prior.sha256 !== operation.sha256 || opts.mode === 'host-releases' && prior.metadataSha256 !== operation.sha256)) { operation.status = 'collision'; conflicts.push({code: 'target_immutable_collision', key: operation.key, expectedSha256: operation.sha256, actualSha256: prior.sha256}); }
    }
    operations.push(...releaseOps);
    releases.push({system: system.key, sourceId: system.source.id, systemId: system.source.system_id, ...binding, entryPath: metadata.entryPath, manifest, aliases, retainedUnknownObjects: retained, supplementCount: supplements.length, targetPrefix: newPrefix, reconciliations, servingMap, servingMapRef, ...(opts.mode === 'host-releases' ? {artifactRef: `release:${newPrefix}.timds-release.json`, stamp, legacyPublic: {schemaVersion:1,behavior:'portal-public-roots-v1',firstPublicationEventId:binding.eventId,artifactManifestDigest:releaseManifestDigest,entryPath:metadata.entryPath,localPaths:servingMap.localPaths,bundleFallbacks:servingMap.bundleFallbacks}} : {})});
    log({stage: 'inventory', system: system.key, version: binding.version, files: manifest.files.length, missing: releaseOps.filter(o => o.status === 'missing').length, conflicts: conflicts.length, reconciledBundles: reconciliations.length});
  }
  const identity = {schemaVersion: 1, baselineSha256: baselineDigest, mode: opts.mode, source: {endpoint: source.conf.endpoint, bucket: source.conf.bucket}, target: {endpoint: target.conf.endpoint, bucket: target.conf.bucket}, systems: systems.map(s => ({key: s.key, sourceId: s.source.id, systemId: s.source.system_id})), releases, operations: operations.map(({status, ...operation}) => operation)};
  return {schemaVersion: 1, createdAt: new Date().toISOString(), planSha256: sha(JSON.stringify(identity)), identity, observations: {deleted, publicReads, operations: operations.map(({key, status}) => ({key, status})), conflicts}};
}
async function verifyRetainedBundles(plan, source) {
  const results = [];
  for (const release of plan.identity.releases) for (const item of release.reconciliations) {
    const original = item.retainedLegacyObject, actual = await source.get(original.key, false, true);
    assert(actual?.sha256 === original.sha256 && actual.size === original.size, 'retained_legacy_bundle_changed', {key: original.key});
    results.push({...original, verifiedAt: new Date().toISOString()});
  }
  return results;
}
async function apply(plan, opts, source, target) {
  assert(opts['approve-plan-sha256'] === plan.planSha256, 'plan_digest_not_approved', {planSha256: plan.planSha256});
  assert(!plan.observations.conflicts.length, 'immutable_collisions_block_apply', {count: plan.observations.conflicts.length});
  const receiptPath = opts.receipt || `${opts.plan}.receipt.json`;
  const receipt = await exists(receiptPath) ? JSON.parse(await fs.readFile(receiptPath, 'utf8')) : {schemaVersion: 1, planSha256: plan.planSha256, startedAt: new Date().toISOString(), objects: []};
  assert(receipt.planSha256 === plan.planSha256, 'receipt_plan_mismatch');
  // The journal is progress evidence only. Every resumed object is GET/hash verified.
  // Copy independent files concurrently; serialize journal snapshots and keep
  // every release marker behind all earlier file verification.
  let journal = Promise.resolve();
  async function copy(operation) {
    const prior = await target.get(operation.key, false, true);
    let wrote = false;
    if (!prior) {
      let body;
      if (operation.source.kind === 'local') body = createReadStream(path.join(opts['artifact-root'], operation.source.sourceId, operation.source.contentDigest, operation.source.path));
      else if (operation.source.kind === 'r2') body = (await source.call('GetObjectCommand', {Key: operation.source.key})).Body;
      else body = Readable.from([Buffer.from(operation.source.text)]);
      const hash = createHash('sha256'); let size = 0;
      const verify = new Transform({transform(chunk, encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); }, flush(callback) { if (size !== operation.size || hash.digest('hex') !== operation.sha256) callback(Object.assign(new Error('source_changed_during_copy'), {safe: {code: 'source_changed_during_copy', key: operation.key}})); else callback(); }});
      body.on('error', error => verify.destroy(error)); body.pipe(verify);
      try {
        await target.call('PutObjectCommand', {Key: operation.key, Body: verify, ContentLength: operation.size, ContentType: operation.contentType, CacheControl: 'public, max-age=31536000, immutable', Metadata: {sha256: operation.sha256}, ChecksumSHA256: Buffer.from(operation.sha256, 'hex').toString('base64'), IfNoneMatch: '*'});
        wrote = true;
      } catch (error) { if (![409, 412].includes(error.$metadata?.httpStatusCode)) throw error; } finally { body.destroy(); verify.destroy(); }
    }
    const verified = prior || await target.get(operation.key, false, true);
    assert(verified?.size === operation.size && verified.sha256 === operation.sha256 && (opts.mode !== 'host-releases' || verified.metadataSha256 === operation.sha256), 'immutable_copy_verification_failed', {key: operation.key});
    const row = {key: operation.key, sha256: operation.sha256, size: operation.size, status: wrote ? 'copied-and-verified' : 'already-verified', verifiedAt: new Date().toISOString()};
    journal = journal.then(async () => {
      const index = receipt.objects.findIndex(o => o.key === row.key); if (index < 0) receipt.objects.push(row); else receipt.objects[index] = row;
      await save(receiptPath, receipt);
      if (operation.phase !== 'file' || receipt.objects.length % 100 === 0) log({stage: 'apply', verifiedObjects: receipt.objects.length, key: operation.key, status: row.status});
    });
    await journal;
  }
  let files = [];
  async function flush() {
    while (files.length) {
      const outcomes = await Promise.allSettled(files.splice(0, 8).map(copy));
      const failed = outcomes.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
  for (const operation of plan.identity.operations) {
    if (operation.phase === 'file') files.push(operation);
    else { await flush(); await copy(operation); }
  }
  await flush();
  return {receipt, receiptPath};
}
async function main() {
  const {values: opts} = parseArgs({options: Object.fromEntries(['baseline','artifact-root','sources','source-bucket','target-bucket','source-env-prefix','target-env-prefix','sdk-root','plan','receipt','approve-plan-sha256','mode'].map(key => [key, {type: 'string'}]).concat([['apply',{type:'boolean',default:false}],['help',{type:'boolean',default:false}]])), strict: true});
  if (opts.help) { process.stdout.write('Usage: node scripts/backfill-published-artifacts.mjs --baseline /absolute/fresh.json --artifact-root /absolute/artifacts --sources example-a,example-b,example-c --source-bucket timds-public-assets --target-bucket timds-public-assets --source-env-prefix PORTAL_TIMDS_ASSET_R2 --target-env-prefix PORTAL_TIMDS_ASSET_R2 --sdk-root /absolute/portal --plan /absolute/plan.json [--mode legacy|host-releases] [--apply --approve-plan-sha256 <reviewed digest> --receipt /absolute/receipt.json]\nDefault dry-run. No credentials in arguments. See docs/migration/artifact-backfill.md.\n'); return; }
  for (const key of ['baseline','artifact-root','sources','source-bucket','target-bucket','source-env-prefix','target-env-prefix','sdk-root','plan']) assert(opts[key], 'missing_argument', {argument: key});
  for (const key of ['baseline','artifact-root','sdk-root','plan','receipt']) if (opts[key]) assert(path.isAbsolute(opts[key]), 'absolute_path_required', {argument: key});
  opts['artifact-root'] = await fs.realpath(opts['artifact-root']);
  opts.mode ||= 'legacy'; assert(['legacy','host-releases'].includes(opts.mode), 'invalid_mode');
  const baselineBytes = await fs.readFile(opts.baseline), baseline = JSON.parse(baselineBytes);
  assert(baseline.schemaVersion === 1 && baseline.sourcesUnchangedDuringInventory === true, 'baseline_not_stable');
  const age = Date.now() - Date.parse(baseline.finishedAt);
  assert(Number.isFinite(age) && age >= -60_000, 'invalid_baseline_time');
  if (opts.apply) assert(age <= 3_600_000, 'baseline_older_than_one_hour');
  const require = createRequire(path.join(opts['sdk-root'], 'package.json'));
  const sdk = require('@aws-sdk/client-s3');
  const source = storage(sdk, config(opts['source-env-prefix'], opts['source-bucket']));
  const targetConfig = config(opts['target-env-prefix'], opts['target-bucket']);
  const target = targetConfig.endpoint === source.conf.endpoint && targetConfig.bucket === source.conf.bucket && opts['source-env-prefix'] === opts['target-env-prefix'] ? source : storage(sdk, targetConfig);
  if (opts.mode === 'legacy') assert(baseline.systems.filter(s => s.source && opts.sources.split(',').includes(s.key)).every(s => s.r2.bucket === opts['source-bucket']), 'source_bucket_differs_from_baseline');
  log({stage: 'start', mode: opts.mode, apply: opts.apply, baselineFresh: age <= 3_600_000});
  const plan = await inventory({baseline, baselineDigest: sha(baselineBytes), opts, source, target});
  if (opts.apply && await exists(opts.plan)) { const reviewed = JSON.parse(await fs.readFile(opts.plan, 'utf8')); assert(reviewed.planSha256 === plan.planSha256, 'inventory_changed_since_dry_run', {planSha256: plan.planSha256}); }
  await save(opts.plan, plan);
  log({stage: 'plan', planSha256: plan.planSha256, releases: plan.identity.releases.length, objects: plan.identity.operations.length, bytes: plan.identity.operations.reduce((sum, o) => sum + o.size, 0), missingObjects: plan.observations.operations.filter(o => o.status === 'missing').length, conflicts: plan.observations.conflicts.length, reconciledBundles: plan.identity.releases.reduce((sum, release) => sum + release.reconciliations.length, 0), applyAllowed: !plan.observations.conflicts.length && age <= 3_600_000});
  if (plan.observations.conflicts.length) fail('immutable_collisions_block_apply', {count: plan.observations.conflicts.length});
  if (opts.apply) {
    assert(Date.now() - Date.parse(baseline.finishedAt) <= 3_600_000, 'baseline_expired_during_inventory');
    // Recheck both active public identities and deleted identities immediately before any PUT.
    const systems = baseline.systems.filter(s => opts.sources.split(',').includes(s.key));
    await verifyPublic(baseline, systems);
    for (const release of plan.identity.releases) for (const item of release.reconciliations) await proveServedBundle(baseline, systems.find(system => system.source.id === release.sourceId), release, item);
    await verifyDeleted(baseline, opts['artifact-root'], source, target, opts.mode);
    await verifyRetainedBundles(plan, source);
    const {receipt, receiptPath} = await apply(plan, opts, source, target);
    receipt.retainedLegacyBundles = await verifyRetainedBundles(plan, source);
    receipt.deleted = await verifyDeleted(baseline, opts['artifact-root'], source, target, opts.mode);
    receipt.publicReads = await verifyPublic(baseline, systems);
    receipt.servingMaps = plan.identity.releases.map(release => ({sourceId: release.sourceId, version: release.version, contentDigest: release.contentDigest, sourceCommit: release.sourceCommit, firstPublicationEventId: release.eventId, servingMapRef: release.servingMapRef, reconciledBundles: release.reconciliations.length}));
    for (const release of plan.identity.releases) for (const item of release.reconciliations) await proveServedBundle(baseline, systems.find(system => system.source.id === release.sourceId), release, item);
    receipt.finishedAt = new Date().toISOString(); await save(receiptPath, receipt);
    log({stage: 'complete', planSha256: plan.planSha256, verifiedObjects: receipt.objects.length, pointerChanges: 0, deletions: 0});
  }
}
main().catch(error => { log({stage: 'failed', ...(error.safe || {code: 'operation_failed', errorName: /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : 'Error', httpStatus: error.$metadata?.httpStatusCode || null})}); process.exitCode = 1; });
