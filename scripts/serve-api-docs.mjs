import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const defaultPort = 4173;
const portArgIndex = process.argv.indexOf('--port');
const port =
  portArgIndex >= 0 && process.argv[portArgIndex + 1]
    ? Number(process.argv[portArgIndex + 1])
    : Number(process.env.PORT ?? defaultPort);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.yaml', 'application/yaml; charset=utf-8'],
  ['.yml', 'application/yaml; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

function resolveRequestPath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const relativePath = decoded === '/' ? 'docs/api/index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relativePath);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return resolved;
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
  const resolved = resolveRequestPath(url.pathname);
  if (!resolved) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    let target = resolved;
    const info = await stat(target);
    if (info.isDirectory()) {
      target = path.join(target, 'index.html');
    }

    const targetInfo = await stat(target);
    if (!targetInfo.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(target)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  const scriptPath = path.relative(root, fileURLToPath(import.meta.url));
  process.stdout.write(`${scriptPath} serving http://127.0.0.1:${port}/docs/api/\n`);
});
