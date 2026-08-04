import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

function readSource(path: string): string {
  return readFileSync(resolve(testDir, '..', path), 'utf-8');
}

describe('Control Plane runtime boundary', () => {
  it('keeps authorization, login, consent, passkey, and logout paths on Hono runtime contexts', () => {
    const sources = ['authorize.ts', 'email-code.ts', 'consent.ts', 'passkey.ts', 'logout.ts'].map(
      readSource
    );

    for (const source of sources) {
      expect(source).toMatch(
        /createAuthContextFromHono|createPIIContextFromHono|resolve(?:Otp)?Account(?:Core)?DataContext\w*FromHono/u
      );
    }
  });

  it('does not construct tenant-owned user repositories directly from deployment DB bindings', () => {
    const combined = ['authorize.ts', 'email-code.ts', 'consent.ts', 'passkey.ts', 'logout.ts']
      .map(readSource)
      .join('\n');

    expect(combined).not.toMatch(/new\s+User(Core|PII)Repository\s*\(\s*c\.env\.DB/u);
    expect(combined).not.toMatch(/new\s+User(Core|PII)Repository\s*\(\s*c\.env\.DB_PII/u);
  });
});
