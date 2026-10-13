import { loadRelease,verifyRelease } from '../publication/releases.mjs';
import { fail } from '../store/errors.mjs';
import { byteDigest,DIGEST } from './contract.mjs';
import { validateLegacyReleaseMetadata } from '../public/legacy.mjs';

/** Hash the actual immutable manifest bytes, then verify every physical file and
 * stamp against R2 HEAD/checksums (existing helper deep-checks absent checksums). */
export async function verifyImportedRelease(storage,version,manifestDigest) {
  if(!DIGEST.test(manifestDigest||'')||!version.artifact_ref?.startsWith('release:'))throw fail(400,'A physical immutable RELEASES manifest and digest are required');
  const {bucket,root,receipt}=await loadRelease(storage,version);
  validateLegacyReleaseMetadata(version,{manifest:receipt.manifest,manifestDigest});
  const object=await bucket.get(`${root}.timds-release.json`);
  if(!object||object.size>2*1024*1024||byteDigest(new Uint8Array(await object.arrayBuffer()))!==manifestDigest)throw fail(409,'Export release manifest does not match stored bytes');
  await verifyRelease(storage,version);
  return {versionId:version.id,artifactRef:version.artifact_ref,manifestDigest,sourceCommit:version.source_commit,contentDigest:version.content_digest};
}
