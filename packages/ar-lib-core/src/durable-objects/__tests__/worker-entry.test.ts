import { describe, expect, it } from 'vitest';
import * as entry from '../index';

/**
 * `src/durable-objects/index.ts` is the Worker entry of the Durable Object host. workerd rejects a
 * module whose exports are not Durable Object classes, WorkerEntrypoint classes or handlers
 * ("Incorrect type for map entry ... not of type 'function or ExportedHandler'"), which breaks
 * `wrangler dev` for every Worker bound to it. Shared constants belong in their own modules.
 */
describe('Durable Object host Worker entry', () => {
  it('exports only classes (Durable Objects, entrypoints) and the default handler', () => {
    const offending = Object.entries(entry)
      .filter(([name]) => name !== 'default')
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name);
    expect(offending).toEqual([]);
  });

  it('has a default fetch handler', () => {
    expect(typeof entry.default.fetch).toBe('function');
  });

  it('no longer re-exports the flow state constants', () => {
    expect(Object.keys(entry)).not.toContain('DEFAULT_FLOW_TTL_MS');
    expect(Object.keys(entry)).not.toContain('MAX_PROCESSED_REQUEST_IDS');
  });
});
