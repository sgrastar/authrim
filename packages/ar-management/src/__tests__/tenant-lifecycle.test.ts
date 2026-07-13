import { describe, expect, it } from 'vitest';
import { validateTenantLifecycleTransition } from '../admin-tenants';

describe('tenant lifecycle transition validator', () => {
  it.each([
    ['suspend', 'active', 'suspended', false],
    ['freeze', 'active', 'frozen', false],
    ['freeze', 'migration_read_only', 'frozen', false],
    ['resume', 'suspended', 'active', true],
    ['unfreeze', 'frozen', 'active', true],
    ['restore-validate', 'restore_pending', 'restore_validating', true],
    ['restore-validate', 'restore_validating', 'restore_validating', true],
  ] as const)('%s transitions %s to %s', (command, from, targetState, async) => {
    expect(validateTenantLifecycleTransition(command, from)).toEqual({ targetState, async });
  });

  it.each([
    ['suspend', 'frozen'],
    ['resume', 'active'],
    ['unfreeze', 'suspended'],
    ['restore-validate', 'active'],
  ] as const)('rejects invalid %s transitions from %s', (command, from) => {
    expect(() => validateTenantLifecycleTransition(command, from)).toThrow(
      'Invalid lifecycle transition'
    );
  });

  it('allows audited break-glass recovery from non-terminal states', () => {
    expect(validateTenantLifecycleTransition('unfreeze', 'migration_read_only', true)).toEqual({
      targetState: 'active',
      async: true,
    });
  });

  it.each(['provisioning', 'deleting', 'deleted'] as const)(
    'does not allow break-glass to bypass %s',
    (state) => {
      expect(() => validateTenantLifecycleTransition('unfreeze', state, true)).toThrow(
        'Invalid lifecycle transition'
      );
    }
  );
});
