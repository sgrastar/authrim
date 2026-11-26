import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  introspectTokenFromContext: vi.fn(),
  findById: vi.fn(),
  syncUser: vi.fn(),
  consumeStepUpReceipt: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    introspectTokenFromContext: mocks.introspectTokenFromContext,
    consumeStepUpReceipt: mocks.consumeStepUpReceipt,
    resolveAccountDataContextFromHono: async () => ({ tenantId: 'tenant-a' }),
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findById;
      syncUser = mocks.syncUser;
    },
  };
});

import { createApp, createEnv, projection } from './helpers/customer-profile-write-harness';

let counter = 0;

/** Sends a PATCH that passes step-up (the receipt check is stubbed) and returns the response. */
async function update(
  userId: string,
  body: unknown,
  query = ''
): Promise<{ response: Response; json: Record<string, unknown> }> {
  counter += 1;
  const { env } = createEnv();
  const response = await createApp().request(
    `http://localhost/api/protected/customer-profiles/users/${userId}${query}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/json',
        'Idempotency-Key': `idem-update-${counter}-key`,
        'Authrim-Step-Up-Receipt': 'sur_stubbedreceipt000000000',
      },
      body: JSON.stringify(body),
    },
    env
  );
  const text = await response.clone().text();
  return { response, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function syncedWith(): Record<string, unknown> {
  expect(mocks.syncUser).toHaveBeenCalledTimes(1);
  return (mocks.syncUser.mock.calls[0] as [Record<string, unknown>])[0];
}

describe('customer profile update through the account databases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.introspectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: { sub: 'user-1', client_id: 'rp-1' },
    });
    mocks.consumeStepUpReceipt.mockResolvedValue({});
    mocks.findById.mockImplementation(async (id: string) =>
      id === 'user-404' ? null : projection(id)
    );
    mocks.syncUser.mockResolvedValue(undefined);
  });

  it('opens the subject including inactive accounts', async () => {
    await update('user-1', { input: { name: 'New' } });
    expect(mocks.findById.mock.calls[0]).toEqual(['user-1', { includeInactive: true }]);
  });

  it('syncs only the supplied fields and keeps the account flags', async () => {
    const { response } = await update('user-1', { input: { name: 'New Name' } });
    expect(response.status).toBe(200);
    expect(syncedWith()).toEqual({
      userId: 'user-1',
      email: 'user-1@example.com',
      name: 'Name user-1',
      active: true,
      emailVerified: true,
      phoneNumberVerified: true,
      userType: 'end_user',
      piiFields: { name: true },
      sensitiveValues: { name: 'New Name' },
      addressJson: undefined,
    });
  });

  it('syncs an explicit null as a cleared value', async () => {
    await update('user-1', { input: { nickname: null, phone_number: '+8190' } });
    const call = syncedWith();
    expect(call.piiFields).toEqual({ nickname: true, phone_number: true });
    expect(call.sensitiveValues).toEqual({ nickname: null, phone_number: '+8190' });
  });

  it('syncs an inactive, unverified admin account as such', async () => {
    mocks.findById.mockResolvedValue({
      ...projection('user-1'),
      active: 0,
      email_verified: 0,
      phone_number_verified: 0,
      account_type: 'admin',
    });
    await update('user-1', { input: { name: 'New' } });
    expect(syncedWith()).toMatchObject({
      active: false,
      emailVerified: false,
      phoneNumberVerified: false,
      userType: 'admin',
    });
  });

  it('merges the supplied address members into the stored address (PATCH semantics)', async () => {
    mocks.findById.mockResolvedValue({
      ...projection('user-1'),
      address_json: JSON.stringify({
        formatted: '1 Test Street',
        street_address: '1 Test Street',
        locality: 'Tokyo',
        country: 'JP',
      }),
    });
    await update('user-1', { input: { address: { locality: 'Osaka', postal_code: '530' } } });
    const call = syncedWith();
    expect(JSON.parse(String(call.addressJson))).toEqual({
      formatted: '1 Test Street',
      street_address: '1 Test Street',
      locality: 'Osaka',
      postal_code: '530',
      country: 'JP',
    });
    expect(call.piiFields).toEqual({});
    expect(call.sensitiveValues).toEqual({});
  });

  it('clears only the address member sent as null', async () => {
    mocks.findById.mockResolvedValue({
      ...projection('user-1'),
      address_json: JSON.stringify({ locality: 'Tokyo', country: 'JP' }),
    });
    await update('user-1', { input: { address: { country: null } } });
    expect(JSON.parse(String(syncedWith().addressJson))).toEqual({
      locality: 'Tokyo',
      country: null,
    });
  });

  it.each([
    ['no stored address', null],
    ['an unreadable stored address', '{invalid'],
    ['a stored address that is not an object', '"text"'],
  ])('writes just the supplied members when there is %s', async (_label, stored) => {
    mocks.findById.mockResolvedValue({ ...projection('user-1'), address_json: stored });
    await update('user-1', { input: { address: { locality: 'Osaka' } } });
    expect(JSON.parse(String(syncedWith().addressJson))).toEqual({ locality: 'Osaka' });
  });

  it('does not touch the stored address when the update has no address', async () => {
    await update('user-1', { input: { name: 'New' } });
    expect(syncedWith().addressJson).toBeUndefined();
  });

  it('clears the whole stored address with a null address, including members it does not know', async () => {
    mocks.findById.mockResolvedValue({
      ...projection('user-1'),
      address_json: JSON.stringify({ locality: 'Tokyo', country: 'JP', room_number: '12' }),
    });
    await update('user-1', { input: { address: null } });
    expect(syncedWith().addressJson).toBeNull();
  });

  it('keeps the unknown members of the stored address when only some members are cleared', async () => {
    mocks.findById.mockResolvedValue({
      ...projection('user-1'),
      address_json: JSON.stringify({ locality: 'Tokyo', room_number: '12' }),
    });
    await update('user-1', { input: { address: { locality: null } } });
    expect(JSON.parse(String(syncedWith().addressJson))).toEqual({
      locality: null,
      room_number: '12',
    });
  });

  describe('contact verification', () => {
    it('resets email_verified when the email changes', async () => {
      await update('user-1', { input: { email: 'other@example.com' } });
      expect(syncedWith()).toMatchObject({ emailVerified: false, phoneNumberVerified: true });
    });

    it('resets phone_number_verified when the phone number changes or is removed', async () => {
      await update('user-1', { input: { phone_number: '+819099999999' } });
      expect(syncedWith()).toMatchObject({ emailVerified: true, phoneNumberVerified: false });
      vi.clearAllMocks();
      mocks.findById.mockImplementation(async (id: string) => projection(id));
      await update('user-1', { input: { phone_number: null } });
      expect(syncedWith()).toMatchObject({ emailVerified: true, phoneNumberVerified: false });
    });

    it('keeps the verification when the same value is sent again', async () => {
      await update('user-1', {
        input: { email: 'USER-1@example.com', phone_number: '+819012345678' },
      });
      expect(syncedWith()).toMatchObject({ emailVerified: true, phoneNumberVerified: true });
      // The persisted email is the normalized one the lookup uses, not the sent spelling.
      expect(syncedWith().sensitiveValues).toEqual({
        email: 'user-1@example.com',
        phone_number: '+819012345678',
      });
    });

    it('does not turn an unverified value into a verified one', async () => {
      mocks.findById.mockResolvedValue({ ...projection('user-1'), email_verified: 0 });
      await update('user-1', { input: { email: 'user-1@example.com' } });
      expect(syncedWith()).toMatchObject({ emailVerified: false });
    });
  });

  it('answers not_found for a subject that has no account', async () => {
    mocks.introspectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: { sub: 'user-404', client_id: 'rp-1' },
    });
    const { response, json } = await update('user-404', { input: { name: 'x' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(json).toEqual({
      error: 'not_found',
      error_description: 'Customer profile was not found.',
    });
    expect(mocks.syncUser).not.toHaveBeenCalled();
  });

  describe('response body', () => {
    const audit = { reason_code: 'admin_repair', reference_id: 'CASE-1' };

    it('returns only the raw profile, with no-store headers, when nothing extra is asked', async () => {
      const { response, json } = await update('user-1', { input: { name: 'N' }, audit });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(Object.keys(json)).toEqual(['customer_profile']);
      expect(json.customer_profile).toMatchObject({
        sub: 'user-1',
        tenant_id: 'tenant-a',
        email: 'user-1@example.com',
      });
    });

    it('adds the actor, subject and audit that are asked for, ignoring spaces and blanks', async () => {
      const { json } = await update(
        'user-1',
        { input: { name: 'N' }, audit },
        '?include=%20actor%20,,subject,audit'
      );
      expect(json.actor).toEqual({ id: 'user-1' });
      expect(json.subject).toEqual({ id: 'user-1' });
      expect(json.audit).toEqual(audit);
    });

    it('adds only what is asked for', async () => {
      const { json } = await update('user-1', { input: { name: 'N' }, audit }, '?include=subject');
      expect(Object.keys(json).sort()).toEqual(['customer_profile', 'subject']);
    });

    it('leaves the audit out when the request carried none', async () => {
      const { json } = await update('user-1', { input: { name: 'N' } }, '?include=audit,actor');
      expect(Object.keys(json).sort()).toEqual(['actor', 'customer_profile']);
    });

    it('does not read include entries as substrings', async () => {
      const { json } = await update(
        'user-1',
        { input: { name: 'N' }, audit },
        '?include=actors,xsubject'
      );
      expect(Object.keys(json)).toEqual(['customer_profile']);
    });
  });
});
