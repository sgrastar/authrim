import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

const root = process.cwd();

const packageSpecs = [
  {
    name: 'ar-auth',
    sourceFiles: [
      'packages/ar-auth/src/index.ts',
      {
        file: 'packages/ar-auth/src/flow-engine/flow-api.ts',
        receiverPrefixes: {
          flowApi: '/api/flow',
        },
      },
      {
        file: 'packages/ar-auth/src/setup.ts',
        receiverPrefixes: {
          setupApp: '',
        },
      },
      {
        file: 'packages/ar-auth/src/admin-setup-api.ts',
        receiverPrefixes: {
          adminSetupApiApp: '',
        },
      },
    ],
    openapiFiles: ['packages/ar-auth/openapi/auth.openapi.yaml'],
  },
  {
    name: 'ar-async',
    sourceFiles: ['packages/ar-async/src/index.ts'],
    openapiFiles: ['packages/ar-async/openapi/async.openapi.yaml'],
  },
  {
    name: 'ar-discovery',
    sourceFiles: ['packages/ar-discovery/src/index.ts'],
    openapiFiles: ['packages/ar-discovery/openapi/discovery.openapi.yaml'],
  },
  {
    name: 'ar-token',
    sourceFiles: ['packages/ar-token/src/index.ts'],
    openapiFiles: ['packages/ar-token/openapi/token.openapi.yaml'],
  },
  {
    name: 'ar-agent-access',
    sourceFiles: [],
    declaredRoutes: [
      { method: 'GET', path: '/api/health' },
      { method: 'GET', path: '/health/live' },
      { method: 'GET', path: '/health/ready' },
      { method: 'GET', path: '/mcp' },
      { method: 'POST', path: '/mcp' },
      { method: 'DELETE', path: '/mcp' },
    ],
    openapiFiles: ['packages/ar-agent-access/openapi/agent-access.openapi.yaml'],
  },
  {
    name: 'ar-userinfo',
    sourceFiles: [
      { file: 'packages/ar-userinfo/src/index.ts' },
      {
        file: 'packages/ar-userinfo/src/protected-customer-profile.ts',
        receiverPrefixes: {
          router: '/api/protected/customer-profiles',
        },
      },
    ],
    openapiFiles: ['packages/ar-userinfo/openapi/userinfo.openapi.yaml'],
  },
  {
    name: 'ar-vc',
    sourceFiles: ['packages/ar-vc/src/index.ts'],
    openapiFiles: ['packages/ar-vc/openapi/vc.openapi.yaml'],
  },
  {
    name: 'ar-saml',
    sourceFiles: ['packages/ar-saml/src/index.ts'],
    openapiFiles: ['packages/ar-saml/openapi/saml.openapi.yaml'],
  },
  {
    name: 'ar-policy',
    sourceFiles: [
      {
        file: 'packages/ar-policy/src/index.ts',
        receiverPrefixes: {
          policyRoutes: '/api/policy',
          rebacRoutes: '/api/rebac',
        },
      },
      {
        file: 'packages/ar-policy/src/routes/check.ts',
        receiverPrefixes: {
          checkRoutes: '/api/check',
        },
      },
      {
        file: 'packages/ar-policy/src/routes/subscribe.ts',
        receiverPrefixes: {
          subscribeRoutes: '/api/check',
        },
      },
    ],
    openapiFiles: ['packages/ar-policy/openapi/policy.openapi.yaml'],
  },
  {
    name: 'ar-management',
    sourceFiles: [
      { file: 'packages/ar-management/src/index.ts' },
      {
        file: 'packages/ar-management/src/scim.ts',
        receiverPrefixes: {
          app: '/scim/v2',
        },
      },
      {
        file: 'packages/ar-management/src/routes/settings-v2/index.ts',
        receiverPrefixes: {
          settingsV2: '/api/admin',
        },
      },
      {
        file: 'packages/ar-management/src/routes/settings-v2/migrate.ts',
        receiverPrefixes: {
          migrateRouter: '/api/admin/settings',
        },
      },
      {
        file: 'packages/ar-management/src/routes/policy/index.ts',
        receiverPrefixes: {
          policyRouter: '/api/admin',
        },
      },
      { file: 'packages/ar-management/src/routes/admin-management/index.ts' },
      {
        file: 'packages/ar-management/src/routes/admin-management/admin-access-control.ts',
        receiverPrefixes: {
          adminAccessControlRouter: '/api/admin/admin-access-control',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/admin-abac.ts',
        receiverPrefixes: {
          adminAbacRouter: '/api/admin',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/admin-audit.ts',
        receiverPrefixes: {
          adminAuditRouter: '/api/admin/admin-audit-log',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/admin-policies.ts',
        receiverPrefixes: {
          adminPoliciesRouter: '/api/admin',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/admin-rebac.ts',
        receiverPrefixes: {
          adminRebacRouter: '/api/admin',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/admins.ts',
        receiverPrefixes: {
          adminUsersRouter: '/api/admin/admins',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/admin-roles.ts',
        receiverPrefixes: {
          adminRolesRouter: '/api/admin/admin-roles',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/admin-approvals.ts',
        receiverPrefixes: {
          adminApprovalsRouter: '/api/admin/approvals',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/database-connections.ts',
        receiverPrefixes: {
          databaseConnectionsRouter: '/api/admin/database-connections',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/ip-allowlist.ts',
        receiverPrefixes: {
          ipAllowlistRouter: '/api/admin/ip-allowlist',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/logging-control.ts',
        receiverPrefixes: {
          destinationsRouter: '/api/admin/destinations',
          loggingPoliciesRouter: '/api/admin/logging-policies',
          adminLoggingRouter: '/api/admin/admin-logging',
          notificationsRouter: '/api/admin/notifications',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/machine-access.ts',
        receiverPrefixes: {
          machineAccessRouter: '/api/admin/machine-access',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/my-passkeys.ts',
        receiverPrefixes: {
          myPasskeysRouter: '/api/admin/me/passkeys',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/operational-logs.ts',
        receiverPrefixes: {
          operationalLogsRouter: '/api/admin/operational-logs',
        },
      },
      {
        file: 'packages/ar-management/src/routes/admin-management/storage-destinations.ts',
        receiverPrefixes: {
          storageDestinationsRouter: '/api/admin/storage-destinations',
        },
      },
      {
        file: 'packages/ar-management/src/routes/approval-artifacts.ts',
        receiverPrefixes: {
          approvalArtifactsRouter: '/api/approval-artifacts',
        },
      },
      {
        file: 'packages/ar-management/src/routes/approval-receipts.ts',
        receiverPrefixes: {
          approvalReceiptsRouter: '/api/approval-receipts',
        },
      },
      {
        file: 'packages/ar-management/src/routes/step-up.ts',
        receiverPrefixes: {
          stepUpRouter: '/auth/step-up',
        },
      },
      {
        file: 'packages/ar-management/src/support-ops.ts',
        receiverPrefixes: {
          supportOpsRouter: '/api/admin/support-ops',
        },
      },
      { file: 'packages/ar-management/src/routes/settings/webhooks.ts' },
      {
        file: 'packages/ar-management/src/routes/diagnostic-logging/index.ts',
        receiverPrefixes: {
          diagnosticLoggingRouter: '/api/admin/diagnostic-logging',
        },
      },
      {
        file: 'packages/ar-management/src/routes/diagnostic-logging/ingest.ts',
        receiverPrefixes: {
          app: '/api/v1/diagnostic-logs/ingest',
        },
      },
      {
        file: 'packages/ar-management/src/routes/diagnostic-logging/export-logs.ts',
        receiverPrefixes: {
          app: '/api/admin/diagnostic-logging/export',
        },
      },
    ],
    openapiFiles: [
      'packages/ar-management/openapi/admin.openapi.yaml',
      'packages/ar-management/openapi/frontend-auth.openapi.yaml',
      'packages/ar-management/openapi/oauth-management.openapi.yaml',
      'packages/ar-management/openapi/scim.openapi.yaml',
      'packages/ar-management/openapi/user-self-service.openapi.yaml',
    ],
  },
];

const ignoredSourcePathPatterns = [
  /^\/_internal\//,
  /^\/internal\//,
  /^\/api\/internal\//,
  /^\/api\/admin\/test\//,
  /^\/api\/ciba\/test$/,
  /^\/logout-error$/,
  /^\/logged-out$/,
];

function normalizeRoute(route) {
  return route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function joinRoutes(prefix, route) {
  if (!prefix) {
    return route;
  }
  if (route === '/') {
    return prefix;
  }
  return `${prefix.replace(/\/$/, '')}/${route.replace(/^\//, '')}`;
}

function collectRoutesFromSource(source, receiverPrefixes = {}) {
  const routes = [];
  const literalRoutePattern =
    /\b(app|[A-Za-z0-9_]+Router|[A-Za-z0-9_]+App|flowApi|router|policyRoutes|rebacRoutes|checkRoutes|subscribeRoutes|settingsV2|diagnosticLoggingRouter|stepUpRouter|ingestRouter|exportLogsRouter)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = literalRoutePattern.exec(source))) {
    const receiver = match[1];
    const method = match[2].toUpperCase();
    const route = normalizeRoute(joinRoutes(receiverPrefixes[receiver], match[3]));
    routes.push({ method, path: route });
  }
  return routes;
}

async function collectSourceRoutes(files) {
  const routes = new Map();
  for (const entry of files) {
    const file = typeof entry === 'string' ? entry : entry.file;
    const receiverPrefixes = typeof entry === 'string' ? {} : (entry.receiverPrefixes ?? {});
    const source = await readFile(path.join(root, file), 'utf8');
    for (const route of collectRoutesFromSource(source, receiverPrefixes)) {
      if (ignoredSourcePathPatterns.some((pattern) => pattern.test(route.path))) {
        continue;
      }
      routes.set(`${route.method} ${route.path}`, route);
    }
  }
  return [...routes.values()].sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`)
  );
}

async function collectOpenApiRoutes(files) {
  const routes = new Map();
  for (const file of files) {
    const doc = parse(await readFile(path.join(root, file), 'utf8'));
    for (const [routePath, pathItem] of Object.entries(doc.paths ?? {})) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (pathItem?.[method]) {
          const route = { method: method.toUpperCase(), path: routePath };
          routes.set(`${route.method} ${route.path}`, route);
        }
      }
    }
  }
  return routes;
}

let hasMissing = false;
const report = [];
for (const spec of packageSpecs) {
  const sourceRoutes = [
    ...(await collectSourceRoutes(spec.sourceFiles)),
    ...(spec.declaredRoutes ?? []),
  ];
  const openApiRoutes = await collectOpenApiRoutes(spec.openapiFiles);
  const missing = sourceRoutes.filter(
    (route) => !openApiRoutes.has(`${route.method} ${route.path}`)
  );
  report.push({
    name: spec.name,
    implemented: sourceRoutes.length,
    documented: openApiRoutes.size,
    missing,
  });
  hasMissing ||= missing.length > 0;
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const item of report) {
    process.stdout.write(
      `${item.name}: implemented=${item.implemented} documented=${item.documented} missing=${item.missing.length}\n`
    );
    for (const route of item.missing) {
      process.stdout.write(`  ${route.method} ${route.path}\n`);
    }
  }
}

if (process.argv.includes('--fail-on-missing') && hasMissing) {
  process.exitCode = 1;
}
