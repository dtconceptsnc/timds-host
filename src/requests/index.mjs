import {createRequestStore} from './store.mjs';
import {createDesignerRequests} from './service.mjs';
import {createDesigner} from './designer.mjs';
import {createHostLiveSessions,createLiveCallbacks} from '../live/sessions.mjs';

/** Called after the coordinator creates its session domain. Session lifecycle
 * hooks may close over the returned service; none execute during construction.
 * The factory supplies no HTTP or cross-source capability.
 */
export function createHostRequests({sourceId,storage,catalog,store,sessions,authorization,getLive,artifacts,hosts,subscriptions,
  designerPrincipalId,schedule,reconcilePush,ensurePreview,clock,runMutation}) {
  const live=createHostLiveSessions({sourceId,getLive,artifacts,store,hosts,subscriptions,clock});
  const requestStore=createRequestStore({storage,sourceId,catalog,store,clock});
  let requests;
  const designer=createDesigner({designerPrincipalId,authorization,sessions,store,live,getRequestBinding:id=>requests.binding(id),reconcilePush,ensurePreview,runMutation});
  requests=createDesignerRequests({sourceId,store,requestStore,authorization,sessions,designer,live,schedule,runMutation});
  // A runner leaving its Request wakes the alarm so the session's next queued Request starts within a second.
  const onRunnerIdle=async()=>{const at=requestStore.nextAlarm();if(at!=null && at<Date.now()+5_000)await schedule();};
  const callback=createLiveCallbacks({sourceId,store,sessions,live,designer,requestBinding:id=>requests.binding(id),onRunnerIdle,clock});
  return {...requests,live,designer,callback};
}
