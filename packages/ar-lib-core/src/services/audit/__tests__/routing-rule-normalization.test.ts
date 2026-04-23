import { describe, expect, it } from 'vitest';
import {
  hasAuditStorageRoutingTargets,
  normalizeAuditStorageRoutingTargets,
} from '../storage';

describe('audit routing target normalization', () => {
  it('promotes legacy backend to primaryStore', () => {
    expect(normalizeAuditStorageRoutingTargets(undefined, 'd1-core')).toEqual({
      primaryStore: 'd1-core',
    });
  });

  it('deduplicates archive and forwarding targets', () => {
    expect(
      normalizeAuditStorageRoutingTargets({
        primaryStore: ' hyperdrive-eu ',
        archiveStores: ['r2-archive', 'r2-archive', '  '],
        forwardingSinks: ['logpush-eu', 'logpush-eu'],
      })
    ).toEqual({
      primaryStore: 'hyperdrive-eu',
      archiveStores: ['r2-archive'],
      forwardingSinks: ['logpush-eu'],
    });
  });

  it('reports whether a normalized rule has any effective targets', () => {
    expect(hasAuditStorageRoutingTargets({})).toBe(false);
    expect(hasAuditStorageRoutingTargets({ archiveStores: ['r2-archive'] })).toBe(true);
  });
});
