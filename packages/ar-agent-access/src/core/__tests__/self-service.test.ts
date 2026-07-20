import { describe, expect, it } from 'vitest';
import {
  isSelfServiceClientMetadataDocumentId,
  normalizeSelfServiceAgentAuthorizationDetails,
  SELF_SERVICE_MAX_SUBJECTS_PER_CALL,
  selfServiceRevocationOutboxId,
} from '../self-service';

describe('isSelfServiceClientMetadataDocumentId', () => {
  it('accepts an exact HTTPS metadata document URL', () => {
    expect(
      isSelfServiceClientMetadataDocumentId('https://agent.example/client-metadata.json')
    ).toBe(true);
  });

  it.each([
    'http://agent.example/client-metadata.json',
    'https://agent.example/',
    'https://user@agent.example/client-metadata.json',
    'https://agent.example/client-metadata.json#fragment',
    'https://agent.example/a/%2e%2e/client-metadata.json',
    'not-a-url',
  ])('rejects an unsafe metadata document identifier: %s', (clientId) => {
    expect(isSelfServiceClientMetadataDocumentId(clientId)).toBe(false);
  });
});

describe('normalizeSelfServiceAgentAuthorizationDetails', () => {
  it('uses the conservative profile default when RAR is omitted', () => {
    expect(normalizeSelfServiceAgentAuthorizationDetails(undefined)).toEqual({
      maxSubjectsPerCall: SELF_SERVICE_MAX_SUBJECTS_PER_CALL,
    });
  });

  it('uses the narrowest maximum across repeated Admin Agent details', () => {
    expect(
      normalizeSelfServiceAgentAuthorizationDetails([
        { type: 'authrim_admin_agent', max_subjects_per_call: 20 },
        { type: 'authrim_admin_agent', max_subjects_per_call: 3 },
      ])
    ).toEqual({
      authorizationDetails: [
        { type: 'authrim_admin_agent', max_subjects_per_call: 20 },
        { type: 'authrim_admin_agent', max_subjects_per_call: 3 },
      ],
      maxSubjectsPerCall: 3,
    });
  });

  it.each([
    { details: [] },
    { details: [{ type: 'other' }] },
    { details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 0 }] },
    { details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 51 }] },
    {
      details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 1, resource: '*' }],
    },
  ])('rejects authorization_details outside the Admin Agent profile', ({ details }) => {
    expect(() => normalizeSelfServiceAgentAuthorizationDetails(details)).toThrow(
      'authorization_details is outside the Admin Agent contract'
    );
  });
});

describe('selfServiceRevocationOutboxId', () => {
  it('derives one stable outbox identity from the transition identity', () => {
    expect(selfServiceRevocationOutboxId('transition-1')).toBe('outbox_transition-1');
  });

  it('rejects an empty or oversized transition identity', () => {
    expect(() => selfServiceRevocationOutboxId('')).toThrow('transition ID is invalid');
    expect(() => selfServiceRevocationOutboxId('x'.repeat(129))).toThrow(
      'transition ID is invalid'
    );
  });
});
