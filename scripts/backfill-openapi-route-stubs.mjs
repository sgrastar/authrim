import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';

const execFileAsync = promisify(execFile);
const root = process.cwd();

const targetFiles = {
  'ar-auth': 'packages/ar-auth/openapi/auth.openapi.yaml',
  'ar-async': 'packages/ar-async/openapi/async.openapi.yaml',
  'ar-discovery': 'packages/ar-discovery/openapi/discovery.openapi.yaml',
  'ar-token': 'packages/ar-token/openapi/token.openapi.yaml',
  'ar-userinfo': 'packages/ar-userinfo/openapi/userinfo.openapi.yaml',
  'ar-vc': 'packages/ar-vc/openapi/vc.openapi.yaml',
  'ar-saml': 'packages/ar-saml/openapi/saml.openapi.yaml',
  'ar-policy': 'packages/ar-policy/openapi/policy.openapi.yaml',
};

function targetForRoute(packageName, routePath) {
  if (packageName !== 'ar-management') {
    return targetFiles[packageName];
  }

  if (routePath.startsWith('/scim/v2')) {
    return 'packages/ar-management/openapi/scim.openapi.yaml';
  }

  if (routePath.startsWith('/api/auth/')) {
    return 'packages/ar-management/openapi/frontend-auth.openapi.yaml';
  }

  if (routePath.startsWith('/api/user/')) {
    return 'packages/ar-management/openapi/user-self-service.openapi.yaml';
  }

  if (
    routePath === '/register' ||
    routePath.startsWith('/clients/') ||
    routePath.startsWith('/introspect') ||
    routePath.startsWith('/revoke') ||
    routePath.startsWith('/me/devices')
  ) {
    return 'packages/ar-management/openapi/oauth-management.openapi.yaml';
  }

  return 'packages/ar-management/openapi/admin.openapi.yaml';
}

function routeTag(packageName, routePath) {
  if (packageName === 'ar-auth') {
    if (routePath.includes('/direct/')) return 'Direct Auth';
    if (routePath.includes('/dids')) return 'DID Auth';
    if (routePath.includes('/invitations')) return 'Invitations';
    if (routePath.includes('/registration-fields')) return 'Registration';
    if (routePath.includes('login-challenge')) return 'Login Challenges';
    return 'Auth';
  }
  if (packageName === 'ar-userinfo') return 'Customer Profiles';
  if (packageName === 'ar-vc') return routePath.startsWith('/health') ? 'Health' : 'Status Lists';
  if (packageName === 'ar-saml') {
    if (routePath.startsWith('/api/admin')) return 'SAML Admin';
    return 'SAML IdP';
  }
  if (packageName === 'ar-policy') {
    if (routePath.startsWith('/api/rebac')) return 'ReBAC';
    if (routePath.includes('/subscribe')) return 'Subscriptions';
    return 'Policy';
  }
  if (packageName === 'ar-management') {
    if (routePath.startsWith('/scim/v2')) return 'SCIM';
    if (routePath.startsWith('/api/user')) return 'User Self-Service';
    if (routePath.startsWith('/api/auth')) return 'Frontend Auth Discovery';
    if (routePath.includes('/settings')) return 'Settings';
    if (routePath.includes('/admin-')) return 'Admin Management';
    return 'Admin Route Coverage';
  }
  return 'Route Coverage';
}

function operationId(method, routePath) {
  const suffix = routePath
    .replace(/^\//, '')
    .replace(/\{([^}]+)\}/g, 'by-$1')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-([a-zA-Z0-9])/g, (_, char) => char.toUpperCase());
  return `${method.toLowerCase()}${suffix ? suffix[0].toUpperCase() + suffix.slice(1) : 'Root'}`;
}

function titleFromPath(method, routePath) {
  return `${method} ${routePath}`;
}

