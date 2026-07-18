import { createAgentToolCatalog } from '../../core';
import { ADMIN_READ_TOOL_DEFINITIONS } from './admin-read-tools';
import { ADMIN_WRITE_TOOL_DEFINITIONS } from './admin-write-tools';
import { ADMIN_CONFIGURATION_TOOL_DEFINITIONS } from './admin-configuration-tools';
import { ADMIN_BULK_TOOL_DEFINITIONS } from './admin-bulk-tools';
import { ADMIN_CONFIGURATION_INSPECTION_TOOL_DEFINITIONS } from './admin-inspection-tools';

export function createAdminToolCatalog() {
  return createAgentToolCatalog('admin-agent-access-v5', [
    ...ADMIN_READ_TOOL_DEFINITIONS,
    ...ADMIN_CONFIGURATION_INSPECTION_TOOL_DEFINITIONS,
    ...ADMIN_WRITE_TOOL_DEFINITIONS,
    ...ADMIN_CONFIGURATION_TOOL_DEFINITIONS,
    ...ADMIN_BULK_TOOL_DEFINITIONS,
  ]);
}
