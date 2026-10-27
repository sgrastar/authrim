import type { DatabaseSource } from '../db/adapter-source';
import type {
  AccountCoreDataContext,
  AccountDataContext,
  PortableTenantMetadataContext,
} from '../services/runtime-data-context';
import type { LookupIdentifierKind } from '../services/lookup-directory';

/** Trusted deployment adapters, never selected by a request header or request body. */
export interface RuntimeDataPorts {
  resolveTenant(tenantId: string): Promise<PortableTenantMetadataContext>;
  resolveAccount(input: {
    tenantId: string;
    indexKind: LookupIdentifierKind;
    identifier: string | { issuer: string; subject: string };
    expectedAccountId?: string;
    nowMs?: number;
  }): Promise<AccountDataContext>;
  resolveAccountCore(input: {
    tenantId: string;
    accountId: string;
    nowMs?: number;
  }): Promise<AccountCoreDataContext>;
  /** Audit resolution must also work for inactive accounts without permitting authentication. */
  resolveAccountPiiForAudit(input: {
    tenantId: string;
    accountId: string;
    nowMs?: number;
  }): Promise<DatabaseSource>;
}
