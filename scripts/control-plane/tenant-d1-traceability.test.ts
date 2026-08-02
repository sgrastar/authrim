import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import traceability from './tenant-d1-traceability.json';

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('tenant D1 control-plane CI traceability', () => {
  it('maps every implementation phase to checked-in tests and all three review perspectives', () => {
    expect(traceability.schemaVersion).toBe(2);
    const phases = new Set(traceability.requirements.map((requirement) => requirement.phase));
    expect([...phases]).toEqual([
      '0',
      '0b',
      '0c',
      '1',
      '2',
      '2b',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);

    for (const phase of phases) {
      const perspectives = new Set(
        traceability.requirements
          .filter((requirement) => requirement.phase === phase)
          .flatMap((requirement) => requirement.perspectives)
      );
      expect(perspectives, `phase ${phase}`).toEqual(
        new Set(['implementation', 'security', 'runtime_operations'])
      );
    }

    const ids = traceability.requirements.map((requirement) => requirement.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const requirement of traceability.requirements) {
      expect(requirement.tests.length, requirement.id).toBeGreaterThan(0);
      for (const testFile of requirement.tests) {
        expect(testFile, requirement.id).toMatch(/\.test\.ts$/);
        expect(
          existsSync(resolve(repositoryRoot, testFile)),
          `${requirement.id}: ${testFile}`
        ).toBe(true);
      }
    }
  });

  it('keeps every mapped suite inside an explicit CI test command', () => {
    const workflow = readFileSync(resolve(repositoryRoot, traceability.ci.workflow), 'utf8');
    expect(workflow).toContain(traceability.ci.backendCommand);
    expect(workflow).toContain(traceability.ci.uiCommand);
    expect(workflow).toContain(traceability.ci.controlPlaneCommand);
    expect(workflow).toContain('pnpm run control-plane:phase9-local-gate');
    expect(workflow).toContain('control-plane-tests:');
    expect(workflow).toContain('- control-plane-tests');

    for (const requirement of traceability.requirements) {
      for (const testFile of requirement.tests) {
        const command = testFile.startsWith('scripts/control-plane/')
          ? traceability.ci.controlPlaneCommand
          : testFile.startsWith('packages/ar-admin-ui/') ||
              testFile.startsWith('packages/ar-login-ui/')
            ? traceability.ci.uiCommand
            : traceability.ci.backendCommand;
        expect(workflow, `${testFile} -> ${command}`).toContain(command);
      }
    }
  });
});
