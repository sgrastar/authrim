import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

const root = process.cwd();

const docs = {
  admin: 'packages/ar-management/openapi/admin.openapi.yaml',
  frontendAuth: 'packages/ar-management/openapi/frontend-auth.openapi.yaml',
  userSelfService: 'packages/ar-management/openapi/user-self-service.openapi.yaml',
};

const methodVerbs = {
  get: 'List',
  post: 'Create',
  put: 'Replace',
  patch: 'Update',
  delete: 'Delete',
};

const actionWords = new Map([
  ['activate', 'Activate'],
  ['apply', 'Apply'],
  ['approve', 'Approve'],
  ['cancel', 'Cancel'],
  ['check', 'Check'],
  ['cleanup', 'Clean up'],
  ['clone', 'Clone'],
  ['complete', 'Complete'],
  ['compile', 'Compile'],
  ['deactivate', 'Deactivate'],
  ['deny', 'Deny'],
  ['disable', 'Disable'],
  ['download', 'Download'],
  ['enable', 'Enable'],
  ['evaluate', 'Evaluate'],
  ['export', 'Export'],
  ['generate', 'Generate'],
  ['import', 'Import'],
  ['initialize', 'Initialize'],
  ['lock', 'Lock'],
  ['migrate', 'Migrate'],
  ['preview', 'Preview'],
  ['promote', 'Promote'],
  ['publish', 'Publish'],
  ['purge', 'Purge'],
  ['refresh', 'Refresh'],
  ['regenerate-secret', 'Regenerate secret for'],
  ['remind', 'Send reminder for'],
  ['replay', 'Replay'],
  ['resend', 'Resend'],
  ['reset', 'Reset'],
  ['retry', 'Retry'],
  ['revoke', 'Revoke'],
  ['rotate', 'Rotate'],
  ['send-email', 'Send email to'],
  ['set-default', 'Set default'],
  ['simulate', 'Simulate'],
  ['start', 'Start'],
  ['status', 'Get status for'],
  ['submit', 'Submit'],
  ['suspend', 'Suspend'],
  ['sync', 'Sync'],
  ['test', 'Test'],
  ['unlock', 'Unlock'],
  ['validate', 'Validate'],
  ['verify', 'Verify'],
  ['withdraw', 'Withdraw'],
]);

