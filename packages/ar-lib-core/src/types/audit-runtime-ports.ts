import type { AuditLogEntry } from './admin';

/** Deployment-owned durable audit delivery. A rejected write must fail the caller. */
export interface AuditRuntimePorts {
  append(entry: AuditLogEntry & { requireDurableFanout?: boolean }): Promise<void>;
}