function responseRef(doc) {
  const responses = doc.components?.responses ?? {};
  if (responses.Any) return '#/components/responses/Any';
  if (responses.Ok) return '#/components/responses/Ok';
  if (responses.Json) return '#/components/responses/Json';
  if (responses.Success) return '#/components/responses/Success';

  doc.components ??= {};
  doc.components.responses ??= {};
  doc.components.responses.GeneratedAny = {
    description: 'Successful response.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  };
  return '#/components/responses/GeneratedAny';
}

function requestBodyRef(doc) {
  const requestBodies = doc.components?.requestBodies ?? {};
  if (requestBodies.JsonObject) return '#/components/requestBodies/JsonObject';

  doc.components ??= {};
  doc.components.requestBodies ??= {};
  doc.components.requestBodies.GeneratedJsonObject = {
    required: false,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  };
  return '#/components/requestBodies/GeneratedJsonObject';
}

function errorResponseRef(doc) {
  const responses = doc.components?.responses ?? {};
  if (responses.Error) return '#/components/responses/Error';
  if (responses.OAuthError) return '#/components/responses/OAuthError';
  return null;
}

function parameterName(segment) {
  return segment.slice(1, -1);
}

function decodePointerPart(part) {
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolvePointer(document, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .map(decodePointerPart)
    .reduce((value, key) => (value == null ? undefined : value[key]), document);
}

function resolveParameter(doc, parameter) {
  if (parameter?.$ref?.startsWith('#/')) {
    return resolvePointer(doc, parameter.$ref.slice(1));
  }
  return parameter;
}

function parameterKey(doc, parameter) {
  const resolved = resolveParameter(doc, parameter);
  if (!resolved?.name || !resolved?.in) {
    return null;
  }
  return `${resolved.in}:${resolved.name}`;
}

function pathParameters(routePath) {
  return routePath
    .split('/')
    .filter((segment) => /^\{[^}]+\}$/.test(segment))
    .map((segment) => ({
      name: parameterName(segment),
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
}

function declaredPathParameterNames(doc, pathItem, operation) {
  return new Set(
    [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
      .map((parameter) => resolveParameter(doc, parameter))
      .filter((parameter) => parameter?.in === 'path')
      .map((parameter) => parameter.name)
  );
}

function dedupeOperationParameters(doc, pathItem, operation) {
  if (!operation.parameters) {
    return 0;
  }

  const pathItemKeys = new Set(
    (pathItem.parameters ?? []).map((parameter) => parameterKey(doc, parameter)).filter(Boolean)
  );
  const operationKeys = new Set();
  const nextParameters = [];
  let removed = 0;

  for (const parameter of operation.parameters) {
    const key = parameterKey(doc, parameter);
    if (key && (pathItemKeys.has(key) || operationKeys.has(key))) {
      removed += 1;
      continue;
    }
    if (key) {
      operationKeys.add(key);
    }
    nextParameters.push(parameter);
  }

  if (removed > 0) {
    if (nextParameters.length > 0) {
      operation.parameters = nextParameters;
    } else {
      delete operation.parameters;
    }
  }

  return removed;
}

function ensurePathParameters(doc) {
  let changed = 0;
  for (const [routePath, pathItem] of Object.entries(doc.paths ?? {})) {
    const expectedParameters = pathParameters(routePath);
    if (expectedParameters.length === 0) {
      continue;
    }

    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      changed += dedupeOperationParameters(doc, pathItem, operation);

      const declaredNames = declaredPathParameterNames(doc, pathItem, operation);
      const missingParameters = expectedParameters.filter(
        (parameter) => !declaredNames.has(parameter.name)
      );
      if (missingParameters.length === 0) {
        continue;
      }

      operation.parameters ??= [];
      operation.parameters.push(...missingParameters);
      changed += missingParameters.length;
    }
  }
  return changed;
}

function ensureTag(doc, tagName) {
  doc.tags ??= [];
  if (!doc.tags.some((tag) => tag.name === tagName)) {
    doc.tags.push({ name: tagName });
  }
}

function ensureOperation(doc, packageName, route) {
  doc.paths ??= {};
  doc.paths[route.path] ??= {};
  const method = route.method.toLowerCase();
  if (doc.paths[route.path][method]) {
    return false;
  }

  const tag = routeTag(packageName, route.path);
  ensureTag(doc, tag);

  const operation = {
    tags: [tag],
    operationId: operationId(route.method, route.path),
    summary: titleFromPath(route.method, route.path),
    description:
      'Route coverage stub generated from the Worker route table. Replace this with a detailed request and response contract when changing this API.',
    'x-authrim-route-coverage': 'inferred-from-source',
    responses: {
      200: {
        $ref: responseRef(doc),
      },
    },
  };

  const params = pathParameters(route.path);
  if (params.length > 0) {
    operation.parameters = params;
  }

  if (['post', 'put', 'patch'].includes(method)) {
    operation.requestBody = {
      $ref: requestBodyRef(doc),
    };
  }

  const errorRef = errorResponseRef(doc);
  if (errorRef) {
    operation.responses['400'] = { $ref: errorRef };
    operation.responses['401'] = { $ref: errorRef };
    operation.responses['403'] = { $ref: errorRef };
  }

  doc.paths[route.path][method] = operation;
  return true;
}

const { stdout } = await execFileAsync(process.execPath, [
  'scripts/openapi-route-inventory.mjs',
  '--json',
]);
const report = JSON.parse(stdout);
const docs = new Map();
let added = 0;
let fixedPathParameters = 0;

for (const target of [
  ...Object.values(targetFiles),
  'packages/ar-management/openapi/admin.openapi.yaml',
  'packages/ar-management/openapi/frontend-auth.openapi.yaml',
  'packages/ar-management/openapi/oauth-management.openapi.yaml',
  'packages/ar-management/openapi/scim.openapi.yaml',
  'packages/ar-management/openapi/user-self-service.openapi.yaml',
]) {
  try {
    docs.set(target, parse(await readFile(path.join(root, target), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

for (const packageReport of report) {
  for (const route of packageReport.missing) {
    const target = targetForRoute(packageReport.name, route.path);
    if (!target) {
      continue;
    }
    const doc = docs.get(target);
    if (ensureOperation(doc, packageReport.name, route)) {
      added += 1;
    }
  }
}

for (const doc of docs.values()) {
  fixedPathParameters += ensurePathParameters(doc);
}

for (const [target, doc] of docs) {
  await writeFile(path.join(root, target), stringify(doc, { lineWidth: 100 }));
}

process.stdout.write(
  `Added ${added} OpenAPI route coverage operations and fixed ${fixedPathParameters} path parameter declarations.\n`
);