function titleCase(value) {
  return value
    .replace(/[{}]/g, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function singular(value) {
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ses')) return value.slice(0, -2);
  if (value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
  return value;
}

function nonParameterSegments(routePath) {
  return routePath
    .split('/')
    .filter(Boolean)
    .filter((segment) => !segment.startsWith('{'));
}

function lastMeaningfulSegment(routePath) {
  const segments = nonParameterSegments(routePath).filter(
    (segment) => !['api', 'admin', 'v1', 'auth', 'user'].includes(segment)
  );
  return segments.at(-1) ?? 'resource';
}

function resourceFromPath(routePath) {
  const segments = nonParameterSegments(routePath).filter(
    (segment) => !['api', 'admin', 'v1', 'auth', 'user'].includes(segment)
  );
  const resource =
    [...segments]
      .reverse()
      .find((segment) => !actionWords.has(segment) && !['status', 'stats', 'info'].includes(segment)) ??
    lastMeaningfulSegment(routePath);
  return titleCase(singular(resource));
}

function summaryFor(method, routePath) {
  const segments = nonParameterSegments(routePath);
  const last = segments.at(-1) ?? '';
  const resource = resourceFromPath(routePath);
  const lowerMethod = method.toLowerCase();

  if (actionWords.has(last)) {
    return `${actionWords.get(last)} ${resource}.`;
  }

  if (last === 'stats' || last === 'summary') {
    return `Get ${resource} summary.`;
  }

  if (last === 'health') {
    return `Get ${resource} health.`;
  }

  if (routePath.includes('/settings/') && lowerMethod === 'get') {
    return `Get ${resource} settings.`;
  }

  if (routePath.includes('/settings/') && ['put', 'patch'].includes(lowerMethod)) {
    return `Update ${resource} settings.`;
  }

  const verb = methodVerbs[lowerMethod] ?? titleCase(method);
  const hasPathParameter = routePath.includes('{');
  if (lowerMethod === 'get' && hasPathParameter) {
    return `Get ${resource}.`;
  }
  if (lowerMethod === 'get') {
    return `List ${titleCase(lastMeaningfulSegment(routePath))}.`;
  }
  return `${verb} ${resource}.`;
}

function descriptionFor(method, routePath, tag) {
  const lowerMethod = method.toLowerCase();
  const resource = resourceFromPath(routePath).toLowerCase();
  const base = `${summaryFor(method, routePath).replace(/\.$/, '')} in the ${tag} area.`;

  if (lowerMethod === 'get') {
    return `${base} Use this operation to retrieve ${resource} data without mutating tenant state.`;
  }
  if (lowerMethod === 'delete') {
    return `${base} The operation changes tenant state and should be protected by the documented admin authorization and audit controls.`;
  }
  return `${base} The request body is JSON unless the detailed schema for this operation states otherwise.`;
}

function adminTag(routePath) {
  if (routePath.startsWith('/api/health') || routePath.startsWith('/health/')) return 'Health';
  if (routePath.includes('/me/session') || routePath.includes('/logout')) return 'Admin Session';
  if (routePath.startsWith('/api/admin/settings/')) {
    if (routePath.includes('/logging')) return 'Settings - Logging';
    if (routePath.includes('/rate-limits')) return 'Settings - Rate Limits';
    if (routePath.includes('/audit')) return 'Settings - Audit';
    if (routePath.includes('/pii-partitions')) return 'Settings - PII';
    if (routePath.includes('/oauth') || routePath.includes('/token') || routePath.includes('/introspection')) {
      return 'Settings - OAuth and Tokens';
    }
    if (routePath.includes('/error')) return 'Settings - Error Handling';
    if (routePath.includes('/shards') || routePath.includes('/cache-mode')) return 'Settings - Storage and Runtime';
    if (routePath.includes('/security') || routePath.includes('/assurance')) return 'Settings - Security';
    if (routePath.includes('/plugins')) return 'Settings - Plugins';
    if (routePath.includes('/ui-')) return 'Settings - UI';
    if (routePath.includes('/migrate')) return 'Settings - Migration';
    return 'Settings - General';
  }
  if (routePath.startsWith('/api/admin/users')) return 'Users';
  if (routePath.startsWith('/api/admin/clients')) return 'Clients';
  if (routePath.startsWith('/api/admin/tenants')) return 'Tenants';
  if (routePath.includes('/tenant-vanity-domains') || routePath.includes('/tenant-domain-mappings')) {
    return 'Tenant Domains';
  }
  if (routePath.startsWith('/api/admin/admins')) return 'Admin Users';
  if (routePath.startsWith('/api/admin/admin-roles')) return 'Admin Roles';
  if (routePath.startsWith('/api/admin/admin-attributes')) return 'Admin Attributes';
  if (routePath.startsWith('/api/admin/admin-rebac') || routePath.startsWith('/api/admin/admin-relationships')) {
    return 'Admin ReBAC';
  }
  if (routePath.startsWith('/api/admin/admin-policies')) return 'Admin Policies';
  if (routePath.startsWith('/api/admin/admin-audit-log')) return 'Admin Audit';
  if (routePath.startsWith('/api/admin/admin-access-control')) return 'Admin Access Control';
  if (routePath.startsWith('/api/admin/me/passkeys')) return 'Admin Passkeys';
  if (routePath.startsWith('/api/admin/ip-allowlist')) return 'Admin IP Allowlist';
  if (routePath.startsWith('/api/admin/approvals')) return 'Approvals';
  if (routePath.startsWith('/api/approval-artifacts')) return 'Approval Artifacts';
  if (routePath.startsWith('/api/approval-receipts')) return 'Approval Receipts';
  if (routePath.startsWith('/auth/step-up')) return 'Step-Up Authentication';
  if (routePath.startsWith('/api/admin/policies')) return 'Policy Administration';
  if (routePath.startsWith('/api/admin/rebac')) return 'ReBAC Administration';
  if (routePath.startsWith('/api/admin/organizations')) return 'Organizations';
  if (routePath.startsWith('/api/admin/roles')) return 'Roles';
  if (routePath.startsWith('/api/admin/attributes')) return 'User Attributes';
  if (routePath.startsWith('/api/admin/custom-claims')) return 'Custom Claims';
  if (routePath.includes('/consent')) return 'Consent';
  if (routePath.startsWith('/api/admin/webhooks')) return 'Webhooks';
  if (routePath.startsWith('/api/admin/jobs')) return 'Jobs';
  if (routePath.startsWith('/api/admin/diagnostic-logging')) return 'Diagnostic Logging';
  if (routePath.startsWith('/api/admin/admin-logging')) return 'Logging - Administration';
  if (routePath.startsWith('/api/admin/logging-policies')) return 'Logging - Policies';
  if (routePath.startsWith('/api/admin/destinations')) return 'Logging - Destinations';
  if (routePath.startsWith('/api/admin/notifications')) return 'Logging - Notifications';
  if (routePath.startsWith('/api/admin/storage-destinations')) return 'Storage Destinations';
  if (routePath.startsWith('/api/admin/database-connections')) return 'Database Connections';
  if (routePath.startsWith('/api/admin/machine-access')) return 'Machine Access';
  if (routePath.startsWith('/api/admin/support-ops')) return 'Support Operations';
  if (routePath.startsWith('/api/admin/plugins') || routePath.startsWith('/api/admin/platform/plugins')) {
    return 'Plugins';
  }
  if (routePath.startsWith('/api/admin/security')) return 'Security';
  if (routePath.startsWith('/api/admin/compliance')) return 'Compliance';
  if (routePath.startsWith('/api/admin/data-retention')) return 'Data Retention';
  if (routePath.startsWith('/api/admin/field-mapping')) return 'Field Mapping';
  if (routePath.startsWith('/api/admin/flows')) return 'Flows';
  if (routePath.startsWith('/api/admin/external')) return 'External Providers';
  if (routePath.startsWith('/api/admin/vc')) return 'Verifiable Credentials';
  if (routePath.startsWith('/api/admin/stats')) return 'Stats';
  if (routePath.startsWith('/api/admin/tombstones')) return 'Tombstones';
  return 'Admin Miscellaneous';
}

function tagForDoc(docName, routePath) {
  if (docName === 'admin') return adminTag(routePath);
  if (docName === 'frontendAuth') return 'Frontend Auth Discovery';
  if (docName === 'userSelfService') {
    if (routePath.includes('/data-export')) return 'User Data Export';
    return 'User Consent';
  }
  return null;
}

function tagGroupsForAdmin() {
  return [
    {
      name: 'Admin Core',
      tags: [
        'Health',
        'Admin Session',
        'Stats',
        'Users',
        'Clients',
        'Tenants',
        'Tenant Domains',
        'Organizations',
        'Roles',
        'User Attributes',
        'Custom Claims',
        'Consent',
        'Webhooks',
      ],
    },
    {
      name: 'Settings',
      tags: [
        'Settings - General',
        'Settings - Security',
        'Settings - OAuth and Tokens',
        'Settings - Storage and Runtime',
        'Settings - Logging',
        'Settings - Rate Limits',
        'Settings - Audit',
        'Settings - PII',
        'Settings - Error Handling',
        'Settings - Plugins',
        'Settings - UI',
        'Settings - Migration',
      ],
    },
    {
      name: 'Admin Governance',
      tags: [
        'Admin Access Control',
        'Admin Users',
        'Admin Roles',
        'Admin Attributes',
        'Admin ReBAC',
        'Admin Policies',
        'Admin Audit',
        'Admin Passkeys',
        'Admin IP Allowlist',
        'Approvals',
        'Approval Artifacts',
        'Approval Receipts',
        'Step-Up Authentication',
      ],
    },
    {
      name: 'Operations',
      tags: [
        'Jobs',
        'Diagnostic Logging',
        'Logging - Administration',
        'Logging - Policies',
        'Logging - Destinations',
        'Logging - Notifications',
        'Storage Destinations',
        'Database Connections',
        'Machine Access',
        'Support Operations',
        'Plugins',
        'Security',
        'Compliance',
        'Data Retention',
        'Field Mapping',
        'Flows',
        'External Providers',
        'Policy Administration',
        'ReBAC Administration',
        'Verifiable Credentials',
        'Tombstones',
        'Admin Miscellaneous',
      ],
    },
  ];
}

function ensureTags(doc) {
  const names = new Set();
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      for (const tag of operation?.tags ?? []) {
        names.add(tag);
      }
    }
  }
  doc.tags = [...names].sort().map((name) => ({ name }));
}

function refineOperations(doc, docName) {
  for (const [routePath, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) continue;

      const tag = tagForDoc(docName, routePath);
      if (tag) {
        operation.tags = [tag];
      }

      const currentSummary = operation.summary ?? '';
      if (/^(GET|POST|PUT|PATCH|DELETE)(\s|$)/.test(currentSummary) || operation['x-authrim-route-coverage']) {
        operation.summary = summaryFor(method, routePath);
      }

      const currentDescription = operation.description ?? '';
      if (!currentDescription || currentDescription.includes('Route coverage stub generated')) {
        operation.description = descriptionFor(method, routePath, operation.tags?.[0] ?? 'API');
      }
    }
  }
  ensureTags(doc);
  if (docName === 'admin') {
    doc['x-tagGroups'] = tagGroupsForAdmin();
  }
}

