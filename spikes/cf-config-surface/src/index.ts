import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export class ProofWorkflow extends WorkflowEntrypoint<Env, { receipt: string }> {
  async run(event: WorkflowEvent<{ receipt: string }>, step: WorkflowStep) {
    return step.do('echo-tooling-receipt', async () => event.payload.receipt);
  }
}

export default {
  fetch(request, env) { return env.ASSETS.fetch(request); },
} satisfies ExportedHandler<Env>;

// Compile-only probes. No HTTP route calls these and no deployment is required.
async function typeProbe(env: Env) {
  const workflow: Workflow = env.PROOF_WORKFLOW;
  const oauth: KVNamespace = env.OAUTH_KV;
  const bucket: R2Bucket = env.OBJECTS;
  const namespaces: Record<string, Artifacts> = { a: env.ORG_A_REPOS, b: env.ORG_B_REPOS };
  return { workflow, oauth, bucket, namespaces };
}
