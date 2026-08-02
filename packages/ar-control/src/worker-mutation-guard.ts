import type {
  CloudflareControlApiClient,
  CloudflareWorkerDeployment,
  CloudflareWorkerSettings,
  CloudflareWorkerVersion,
} from '@authrim/ar-lib-core/control-plane';
import type { ControlRepository, DesiredWorkerInventoryRow } from './repository';

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_WORKER_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export type ScriptScopedWorkersApi = Pick<
  CloudflareControlApiClient,
  | 'getWorkerSettings'
  | 'patchWorkerSettings'
  | 'deleteWorkerScript'
  | 'listWorkerVersions'
  | 'listWorkerDeployments'
  | 'createWorkerDeployment'
>;

export class GuardedWorkerControlClient {
  constructor(
    private readonly repository: ControlRepository,
    private readonly api: ScriptScopedWorkersApi
  ) {}

  private async authorize(
    environmentId: string,
    scriptName: string
  ): Promise<DesiredWorkerInventoryRow> {
    if (!SAFE_ENVIRONMENT_ID.test(environmentId)) throw new Error('invalid_environment_id');
    if (!SAFE_WORKER_SCRIPT_NAME.test(scriptName)) throw new Error('invalid_worker_script_name');
    const desired = await this.repository.getActiveDesiredWorker(environmentId, scriptName);
    if (!desired) throw new Error('control_worker_not_in_desired_inventory');
    if (
      desired.environment_id !== environmentId ||
      desired.worker_script_name !== scriptName ||
      desired.status !== 'active'
    ) {
      throw new Error('control_worker_inventory_boundary_violation');
    }
    return desired;
  }

  async getWorkerSettings(
    environmentId: string,
    scriptName: string
  ): Promise<CloudflareWorkerSettings> {
    await this.authorize(environmentId, scriptName);
    return this.api.getWorkerSettings(scriptName);
  }

  async patchWorkerSettings(
    environmentId: string,
    scriptName: string,
    settings: CloudflareWorkerSettings
  ): Promise<CloudflareWorkerSettings> {
    await this.authorize(environmentId, scriptName);
    return this.api.patchWorkerSettings(scriptName, settings);
  }

  async deleteWorkerScript(environmentId: string, scriptName: string): Promise<void> {
    await this.authorize(environmentId, scriptName);
    return this.api.deleteWorkerScript(scriptName);
  }

  async listWorkerVersions(
    environmentId: string,
    scriptName: string
  ): Promise<CloudflareWorkerVersion[]> {
    await this.authorize(environmentId, scriptName);
    return this.api.listWorkerVersions(scriptName);
  }

  async listWorkerDeployments(
    environmentId: string,
    scriptName: string
  ): Promise<CloudflareWorkerDeployment[]> {
    await this.authorize(environmentId, scriptName);
    return this.api.listWorkerDeployments(scriptName);
  }

  async createWorkerDeployment(
    environmentId: string,
    scriptName: string,
    versionId: string,
    message: string
  ): Promise<CloudflareWorkerDeployment> {
    await this.authorize(environmentId, scriptName);
    return this.api.createWorkerDeployment(scriptName, versionId, message);
  }
}
