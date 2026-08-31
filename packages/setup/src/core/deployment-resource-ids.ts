import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import { getEnabledComponents, type WorkerComponent } from './naming.js';
import { loadPluginRunnerResourceBindingsForDeployment } from './plugin-resource-deployment-projection.js';
import type { queryD1Rows } from './cloudflare.js';
import { buildResourceIdsFromLock, type ResourceIds } from './wrangler.js';

export async function buildWorkerDeploymentResourceIds(input: {
  lock: AuthrimLock;
  config: AuthrimConfig;
  environmentId: string;
  components?: readonly WorkerComponent[];
  onProgress?: (message: string) => void;
  query?: typeof queryD1Rows;
}): Promise<ResourceIds> {
  const resourceIds = buildResourceIdsFromLock(input.lock, input.config);
  const pluginRunnerIncluded = input.components
    ? input.components.includes('ar-plugin-runner')
    : getEnabledComponents(input.config.components).has('ar-plugin-runner');
  if (!pluginRunnerIncluded) return resourceIds;
  const controlDatabaseId = input.lock.d1.CONTROL_DB?.id;
  if (!controlDatabaseId) {
    throw new Error('control_database_required_for_plugin_resource_projection');
  }
  resourceIds.pluginRunnerResources = await loadPluginRunnerResourceBindingsForDeployment({
    controlDatabaseName: controlDatabaseId,
    environmentId: input.environmentId,
    query: input.query,
  });
  input.onProgress?.(
    `Loaded ${resourceIds.pluginRunnerResources.length} deployable Plugin Runner resource binding(s)`
  );
  return resourceIds;
}
