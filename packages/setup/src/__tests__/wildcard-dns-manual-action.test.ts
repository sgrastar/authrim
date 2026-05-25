import { describe, expect, it } from 'vitest';
import {
  getCloudflareDnsRecordsDashboardUrl,
  formatWildcardDnsManualAction,
  getWildcardDnsManualAction,
  isWildcardDnsPermissionError,
} from '../core/wildcard-dns-manual-action.js';

describe('wildcard DNS manual action guidance', () => {
  it('builds Japanese manual steps with the wildcard record details', () => {
    const action = getWildcardDnsManualAction('test.authrim.com', 'ja');

    expect(action.kind).toBe('wildcard-dns');
    expect(action.zoneName).toBe('authrim.com');
    expect(action.recordName).toBe('*.test.authrim.com');
    expect(action.dashboardRecordName).toBe('*.test');
    expect(action.target).toBe('test.authrim.com');
    expect(action.title).toContain('手動設定');
    expect(action.steps.join('\n')).toContain('Name (required): *.test');
  });

  it('formats the manual action as a multiline instruction block', () => {
    const text = formatWildcardDnsManualAction(
      getWildcardDnsManualAction('test.authrim.com', 'en')
    );

    expect(text).toContain('Manual wildcard DNS setup is required');
    expect(text).toContain('1. Open DNS management for authrim.com');
    expect(text).toContain('Type: CNAME');
    expect(text).toContain('After that, run deploy.');
    expect(text).not.toContain('Automatic wildcard DNS setup for tenant subdomains');
  });

  it('localizes the title for non-English supported locales', () => {
    const action = getWildcardDnsManualAction('test.authrim.com', 'ko');

    expect(action.title).toContain('수동');
  });

  it('detects dns:edit permission errors', () => {
    expect(
      isWildcardDnsPermissionError(
        new Error('Token lacks dns:edit permission to create wildcard DNS record')
      )
    ).toBe(true);
    expect(isWildcardDnsPermissionError(new Error('Some other error'))).toBe(false);
  });

  it('builds a dashboard deep link when account and zone are known', () => {
    expect(getCloudflareDnsRecordsDashboardUrl('acct-123', 'test.authrim.com')).toBe(
      'https://dash.cloudflare.com/acct-123/authrim.com/dns/records'
    );
  });
});
