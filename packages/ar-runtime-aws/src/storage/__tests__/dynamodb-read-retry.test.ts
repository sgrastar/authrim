import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  TransactGetItemsCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { createDynamoStateClient } from '../dynamodb-state';
import { installSyntheticSpStateDiagnostics } from '../../rehearsal/browser-sp-diagnostics';

const credentials = { accessKeyId: 'localtest', secretAccessKey: 'localtest' };
const input = {
  TableName: 'test-state',
  Key: { pk: { S: 'bound-key' }, sk: { S: 'STATE' } },
  ConsistentRead: true,
};
const response = (body: unknown = { Item: input.Key }, statusCode = 200) => ({
  response: {
    statusCode,
    headers: { 'content-type': 'application/x-amz-json-1.0' },
    body: Readable.from([JSON.stringify(body)]),
  },
});
const transportError = (code: string) =>
  Object.assign(new Error('private transport details'), { code });

describe('bounded DynamoDB GetItem transport retry', () => {
  it.each(['EPIPE', 'ECONNRESET'])(
    'retries %s once, preserving serialized key/consistency and signing, without a failure log',
    async (code) => {
      const requests: Array<{ body: unknown; signed: boolean }> = [];
      const client = createDynamoStateClient({
        region: 'ap-northeast-1',
        credentials,
        requestHandler: {
          handle: async (request: { body?: unknown; headers: Record<string, string> }) => {
            requests.push({
              body: JSON.parse(String(request.body)) as unknown,
              signed: String(request.headers.authorization).startsWith('AWS4-HMAC-SHA256 '),
            });
            if (requests.length === 1) throw transportError(code);
            return response();
          },
        },
      });
      const lines: string[] = [];
      installSyntheticSpStateDiagnostics(client, (line) => lines.push(line))();
      try {
        expect((await client.send(new GetItemCommand(input))).Item).toEqual(input.Key);
        expect(requests).toEqual([
          { body: input, signed: true },
          { body: input, signed: true },
        ]);
        expect(lines).toEqual([]);
      } finally {
        client.destroy();
      }
    }
  );
  it.each(['EPIPE', 'ECONNRESET'])(
    'returns the second %s unchanged and logs only one final failure',
    async (code) => {
      let attempts = 0;
      const first = transportError(code),
        second = transportError(code);
      const client = createDynamoStateClient({
        region: 'ap-northeast-1',
        credentials,
        requestHandler: {
          handle: async () => {
            attempts++;
            throw attempts === 1 ? first : second;
          },
        },
      });
      const lines: string[] = [];
      installSyntheticSpStateDiagnostics(client, (line) => lines.push(line))();
      try {
        await expect(client.send(new GetItemCommand(input))).rejects.toBe(second);
        expect(attempts).toBe(2);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain('private transport details');
      } finally {
        client.destroy();
      }
    }
  );
  it('returns a different second error without attempting a third request', async () => {
    let attempts = 0;
    const second = Object.assign(new Error('private'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
    });
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials,
      requestHandler: {
        handle: async () => {
          attempts++;
          throw attempts === 1 ? transportError('EPIPE') : second;
        },
      },
    });
    try {
      await expect(client.send(new GetItemCommand(input))).rejects.toBe(second);
      expect(attempts).toBe(2);
    } finally {
      client.destroy();
    }
  });
  it.each([
    [
      'PutItem',
      (client: DynamoDBClient) =>
        client.send(new PutItemCommand({ TableName: input.TableName, Item: input.Key })),
    ],
    [
      'UpdateItem',
      (client: DynamoDBClient) =>
        client.send(
          new UpdateItemCommand({
            ...input,
            UpdateExpression: 'SET x=:x',
            ExpressionAttributeValues: { ':x': { S: 'value' } },
          })
        ),
    ],
    [
      'TransactWriteItems',
      (client: DynamoDBClient) =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: [{ Put: { TableName: input.TableName, Item: input.Key } }],
          })
        ),
    ],
    [
      'TransactGetItems',
      (client: DynamoDBClient) =>
        client.send(
          new TransactGetItemsCommand({
            TransactItems: [{ Get: { TableName: input.TableName, Key: input.Key } }],
          })
        ),
    ],
    [
      'Query',
      (client: DynamoDBClient) =>
        client.send(
          new QueryCommand({
            TableName: input.TableName,
            KeyConditionExpression: 'pk=:pk',
            ExpressionAttributeValues: { ':pk': { S: 'bound-key' } },
          })
        ),
    ],
  ] as const)('does not add retries to %s', async (_name, command) => {
    let attempts = 0;
    const error = transportError('EPIPE');
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials,
      requestHandler: {
        handle: async () => {
          attempts++;
          throw error;
        },
      },
    });
    try {
      await expect(command(client)).rejects.toBe(error);
      expect(attempts).toBe(1);
    } finally {
      client.destroy();
    }
  });
  it.each([
    { name: 'ThrottlingException' },
    { name: 'ValidationException' },
    { name: 'ConditionalCheckFailedException' },
    { code: 'ETIMEDOUT' },
    { name: 'AbortError', code: 'EPIPE' },
    { code: { toString: (): string => 'EPIPE' } },
    { code: 'EPIPE', $response: { statusCode: 403 } },
  ])('does not replay other errors: %j', async (fields) => {
    let attempts = 0;
    const error = Object.assign(new Error('private'), fields);
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials,
      requestHandler: {
        handle: async () => {
          attempts++;
          throw error;
        },
      },
    });
    try {
      await expect(client.send(new GetItemCommand(input))).rejects.toBe(error);
      expect(attempts).toBe(1);
    } finally {
      client.destroy();
    }
  });
  it.each([
    ['AccessDeniedException', 403],
    ['ValidationException', 400],
  ] as const)(
    'does not retry a real SDK %s response carrying transport-like code',
    async (name, status) => {
      let attempts = 0;
      const client = createDynamoStateClient({
        region: 'ap-northeast-1',
        credentials,
        requestHandler: {
          handle: async () => {
            attempts++;
            return response({ __type: name, message: 'private', code: 'EPIPE' }, status);
          },
        },
      });
      try {
        await expect(client.send(new GetItemCommand(input))).rejects.toMatchObject({
          name,
          code: 'EPIPE',
          $metadata: { httpStatusCode: status },
        });
        expect(attempts).toBe(1);
      } finally {
        client.destroy();
      }
    }
  );
  it('bounds concurrent reads independently', async () => {
    const counts = new Map<string, number>();
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials,
      requestHandler: {
        handle: async (request: { body?: unknown; headers: Record<string, string> }) => {
          const key = (JSON.parse(String(request.body)) as { Key: { pk: { S: string } } }).Key.pk.S;
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          if (count === 1) throw transportError('ECONNRESET');
          return response();
        },
      },
    });
    try {
      await Promise.all(
        ['one', 'two'].map((key) =>
          client.send(new GetItemCommand({ ...input, Key: { ...input.Key, pk: { S: key } } }))
        )
      );
      expect(Object.fromEntries(counts)).toEqual({ one: 2, two: 2 });
    } finally {
      client.destroy();
    }
  });
  it.each(['already', 'between'] as const)(
    'does not make a network attempt after abort: %s',
    async (mode) => {
      let requests = 0;
      const server = createServer((request, _response) => {
        requests++;
        request.socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('local_server_invalid');
      const controller = new AbortController();
      const client = createDynamoStateClient({
        region: 'ap-northeast-1',
        credentials,
        endpoint: `http://127.0.0.1:${address.port}`,
      });
      if (mode === 'already') controller.abort();
      else
        client.middlewareStack.add(
          (next) => async (args) => {
            try {
              return await next(args);
            } catch (error) {
              controller.abort();
              throw error;
            }
          },
          { step: 'initialize', priority: 'low', name: 'abortAfterFirstTransportFailure' }
        );
      try {
        await expect(
          client.send(new GetItemCommand(input), { abortSignal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests).toBe(mode === 'already' ? 0 : 1);
      } finally {
        client.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
