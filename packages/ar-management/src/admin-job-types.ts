export type AdminJobProcessorStatus = 'scheduled' | 'inline' | 'disabled';

export interface AdminJobTypeDefinition {
  jobType: string;
  processorStatus: AdminJobProcessorStatus;
  creatableFromAdminApi: boolean;
  resultObjectClass?: 'user_import_result' | 'admin_job_result';
  supportedResultDelivery?: readonly ('auto' | 'inline' | 'artifact')[];
  createEndpoint?: string;
  notes?: string;
}

export const ADMIN_JOB_TYPE_REGISTRY = {
  'users/import': {
    jobType: 'users/import',
    processorStatus: 'scheduled',
    creatableFromAdminApi: true,
    resultObjectClass: 'user_import_result',
    supportedResultDelivery: ['artifact'],
    createEndpoint: '/api/admin/jobs/users/import',
  },
  'support-ops/cohort-snapshot': {
    jobType: 'support-ops/cohort-snapshot',
    processorStatus: 'scheduled',
    creatableFromAdminApi: false,
    notes: 'Created by Support Ops cohort workflows.',
  },
  'tenants/delete': {
    jobType: 'tenants/delete',
    processorStatus: 'scheduled',
    creatableFromAdminApi: false,
    notes: 'Platform/system job, not tenant-admin creatable.',
  },
  'tenant-database/provision': {
    jobType: 'tenant-database/provision',
    processorStatus: 'scheduled',
    creatableFromAdminApi: true,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['inline'],
    createEndpoint: '/api/admin/jobs/tenant-databases/provision',
    notes:
      'Generates tenant D1 binding/config plans for setup-tool or operator execution. Cloudflare resource mutation is not executed from Admin UI jobs.',
  },
  'tenant-database/activate-batch': {
    jobType: 'tenant-database/activate-batch',
    processorStatus: 'disabled',
    creatableFromAdminApi: true,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['inline'],
    createEndpoint: '/api/admin/jobs/tenant-databases/activate-batch',
    notes:
      'Creates a tenant database activation request. Execution currently requires setup CLI/operator deploy.',
  },
  'tenant-database/export': {
    jobType: 'tenant-database/export',
    processorStatus: 'scheduled',
    creatableFromAdminApi: false,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['inline', 'artifact'],
    notes:
      'Exports tenant core/PII durable tables to encrypted EXPORT_ARTIFACTS objects with a manifest.',
  },
  'tenant-database/restore-dry-run': {
    jobType: 'tenant-database/restore-dry-run',
    processorStatus: 'scheduled',
    creatableFromAdminApi: false,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['inline', 'artifact'],
    notes:
      'Validates a tenant database backup manifest, encrypted table artifacts, checksums, and row counts without importing data.',
  },
  'tenant-database/purge-backup': {
    jobType: 'tenant-database/purge-backup',
    processorStatus: 'scheduled',
    creatableFromAdminApi: false,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['inline', 'artifact'],
    notes:
      'Tombstones tenant database backup artifacts after retention and break-glass approval; physical object deletion is handled by object artifact cleanup.',
  },
  'tenant-database/final-purge': {
    jobType: 'tenant-database/final-purge',
    processorStatus: 'disabled',
    creatableFromAdminApi: false,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['inline', 'artifact'],
    notes:
      'Reserved destructive tenant database purge. Future execution requires system-admin break-glass confirmation first, with two-person approval as an extension point.',
  },
  'tenant-database/storage-profile-change': {
    jobType: 'tenant-database/storage-profile-change',
    processorStatus: 'disabled',
    creatableFromAdminApi: false,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['inline', 'artifact'],
    notes:
      'Reserved dangerous storage profile migration job. Creation requires system-admin break-glass approval initially; execution is deferred until migration tooling is implemented.',
  },
  'users/bulk-update': {
    jobType: 'users/bulk-update',
    processorStatus: 'scheduled',
    creatableFromAdminApi: true,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['auto', 'inline', 'artifact'],
    createEndpoint: '/api/admin/jobs/users/bulk-update',
  },
  'reports/generate': {
    jobType: 'reports/generate',
    processorStatus: 'scheduled',
    creatableFromAdminApi: true,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['auto', 'inline', 'artifact'],
    createEndpoint: '/api/admin/jobs/reports/generate',
  },
  'organizations/bulk-members': {
    jobType: 'organizations/bulk-members',
    processorStatus: 'scheduled',
    creatableFromAdminApi: true,
    resultObjectClass: 'admin_job_result',
    supportedResultDelivery: ['auto', 'inline', 'artifact'],
    createEndpoint: '/api/admin/jobs/organizations/:id/bulk-members',
  },
} as const satisfies Record<string, AdminJobTypeDefinition>;

export type AdminJobType = keyof typeof ADMIN_JOB_TYPE_REGISTRY;

export function getAdminJobTypeDefinition(jobType: string): AdminJobTypeDefinition | undefined {
  return ADMIN_JOB_TYPE_REGISTRY[jobType as AdminJobType];
}

export function getAdminJobResultObjectClass(
  jobType: string
): NonNullable<AdminJobTypeDefinition['resultObjectClass']> | null {
  return getAdminJobTypeDefinition(jobType)?.resultObjectClass ?? null;
}

export function isAdminJobTypeCreatableFromAdminApi(jobType: string): boolean {
  return getAdminJobTypeDefinition(jobType)?.creatableFromAdminApi === true;
}

export function listAdminJobTypeDefinitions(): AdminJobTypeDefinition[] {
  return Object.values(ADMIN_JOB_TYPE_REGISTRY);
}
