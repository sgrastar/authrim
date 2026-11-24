/* eslint-disable @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

const sub = (name: string, type = 'string') => ({
  name,
  type,
  multiValued: false,
  required: false,
});

/** A top-level attribute exactly as the Schemas endpoint publishes it. */
const attr = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  type: 'string',
  multiValued: false,
  required: false,
  mutability: 'readWrite',
  returned: 'default',
  ...over,
});

const location = (id: string) => `http://localhost/scim/v2/Schemas/${encodeURIComponent(id)}`;

describeScimTestHarness('SCIM Schemas and ResourceTypes definitions', (harness) => {
  const get = async (path: string) => {
    const res = await harness.app.fetch(harness.createRequest(path), harness.env);
    return { res, body: await res.json<Record<string, any>>() };
  };

  it('publishes the exact core User schema', async () => {
    const { res, body } = await get(`/scim/v2/Schemas/${encodeURIComponent(USER)}`);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      schemas: [SCHEMA_SCHEMA],
      id: USER,
      name: 'User',
      description: 'User Account',
      attributes: [
        attr('userName', { required: true, caseExact: false, uniqueness: 'server' }),
        attr('externalId', { caseExact: true, uniqueness: 'none' }),
        attr('name', {
          type: 'complex',
          subAttributes: [
            sub('formatted'),
            sub('familyName'),
            sub('givenName'),
            sub('middleName'),
            sub('honorificPrefix'),
            sub('honorificSuffix'),
          ],
        }),
        attr('displayName'),
        attr('nickName'),
        attr('profileUrl', { type: 'reference', referenceTypes: ['external'] }),
        attr('title'),
        attr('userType'),
        attr('preferredLanguage'),
        attr('locale'),
        attr('timezone'),
        attr('emails', {
          type: 'complex',
          multiValued: true,
          subAttributes: [sub('value'), sub('type'), sub('primary', 'boolean')],
        }),
        attr('phoneNumbers', {
          type: 'complex',
          multiValued: true,
          subAttributes: [sub('value'), sub('type'), sub('primary', 'boolean')],
        }),
        attr('addresses', {
          type: 'complex',
          multiValued: true,
          subAttributes: [
            sub('formatted'),
            sub('streetAddress'),
            sub('locality'),
            sub('region'),
            sub('postalCode'),
            sub('country'),
            sub('type'),
            sub('primary', 'boolean'),
          ],
        }),
        attr('active', { type: 'boolean' }),
      ],
      meta: { location: location(USER), resourceType: 'Schema' },
    });
  });

  it('publishes the exact Group schema', async () => {
    const { res, body } = await get(`/scim/v2/Schemas/${encodeURIComponent(GROUP)}`);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      schemas: [SCHEMA_SCHEMA],
      id: GROUP,
      name: 'Group',
      description: 'Group',
      attributes: [
        attr('displayName', { required: true }),
        attr('members', {
          type: 'complex',
          multiValued: true,
          subAttributes: [sub('value'), sub('$ref', 'reference'), sub('type')],
        }),
      ],
      meta: { location: location(GROUP), resourceType: 'Schema' },
    });
  });

  it('publishes the exact Enterprise User extension schema', async () => {
    const { res, body } = await get(`/scim/v2/Schemas/${encodeURIComponent(ENTERPRISE)}`);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      schemas: [SCHEMA_SCHEMA],
      id: ENTERPRISE,
      name: 'EnterpriseUser',
      description: 'Enterprise User Extension',
      attributes: [
        attr('employeeNumber'),
        attr('costCenter'),
        attr('organization'),
        attr('department'),
        attr('division'),
        attr('manager', {
          type: 'complex',
          subAttributes: [sub('value'), sub('$ref', 'reference'), sub('displayName')],
        }),
      ],
      meta: { location: location(ENTERPRISE), resourceType: 'Schema' },
    });
  });

  it('answers 404 for an unknown schema id', async () => {
    const { res, body } = await get('/scim/v2/Schemas/urn%3Aunknown');
    expect(res.status).toBe(404);
    expect(body.detail).toBe('The requested resource was not found');
    expect(body.status).toBe('404');
  });

  it('publishes the Group resource type', async () => {
    const { res, body } = await get('/scim/v2/ResourceTypes/Group');
    expect(res.status).toBe(200);
    expect(body).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: 'Group',
      schema: GROUP,
      meta: {
        location: 'http://localhost/scim/v2/ResourceTypes/Group',
        resourceType: 'ResourceType',
      },
    });
  });

  it('answers 404 for an unknown resource type', async () => {
    const { res, body } = await get('/scim/v2/ResourceTypes/Widget');
    expect(res.status).toBe(404);
    expect(body.detail).toBe('The requested resource was not found');
  });
});
