import { describe, expect, it } from 'vitest';
import {
  getDownstreamGrantRedactionLevel,
  projectDownstreamGrantProtectedResource,
} from '../downstream-grant-protected-resource-redaction';

describe('downstream grant protected resource redaction helpers', () => {
  const resource = {
    id: 'profile-1',
    displayName: 'Alice Example',
    email: 'alice@example.com',
    phone: '+81-90-0000-0000',
  };

  it('projects summary_only resources through the summary projector', () => {
    const result = projectDownstreamGrantProtectedResource(
      {
        resource,
        redactionLevel: 'summary_only',
      },
      {
        summary: (value) => ({
          id: value.id,
          displayName: value.displayName,
        }),
        masked: (value) => ({
          id: value.id,
          displayName: value.displayName,
          email: '***',
        }),
        raw: (value) => value,
      }
    );

    expect(result).toEqual({
      id: 'profile-1',
      displayName: 'Alice Example',
    });
  });

  it('falls back from raw to masked when no raw projector is provided', () => {
    const result = projectDownstreamGrantProtectedResource(
      {
        resource,
        redactionLevel: 'raw',
      },
      {
        summary: (value) => ({
          id: value.id,
        }),
        masked: (value) => ({
          id: value.id,
          email: '***',
          phone: '***',
        }),
      }
    );

    expect(result).toEqual({
      id: 'profile-1',
      email: '***',
      phone: '***',
    });
  });

  it('derives a redaction level from authorization or decision metadata', () => {
    expect(
      getDownstreamGrantRedactionLevel({
        authorization: {
          redactionLevel: 'raw',
        },
      })
    ).toBe('raw');

    expect(
      getDownstreamGrantRedactionLevel({
        decision: {
          context: {
            redactionLevel: 'summary_only',
          },
        },
      })
    ).toBe('summary_only');

    expect(getDownstreamGrantRedactionLevel({})).toBe('masked');
  });
});
