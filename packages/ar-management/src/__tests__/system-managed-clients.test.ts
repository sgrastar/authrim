import { describe, expect, it } from 'vitest';
import {
  DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION,
  DOWNSTREAM_INTROSPECTION_CLIENT_NAME,
  isSystemManagedClient,
} from '../system-managed-clients';
import { LOGIN_UI_CLIENT_DESCRIPTION, LOGIN_UI_CLIENT_NAME } from '../login-ui-client-metadata';

describe('isSystemManagedClient', () => {
  it('recognises the two clients setup registers by their fixed name and description', () => {
    expect(
      isSystemManagedClient({
        client_name: LOGIN_UI_CLIENT_NAME,
        description: LOGIN_UI_CLIENT_DESCRIPTION,
      })
    ).toBe(true);
    expect(
      isSystemManagedClient({
        client_name: DOWNSTREAM_INTROSPECTION_CLIENT_NAME,
        description: DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION,
      })
    ).toBe(true);
  });

  it("does not take an administrator's app that reuses only the name or only the description", () => {
    expect(isSystemManagedClient({ client_name: LOGIN_UI_CLIENT_NAME, description: null })).toBe(
      false
    );
    expect(isSystemManagedClient({ client_name: 'Login UI', description: 'Our own login' })).toBe(
      false
    );
    expect(
      isSystemManagedClient({ client_name: 'Member app', description: LOGIN_UI_CLIENT_DESCRIPTION })
    ).toBe(false);
    expect(isSystemManagedClient({})).toBe(false);
  });
});
