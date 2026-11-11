import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRATION_POLICY,
  LEGACY_REGISTRATION_POLICY,
  emailDomainAllowed,
  normalizeRegistrationDomain,
  readRegistrationPolicy,
  registrationPolicyOfRuntime,
} from '../registration-policy';

describe('a registration policy', () => {
  it('reads a whole policy, domains normalised and kept only where they apply', () => {
    const read = readRegistrationPolicy(
      {
        duplicate: 'reject',
        eligibility: 'domain',
        allowed_domains: ['Example.COM', '@corp.example.co.jp', 'example.com'],
        denied_response: 'reason',
        email_check: 'later',
        external_email_check: ['low_trust', 'low_trust'],
        code_ttl_seconds: 600,
        completion: { behavior: 'custom_url', redirect_url: ' /welcome ' },
      },
      true
    );
    expect(read).toEqual({
      ok: true,
      policy: {
        duplicate: 'reject',
        eligibility: 'domain',
        allowed_domains: ['example.com', 'corp.example.co.jp'],
        denied_response: 'reason',
        email_check: 'later',
        external_email_check: ['low_trust'],
        code_ttl_seconds: 600,
        completion: { behavior: 'custom_url', redirect_url: '/welcome' },
      },
    });
    const open = readRegistrationPolicy({ eligibility: 'open', allowed_domains: ['a.example'] });
    expect(open.ok && open.policy.allowed_domains).toEqual([]);
  });

  it('starts from the safer default of each field', () => {
    expect(readRegistrationPolicy({})).toEqual({ ok: true, policy: DEFAULT_REGISTRATION_POLICY });
  });

  it.each([
    [{ duplicate: 'ignore' }, 'duplicate'],
    [{ eligibility: 'domain', allowed_domains: [] }, 'allowed_domains'],
    [{ eligibility: 'domain', allowed_domains: ['not a domain'] }, 'allowed_domains'],
    [{ code_ttl_seconds: 3600 }, 'code_ttl_seconds'],
    [{ external_email_check: ['everyone'] }, 'external_email_check'],
    [{ completion: { behavior: 'custom_url' } }, 'completion'],
    [{ completion: { behavior: 'saml_login' } }, 'completion'],
    [{ completion: { behavior: 'service_site' } }, 'completion'],
    ['nope', 'registration_policy'],
  ])('refuses %j when it is saved', (value, field) => {
    expect(readRegistrationPolicy(value, true)).toMatchObject({ ok: false, field });
  });

  it('falls back field by field when a published one is read', () => {
    const read = readRegistrationPolicy({ duplicate: 'ignore', code_ttl_seconds: 3600 });
    expect(read).toMatchObject({
      ok: true,
      policy: { duplicate: 'mail', code_ttl_seconds: 300 },
    });
  });

  it('is the first registration step’s, else the tenant’s behaviour as it was', () => {
    const runtime = (config: Record<string, unknown>) => ({
      ui: {
        steps: [
          { id: 'entry', component: 'interaction_context', config: {} },
          { id: 'register', component: 'registration_method_selector', config },
        ],
      },
    });
    expect(
      registrationPolicyOfRuntime(runtime({ registration_policy: { duplicate: 'reject' } }))
    ).toMatchObject({ duplicate: 'reject' });
    expect(registrationPolicyOfRuntime(runtime({}))).toBe(LEGACY_REGISTRATION_POLICY);
    expect(registrationPolicyOfRuntime(null)).toBe(LEGACY_REGISTRATION_POLICY);
  });

  it('matches an address to the domains exactly, not a sub-domain', () => {
    expect(normalizeRegistrationDomain(' @Example.com ')).toBe('example.com');
    expect(normalizeRegistrationDomain('localhost')).toBeNull();
    expect(emailDomainAllowed('a@Example.com', ['example.com'])).toBe(true);
    expect(emailDomainAllowed('a@mail.example.com', ['example.com'])).toBe(false);
    expect(emailDomainAllowed('no-at-sign', ['example.com'])).toBe(false);
  });
});