function createSplitDoc(source, { title, summary, description }) {
  return {
    openapi: source.openapi,
    info: {
      title,
      version: source.info.version,
      summary,
      description,
    },
    servers: source.servers,
    security: source.security,
    tags: [],
    paths: {},
    components: source.components,
  };
}

async function readDocIfExists(file) {
  try {
    return parse(await readFile(path.join(root, file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function movePaths(source, target, predicate) {
  let moved = 0;
  for (const routePath of Object.keys(source.paths ?? {})) {
    if (!predicate(routePath)) continue;
    target.paths[routePath] = source.paths[routePath];
    delete source.paths[routePath];
    moved += 1;
  }
  return moved;
}

const admin = parse(await readFile(path.join(root, docs.admin), 'utf8'));
const frontendAuth =
  (await readDocIfExists(docs.frontendAuth)) ??
  createSplitDoc(admin, {
    title: 'Authrim Frontend Auth Discovery API',
    summary: 'Login UI discovery and grant bootstrap endpoints.',
    description:
      'OpenAPI contract for frontend authentication discovery endpoints owned by the management Worker.',
  });
const userSelfService =
  (await readDocIfExists(docs.userSelfService)) ??
  createSplitDoc(admin, {
    title: 'Authrim User Self-Service API',
    summary: 'Authenticated user consent and data export endpoints.',
    description:
      'OpenAPI contract for user-facing self-service endpoints owned by the management Worker.',
  });

movePaths(admin, frontendAuth, (routePath) => routePath.startsWith('/api/auth/'));
movePaths(admin, userSelfService, (routePath) => routePath.startsWith('/api/user/'));

refineOperations(admin, 'admin');
refineOperations(frontendAuth, 'frontendAuth');
refineOperations(userSelfService, 'userSelfService');

await writeFile(path.join(root, docs.admin), stringify(admin, { lineWidth: 100 }));
await writeFile(path.join(root, docs.frontendAuth), stringify(frontendAuth, { lineWidth: 100 }));
await writeFile(path.join(root, docs.userSelfService), stringify(userSelfService, { lineWidth: 100 }));

process.stdout.write('Refined management OpenAPI navigation, summaries, and descriptions.\n');
