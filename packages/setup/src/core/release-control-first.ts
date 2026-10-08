import type { AuthrimLock } from './lock.js';
import type { WorkerComponent } from './naming.js';

/**
 * Whether the lock shows an ar-control that may already be running. A deployment interrupted after
 * Cloudflare created or updated the script leaves only an ownership checkpoint, not a final Worker
 * record, so that checkpoint counts too: treating it as "not deployed" would let an older running
 * Control read the handoff first.
 */
export function isControlRecordedInLock(
  lock: Pick<AuthrimLock, 'workers' | 'workerScriptOwnership'>
): boolean {
  return Boolean(lock.workers?.['ar-control'] ?? lock.workerScriptOwnership?.['ar-control']);
}

/**
 * The migration release artifact is read by the deployed ar-control (its cron picks a handoff
 * row up within seconds). A Control built from an older source cannot parse a manifest format
 * introduced by the release being installed and would block every target terminally.
 *
 * So when this update deploys ar-control and hands managed streams to it, the new ar-control must
 * be live before the release is activated and the handoff row exists. A resumed update whose
 * handoff row already exists keeps the earlier order: the row cannot be un-created, and ar-control
 * is still redeployed first by the regular coordinator step.
 * Likewise when ar-control is not deployed yet: no Control can read the handoff early, so the
 * original order is safe and the first Control install keeps its bootstrap path.
 */
export function shouldDeployControlBeforeRolloutHandoff(input: {
  componentsToUpdate: readonly WorkerComponent[];
  controlManagedStreamIds: readonly string[];
  handoffAlreadyCreated: boolean;
  controlAlreadyDeployed: boolean;
}): boolean {
  return (
    input.controlManagedStreamIds.length > 0 &&
    !input.handoffAlreadyCreated &&
    // Without a deployed Control nothing can read a handoff early, so the original order is safe,
    // and the first Control install keeps its bootstrap path (it needs the other Workers' state).
    input.controlAlreadyDeployed &&
    input.componentsToUpdate.includes('ar-control')
  );
}

/**
 * Deploys ar-control exactly once, from whichever stage reaches it first. The early stage (before
 * the handoff) builds deploy options scoped to ar-control alone; the regular stage supplies the
 * options for the whole update, built later from the lock and generated configs as they are then.
 * The stage that actually runs the deployment decides which options are used; the other stage
 * reuses its result and never redeploys. A failed attempt is forgotten so it can be retried.
 */
export function createControlCoordinatorDeployer<TOptions, TSummary>(input: {
  deploy: (options: TOptions) => Promise<TSummary>;
}): {
  deployEarly: (buildScopedOptions: () => Promise<TOptions>) => Promise<TSummary>;
  deployRegular: (options: TOptions) => Promise<TSummary>;
  readonly completed: boolean;
} {
  let pending: Promise<TSummary> | undefined;
  let completed = false;
  const run = (resolveOptions: () => Promise<TOptions>): Promise<TSummary> => {
    if (!pending) {
      pending = resolveOptions()
        .then((options) => input.deploy(options))
        .then(
          (summary) => {
            completed = true;
            return summary;
          },
          (error: unknown) => {
            pending = undefined;
            throw error;
          }
        );
    }
    return pending;
  };
  return {
    deployEarly: (buildScopedOptions) => run(buildScopedOptions),
    deployRegular: (options) => run(async () => options),
    get completed() {
      return completed;
    },
  };
}

/**
 * Orders the Control handoff: (optionally) deploy ar-control, publish and activate the migration
 * release, then create the rollout row. If the early deployment fails nothing is published or
 * handed off, so the interrupted update stays resumable from its recorded state.
 */
export async function runControlRolloutHandoffSequence<TDeployment, TPublished, THandoff>(steps: {
  deployControlFirst: boolean;
  deployControl: () => Promise<TDeployment>;
  publishRelease: () => Promise<TPublished>;
  createHandoff: (published: TPublished) => Promise<THandoff>;
}): Promise<{ deployment?: TDeployment; published: TPublished; handoff: THandoff }> {
  let deployment: TDeployment | undefined;
  if (steps.deployControlFirst) {
    deployment = await steps.deployControl();
  }
  const published = await steps.publishRelease();
  const handoff = await steps.createHandoff(published);
  return { deployment, published, handoff };
}
