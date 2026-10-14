// Files a metadata operation reads, mirroring the pinned toolkit's own
// selection so the metadata container receives only those bytes instead of the
// whole source tree. `release-metadata` (prepareMergeRelease) reads four source
// files and the prior manifest. `stamp` (createPublicationStampFromFiles,
// snapshot schema 1) hashes the source contract: timds.json, tokens.json,
// media.json and everything under docs/, components/ and assets/, plus every
// artifact file. The toolkit skips symbolic links, so they are never copied.
// Keep this in step with TOOLKIT_VERSION in cache.mjs.
const releaseSources=new Set(['timds.json','package.json','package-lock.json','CHANGELOG.md']);
const stampContract=/^(?:timds\.json|tokens\.json|media\.json|(?:docs|components|assets)\/.+)$/;
const regular=file=>['100644','100755'].includes(file.mode);
export function metadataInputFiles(operation,tree,files){
 if(operation==='release-metadata'&&tree==='source')return files.filter(file=>regular(file)&&releaseSources.has(file.path));
 if(operation==='release-metadata'&&tree==='prior')return files.filter(file=>regular(file)&&file.path==='timds.json');
 if(operation==='stamp'&&tree==='source')return files.filter(file=>regular(file)&&stampContract.test(file.path));
 if(operation==='stamp'&&tree==='artifact')return files;
 throw new Error('Unknown metadata input tree');
}
