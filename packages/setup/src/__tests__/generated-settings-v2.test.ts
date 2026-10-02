import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForSettingsToApply } from '../core/generated-settings-v2.js';

describe('waitForSettingsToApply', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns as soon as the setting is in effect', async () => {
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const promise = waitForSettingsToApply(probe);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('gives up after the time a setting can take to reach runtime', async () => {
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const promise = waitForSettingsToApply(probe, 20_000);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(false);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
