import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { runWithReplicationWriteEffects } from '@authrim/ar-lib-core/services/deployment-replication/write-effects';
import { createDynamoStateClient } from '../storage/dynamodb-state';

describe('DynamoDB replication writer outcome observation', () => {
  it.each([
    { name: 'ConditionalCheckFailedException', status: 400, uncertain: false },
    { name: 'TransactionCanceledException', status: 400, uncertain: false },
    { name: 'TransactionInProgressException', status: 400, uncertain: true },
    { name: 'InternalServerError', status: 500, uncertain: true },
  ])('classifies $name without replaying any mutation', async ({ name, status, uncertain }) => {
    let attempts = 0;
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'local-only', secretAccessKey: 'local-only' },
      requestHandler: {
        handle: async () => {
          attempts += 1;
          return {
            response: {
              statusCode: status,
              headers: { 'content-type': 'application/x-amz-json-1.0' },
              body: new TextEncoder().encode(
                JSON.stringify({ __type: name, message: 'private payload' })
              ),
            },
          };
        },
      },
    });
    try {
      const request = runWithReplicationWriteEffects(async () => {
        await client
          .send(new PutItemCommand({ TableName: 'local-table', Item: { pk: { S: 'local-key' } } }))
          .catch(() => undefined);
        return 'handled';
      });
      if (uncertain) await expect(request).rejects.toThrow('replication_writer_outcome_unknown');
      else await expect(request).resolves.toBe('handled');
      expect(attempts).toBe(1);
    } finally {
      client.destroy();
    }
  });

  it('retains an unknown transport mutation even when the application returns a client error', async () => {
    let attempts = 0;
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'local-only', secretAccessKey: 'local-only' },
      requestHandler: {
        handle: async () => {
          attempts += 1;
          throw Object.assign(new Error('private payload'), { code: 'ECONNRESET' });
        },
      },
    });
    try {
      await expect(
        runWithReplicationWriteEffects(async () => {
          await client
            .send(
              new PutItemCommand({ TableName: 'local-table', Item: { pk: { S: 'local-key' } } })
            )
            .catch(() => undefined);
          return new Response('handled', { status: 400 });
        })
      ).rejects.toThrow('replication_writer_outcome_unknown');
      expect(attempts).toBe(1);
    } finally {
      client.destroy();
    }
  });
});
