import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

const root = process.cwd();
const packagesDir = path.join(root, 'packages');

async function listOpenApiFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listOpenApiFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.openapi.yaml')) {
      files.push(fullPath);
    }
  }

  return files;
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

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return refs;
  }

  if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string') {
      refs.push(value.$ref);
    }
    for (const child of Object.values(value)) {
      collectRefs(child, refs);
    }
  }

  return refs;
}

function collectPathParameterNames(route) {
  return [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function resolveParameter(document, parameter) {
  if (parameter?.$ref?.startsWith('#/')) {
    return resolvePointer(document, parameter.$ref.slice(1));
  }
  return parameter;
}

function parameterKey(document, parameter) {
  const resolved = resolveParameter(document, parameter);
  if (!resolved?.name || !resolved?.in) {
    return null;
  }
  return `${resolved.in}:${resolved.name}`;
}

function collectDeclaredPathParameters(document, pathItem, operation) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) => resolveParameter(document, parameter))
    .filter((parameter) => parameter?.in === 'path')
    .map((parameter) => parameter.name);
}

function assertNoDuplicateParameters(file, document, route, method, pathItem, operation) {
  const seen = new Map();
  for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const key = parameterKey(document, parameter);
    if (!key) {
      continue;
    }
    assert(
      !seen.has(key),
      `${file}: ${method.toUpperCase()} ${route} duplicate parameter ${key}; already declared at ${seen.get(key)}`
    );
    seen.set(key, parameter.$ref ?? `${parameter.in}:${parameter.name}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateDocument(file, document) {
  assert(document && typeof document === 'object', `${file}: document must be an object`);
  assert(document.openapi === '3.2.0', `${file}: openapi must be 3.2.0`);
  assert(document.info?.title, `${file}: missing info.title`);
  assert(document.info?.version, `${file}: missing info.version`);
  assert(document.paths && typeof document.paths === 'object', `${file}: missing paths`);
  assert(Object.keys(document.paths).length > 0, `${file}: paths must not be empty`);

  const operationIds = new Map();
  for (const [route, pathItem] of Object.entries(document.paths)) {
    assert(route.startsWith('/'), `${file}: path must start with /: ${route}`);
    assert(
      pathItem && typeof pathItem === 'object',
      `${file}: path item must be an object: ${route}`
    );

    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      assert(
        operation.responses && Object.keys(operation.responses).length > 0,
        `${file}: ${method.toUpperCase()} ${route} must define responses`
      );

      if (operation.operationId) {
        assert(
          !operationIds.has(operation.operationId),
          `${file}: duplicate operationId ${operation.operationId} for ${method.toUpperCase()} ${route}; already used by ${operationIds.get(operation.operationId)}`
        );
        operationIds.set(operation.operationId, `${method.toUpperCase()} ${route}`);
      }

      assertNoDuplicateParameters(file, document, route, method, pathItem, operation);

      const declaredPathParameters = new Set(
        collectDeclaredPathParameters(document, pathItem, operation)
      );
      for (const parameterName of collectPathParameterNames(route)) {
        assert(
          declaredPathParameters.has(parameterName),
          `${file}: ${method.toUpperCase()} ${route} missing path parameter ${parameterName}`
        );
      }
    }
  }

  for (const ref of collectRefs(document)) {
    if (!ref.startsWith('#/')) {
      continue;
    }
    assert(resolvePointer(document, ref.slice(1)) !== undefined, `${file}: unresolved ${ref}`);
  }
}

const files = (await listOpenApiFiles(packagesDir)).sort();
assert(files.length > 0, 'No OpenAPI files found under packages/*/openapi');

for (const file of files) {
  const relative = path.relative(root, file);
  const document = parse(await readFile(file, 'utf8'));
  validateDocument(relative, document);
  process.stdout.write(`${relative} ${Object.keys(document.paths).length} paths\n`);
}
