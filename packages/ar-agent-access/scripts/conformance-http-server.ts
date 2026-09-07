import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createInspectorFixtureMcpServer } from './mcp-conformance-fixture';

const MAX_BODY_BYTES = 1024 * 1024;

const httpServer = createServer(async (request, response) => {
  if (request.url !== '/mcp') {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.writeHead(405).end();
    return;
  }

  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createInspectorFixtureMcpServer();
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error',
          },
        })
      );
    }
  }
});

httpServer.listen(0, '127.0.0.1', () => {
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind the MCP conformance fixture');
  }
  console.log(`READY http://127.0.0.1:${address.port}/mcp`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => httpServer.close(() => process.exit(0)));
}
