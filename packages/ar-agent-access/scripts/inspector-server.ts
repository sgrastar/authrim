import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createInspectorFixtureMcpServer } from './mcp-conformance-fixture';

const server = createInspectorFixtureMcpServer();
await server.connect(new StdioServerTransport());
