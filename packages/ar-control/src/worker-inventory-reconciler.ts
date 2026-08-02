import type { CloudflareControlApiClient } from '@authrim/ar-lib-core/control-plane';
import type { EnvironmentRow } from './repository';

const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_ENVIRONMENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;

export interface WorkerInventoryReconcilerRepository {
  listActiveEnvironments(): Promise<EnvironmentRow[]>;
  listActiveDesiredWorkerNames(environmentId: string): Promise<string[]>;
  recordActualOnlyWorkerFindings(
    environmentId: string,
    scriptNames: readonly string[],
    now: number
  ): Promise<void>;
  resolveMissingActualOnlyWorkerFindings(
    environmentId: string,
    stillActualOnlyScriptNames: readonly string[],
    now: number
  ): Promise<void>;
}

type WorkerInventoryApi = Pick<CloudflareControlApiClient, 'listWorkerScripts'>;

export interface WorkerInventoryReconcileResult {
  environmentsChecked: number;
  providerWorkersChecked: number;
  actualOnlyCount: number;
}

function environmentPrefix(environment: EnvironmentRow): string {
  if (!SAFE_ENVIRONMENT_NAME.test(environment.environment_name)) {
    throw new Error('control_invalid_environment_name_for_worker_inventory');
  }
  return `${environment.environment_name}-`;
}

export class WorkerInventoryReconciler {
  constructor(
    private readonly repository: WorkerInventoryReconcilerRepository,
    private readonly api: WorkerInventoryApi,
    private readonly now: () => number
  ) {}

  async reconcile(): Promise<WorkerInventoryReconcileResult> {
    const [environments, providerScripts] = await Promise.all([
      this.repository.listActiveEnvironments(),
      this.api.listWorkerScripts(),
    ]);
    const actualNames = [
      ...new Set(
        providerScripts
          .map((script) => script.id.trim())
          .filter((scriptName) => SAFE_SCRIPT_NAME.test(scriptName))
      ),
    ].sort();
    const environmentsBySpecificity = [...environments].sort(
      (left, right) =>
        right.environment_name.length - left.environment_name.length ||
        left.environment_name.localeCompare(right.environment_name)
    );
    const actualNamesByEnvironment = new Map<string, string[]>();
    for (const scriptName of actualNames) {
      const owner = environmentsBySpecificity.find((environment) =>
        scriptName.startsWith(environmentPrefix(environment))
      );
      if (!owner) continue;
      const ownedNames = actualNamesByEnvironment.get(owner.environment_id) ?? [];
      ownedNames.push(scriptName);
      actualNamesByEnvironment.set(owner.environment_id, ownedNames);
    }
    let actualOnlyCount = 0;
    const observedAt = this.now();

    for (const environment of environments) {
      const prefix = environmentPrefix(environment);
      const desiredNames = new Set(
        (await this.repository.listActiveDesiredWorkerNames(environment.environment_id)).filter(
          (scriptName) => SAFE_SCRIPT_NAME.test(scriptName) && scriptName.startsWith(prefix)
        )
      );
      const actualOnly = (actualNamesByEnvironment.get(environment.environment_id) ?? []).filter(
        (scriptName) => scriptName.startsWith(prefix) && !desiredNames.has(scriptName)
      );
      await this.repository.recordActualOnlyWorkerFindings(
        environment.environment_id,
        actualOnly,
        observedAt
      );
      await this.repository.resolveMissingActualOnlyWorkerFindings(
        environment.environment_id,
        actualOnly,
        observedAt
      );
      actualOnlyCount += actualOnly.length;
    }

    return {
      environmentsChecked: environments.length,
      providerWorkersChecked: actualNames.length,
      actualOnlyCount,
    };
  }
}
