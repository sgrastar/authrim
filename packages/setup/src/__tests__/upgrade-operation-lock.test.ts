import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('upgrade operation lock safety', () => {
  it('never exits the process while upgrade operation locks are held', async () => {
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf-8');
    const lockIndex = source.indexOf(
      'operationLock = await acquireEnvironmentOperationForEnvironment({'
    );
    const finallyIndex = source.indexOf('} finally {', lockIndex);
    const lockedUpgrade = source.slice(lockIndex, finallyIndex);

    expect(lockIndex).toBeGreaterThan(-1);
    expect(finallyIndex).toBeGreaterThan(lockIndex);
    expect(lockedUpgrade).not.toContain('process.exit(');
    expect(source.slice(finallyIndex)).toContain('await deployConfigLock?.release()');
    expect(source.slice(finallyIndex)).toContain('await operationLock?.release()');
  });

  it('checks fixed D1 identity after locking and passes the locked admin UUID to UI mutations', async () => {
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf-8');
    const lockIndex = source.indexOf(
      'operationLock = await acquireEnvironmentOperationForEnvironment({'
    );
    const lockedGuardIndex = source.indexOf(
      'const lockedDeploymentGuard = evaluateReleaseDeploymentGuard(',
      lockIndex
    );
    const identityIndex = source.indexOf('assertFixedD1ResourceIdentities({', lockedGuardIndex);
    const identifierIndex = source.indexOf(
      'lockedAdminDatabaseIdentifier = upgradeLock.d1.DB_ADMIN?.id;',
      identityIndex
    );
    const machineAccessIndex = source.indexOf(
      'await runEphemeralSetupMachineAccess({',
      identifierIndex
    );
    const bffIndex = source.indexOf('await prepareAdminUiBffDeployment({', identifierIndex);

    expect(lockIndex).toBeGreaterThan(-1);
    expect(lockedGuardIndex).toBeGreaterThan(lockIndex);
    expect(identityIndex).toBeGreaterThan(lockedGuardIndex);
    expect(identifierIndex).toBeGreaterThan(identityIndex);
    expect(machineAccessIndex).toBeGreaterThan(identifierIndex);
    expect(source.slice(machineAccessIndex, machineAccessIndex + 350)).toContain(
      'databaseIdentifier: requireLockedAdminDatabaseIdentifier()'
    );
    expect(bffIndex).toBeGreaterThan(identifierIndex);
    expect(source.slice(bffIndex, bffIndex + 350)).toContain(
      'databaseIdentifier: requireLockedAdminDatabaseIdentifier()'
    );
  });
});
