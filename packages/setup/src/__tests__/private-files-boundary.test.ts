import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../../../scripts/check-private-files.sh');
let fixture: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
const check = () => spawnSync('bash', [script], { cwd: fixture, encoding: 'utf8' });
function file(path: string) {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), 'fixture');
}
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'authrim-private-boundary-'));
  git('init', '-q');
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

it.each([
  'private/note.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.authrim/config.json',
  '.authrim_keys/key',
  '.authrim-keys/key',
  '.authrim',
])('rejects tracked %s at root and nested paths, but permits local copies', (path) => {
  for (const prefix of ['', 'packages/example/']) {
    const candidate = prefix + path;
    file(candidate);
    expect(check().status).toBe(0);
    git('add', '-f', '--', candidate);
    expect(check().status).toBe(1);
    git('rm', '--cached', '--', candidate);
    expect(check().status).toBe(0);
  }
});

it('permits similarly named public files and handles newline-containing paths', () => {
  for (const path of [
    'private-example/readme.md',
    'AGENTS.md.example',
    '.authrim-example/config',
  ]) {
    file(path);
    git('add', '-f', '--', path);
  }
  expect(check().status).toBe(0);
  file('nested\npath/.authrim/config');
  git('add', '-f', '--', 'nested\npath/.authrim/config');
  expect(check().status).toBe(1);
});
