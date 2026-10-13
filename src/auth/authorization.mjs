import { fail } from '../store/errors.mjs';

export const principalActor = principal => ({ principalId: principal.id, type: principal.type,
  userId: null, tokenId: null, operator: principal.admin === true });

/** Scope checks happen at the HTTP boundary. D1 remains the live authority. */
export function createAuthorization({ catalog, hasSessionAccess = async () => false, requestBinding = async () => null }) {
  async function authenticatePrincipal(id) {
    const principal = await catalog.principal(id);
    if (!principal || principal.status !== 'active') throw fail(403, 'This TimDS identity is inactive');
    return principalActor(principal);
  }
  async function authority(source, actor) {
    if (!source?.id || !actor?.principalId) throw fail(403, 'A TimDS identity is required');
    const current = await catalog.readAuthority(source.id, actor.principalId);
    if (!current.principal || current.principal.status !== 'active') throw fail(403, 'This TimDS identity is inactive');
    if (!current.source) throw fail(404, 'Design System not found');
    if (current.organizationStatus !== 'active' || current.source.archived_at || current.source.lifecycle_status !== 'ready') throw fail(409, 'Design System is archived or deleting');
    if (!current.source.artifacts_namespace || !current.source.artifacts_repository) throw fail(409, 'Hosted authoring is unavailable');
    return current;
  }
  async function authorizeSource(source, actor, { starting = false } = {}) {
    const current = await authority(source, actor);
    let delegated = false;
    if (actor.requestId) {
      const binding = await requestBinding(actor.requestId);
      if (!binding || binding.sourceId !== source.id || binding.active === false) throw fail(403, 'Request identity does not match this Design System');
      if (binding.agentPrincipalId === actor.principalId && current.principal.type === 'agent') {
        if (binding.principalId === actor.principalId) throw fail(403, 'Request authority cannot delegate to itself');
        const requester = await authenticatePrincipal(binding.principalId);
        await authorizeSource(source,requester);
        delegated = true;
      } else if (binding.principalId !== actor.principalId) throw fail(403, 'Request identity does not match this Design System');
    }
    const direct = actor.accessMode === 'read' ? current.access.read || current.access.write : current.access.write;
    // sessionOwned is set only after the domain has read the session/member row.
    const member = actor.sessionOwned === true || await hasSessionAccess(source.id, actor.principalId);
    if (!current.principal.admin && !direct && !current.publisher && !member && !delegated) throw fail(403, 'This identity cannot access this Design System');
    if (starting && actor.accessMode === 'read') throw fail(403, 'Write access is required');
    return current;
  }
  async function authorizePublish(source, actor) {
    const current = await authority(source, actor);
    if (!current.publisher) throw fail(403, 'Publishing requires an active publisher grant');
    return current;
  }
  return { authenticatePrincipal, authorizeSource, authorizePublish };
}
