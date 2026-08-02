import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { attachInternalAccountDirectoryBinding } from '../index';

describe('internal Account Directory binding', () => {
  it('creates a same-Worker named entrypoint with fixed authenticated props', () => {
    const binding = { publishAccountDirectory: vi.fn() };
    const factory = vi.fn(() => binding);
    const env = { AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env;
    const result = attachInternalAccountDirectoryBinding(env, {
      exports: { AccountDirectoryEntrypoint: factory },
    } as never);

    expect(result).not.toBe(env);
    expect(result.ACCOUNT_DIRECTORY).toBe(binding);
    expect(factory).toHaveBeenCalledWith({
      props: {
        caller: 'ar-management',
        environmentId: 'test',
        audience: 'authrim-account-directory-v1',
      },
    });
  });

  it('preserves an explicitly supplied binding and does not mint new caller props', () => {
    const binding = { publishAccountDirectory: vi.fn() };
    const factory = vi.fn();
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      ACCOUNT_DIRECTORY: binding,
    } as unknown as Env;
    expect(
      attachInternalAccountDirectoryBinding(env, {
        exports: { AccountDirectoryEntrypoint: factory },
      } as never)
    ).toBe(env);
    expect(factory).not.toHaveBeenCalled();
  });
});
