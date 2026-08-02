import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE_ROOTS = ['packages/ar-auth/src', 'packages/ar-management/src'] as const;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFiles(path));
    } else if (
      entry.isFile() &&
      extname(entry.name) === '.ts' &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

function matchingFiles(pattern: RegExp): string[] {
  return SOURCE_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(REPO_ROOT, path))
    .sort();
}

describe('notification cutover call-site inventory', () => {
  it('forbids direct Runtime and Management notification execution surfaces', () => {
    expect(
      matchingFiles(/\.registry\.getNotifier\(|\.EMAIL\.send\(|getEmailNotifier\(\)/u)
    ).toEqual([]);
  });

  it('forbids Runtime and Management from bootstrapping built-in notifier providers', () => {
    expect(matchingFiles(/const loadNotificationPlugins = createPluginLoader\(/u)).toEqual([]);
  });

  it('forbids direct Cloudflare Email delivery outside Plugin Runner', () => {
    expect(matchingFiles(/\.EMAIL\.send\(/u)).toEqual([]);
  });

  it('does not expose direct notifier provider details during the staged cutover', () => {
    const source = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
    const tenantInvitationSource = source('packages/ar-management/src/admin-tenant-invitations.ts');
    const tenantInvitationDeliveryBlock = tenantInvitationSource.slice(
      tenantInvitationSource.indexOf('// Conditionally send email'),
      tenantInvitationSource.indexOf('await createAuditLogFromContext')
    );
    expect(source('packages/ar-auth/src/email-code.ts')).not.toMatch(
      /error:\s*emailResult\.error/u
    );
    expect(tenantInvitationDeliveryBlock).not.toMatch(
      /error:\s*(?:emailResult\.error|String\(error\))/u
    );
    expect(source('packages/ar-management/src/approval-ciba-notification.ts')).not.toMatch(
      /new ApprovalCibaNotificationError\(\s*result\.error/u
    );
    expect(source('packages/ar-management/src/approval-notification-dispatch.ts')).not.toMatch(
      /error:\s*result\.error/u
    );
    expect(source('packages/ar-management/src/routes/settings/plugins.ts')).not.toMatch(
      /(?:providerResponse:\s*result\.providerResponse|error_description:\s*result\.error)/u
    );
  });
});
