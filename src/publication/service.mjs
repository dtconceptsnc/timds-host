import {verifyArtifact} from './artifacts.mjs';
/** Public routes authorize through reservePublication; bindings never trust a caller's source row. */
export function createPublicationService({coordinator,store,workflow,bucket}){
 const call=(name,...args)=>store?store[name](...args):coordinator.publicationStore(name,args);
 async function recover(row,{restart=false}={}){
  await call('attachPublicationJob',row.id,row.id);
  let instance;
  try{instance=await workflow.get(row.id);await instance.status();}
  catch{await workflow.create({id:row.id,params:{sourceId:row.source_id,publicationId:row.id}});return;}
  const status=await instance.status();
  if((restart||row.checkpoints_json?.pointerEventId||row.status==='closing')&&['errored','terminated','complete'].includes(status.status))await instance.restart();
 }
 return {
  async publish(sourceId,submissionId,actor){const row=await call('reservePublication',sourceId,submissionId,actor);if(row.status!=='published')await recover(row,{restart:true});return row;},
  recover,
  verifyArtifact:version=>verifyArtifact(bucket,version),
 };
}
