import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { installSyntheticSpStateDiagnostics } from './browser-sp-diagnostics';
import { createDynamoStateClient } from '../storage/dynamodb-state';

const SECRET = 'DO_NOT_LOG_PRIVATE_TEST_VALUE';
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OUTPUT_KEYS = ['timestamp', 'level', 'event', 'stage', 'errorClass'];
function fixture(error?: Error, failWriter = false) {
  let attempts = 0;
  const lines: string[] = [];
  const client = createDynamoStateClient({
    region: 'ap-northeast-1',
    credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
    requestHandler: {
      handle: async () => {
        attempts++;
        if (error) throw error;
        return {
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/x-amz-json-1.0' },
            body: Readable.from([JSON.stringify({ Item: { pk: { S: SECRET } } })]),
          },
        };
      },
    },
  });
  const markWarm = installSyntheticSpStateDiagnostics(client, (line) => {
    if (failWriter) throw new Error(SECRET);
    lines.push(line);
  });
  const parameters = { TableName: SECRET, Key: { pk: { S: SECRET }, sk: { S: SECRET } } };
  return {
    client,
    lines,
    markWarm,
    attempts: () => attempts,
    get: () => client.send(new GetItemCommand(parameters)),
    put: () => client.send(new PutItemCommand({ TableName: SECRET, Item: parameters.Key })),
    update: () =>
      client.send(
        new UpdateItemCommand({
          ...parameters,
          UpdateExpression: 'SET x = :x',
          ExpressionAttributeValues: { ':x': { S: SECRET } },
        })
      ),
  };
}

describe('synthetic SP failure-only state diagnostics', () => {
  it('preserves a successful SDK result without logging', async () => {
    const f = fixture();
    try {
      f.markWarm();
      const output = await f.get();
      expect(output.Item).toEqual({ pk: { S: SECRET } });
      expect(f.attempts()).toBe(1);
      expect(f.lines).toEqual([]);
    } finally {
      f.client.destroy();
    }
  });
  it.each([
    [{ code: 'ECONNRESET' }, 'connection_reset'],
    [{ code: 'ETIMEDOUT' }, 'transport_timeout'],
    [{ name: 'AccessDeniedException' }, 'access_denied'],
    [{ name: 'ThrottlingException' }, 'throttled'],
    [{ name: 'ValidationException' }, 'request_rejected'],
    [{ name: 'InternalServerError' }, 'service_unavailable'],
    [{ name: SECRET, code: SECRET }, 'unknown'],
    [{ name: 'toString', code: 'constructor' }, 'unknown'],
  ])(
    'records one final read classification after bounded transport attempts: %j',
    async (fields, expected) => {
      const error = Object.assign(new Error(SECRET), fields, { requestId: SECRET });
      const f = fixture(error);
      try {
        f.markWarm();
        await expect(f.get()).rejects.toBe(error);
        expect(f.attempts()).toBe(expected === 'connection_reset' ? 2 : 1);
        expect(f.lines).toHaveLength(1);
        expect(f.lines[0]).not.toContain(SECRET);
        const record = JSON.parse(f.lines[0]) as Record<string, unknown>;
        expect(Object.keys(record)).toEqual(OUTPUT_KEYS);
        expect(record.timestamp).toMatch(TIMESTAMP);
        expect(record).toEqual({
          timestamp: record.timestamp,
          level: 'WARN',
          event: 'authrim.synthetic_sp_state_failure',
          stage: 'warm_seal_read',
          errorClass: expected,
        });
      } finally {
        f.client.destroy();
      }
    }
  );
  it('never retries a failed write or changes its original error', async () => {
    const error = Object.assign(new Error(SECRET), { code: 'ECONNRESET' });
    const f = fixture(error);
    try {
      f.markWarm();
      await expect(f.put()).rejects.toBe(error);
      expect(f.attempts()).toBe(1);
      expect(f.lines).toHaveLength(1);
      const record = JSON.parse(f.lines[0]) as Record<string, unknown>;
      expect(Object.keys(record)).toEqual(OUTPUT_KEYS);
      expect(record.timestamp).toMatch(TIMESTAMP);
      expect(record).toEqual({
        timestamp: record.timestamp,
        level: 'WARN',
        event: 'authrim.synthetic_sp_state_failure',
        stage: 'challenge_put',
        errorClass: 'connection_reset',
      });
    } finally {
      f.client.destroy();
    }
  });
  it('does not log cold initialization or unrelated SDK commands', async () => {
    const error = Object.assign(new Error(SECRET), { code: 'ECONNRESET' });
    const f = fixture(error);
    try {
      await expect(f.get()).rejects.toBe(error);
      f.markWarm();
      await expect(f.update()).rejects.toBe(error);
      expect(f.lines).toEqual([]);
      expect(f.attempts()).toBe(3);
    } finally {
      f.client.destroy();
    }
  });
  it('preserves the original error when the diagnostic sink fails', async () => {
    const error = Object.assign(new Error(SECRET), { code: 'ECONNRESET' });
    const f = fixture(error, true);
    try {
      f.markWarm();
      await expect(f.get()).rejects.toBe(error);
      expect(f.attempts()).toBe(2);
    } finally {
      f.client.destroy();
    }
  });
});
