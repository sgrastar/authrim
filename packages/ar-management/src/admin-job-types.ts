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
