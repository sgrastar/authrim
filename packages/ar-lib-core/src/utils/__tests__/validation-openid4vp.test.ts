import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateClientIdScheme,
  validateJARClaims,
  validateJARParameterConsistency,
  validatePresentationDefinition,
  validatePresentationSubmission,
} from '../validation';

const descriptor = {
  id: 'identity',
  group: ['A'],
  name: 'Identity credential',
  purpose: 'Identify the holder',
  format: { 'dc+sd-jwt': {} },
  constraints: {
    limit_disclosure: 'required',
    fields: [
      {
        id: 'email',
        purpose: 'Contact address',
        optional: false,
        path: ['$.email'],
        filter: { type: ['string', 'null'], pattern: '^[^@]+@[^@]+$', format: 'email' },
      },
    ],
  },
};

const definition = {
  id: 'pd-1',
  name: 'Identity check',
  purpose: 'Verify identity',
  input_descriptors: [descriptor],
  format: { 'dc+sd-jwt': {} },
};

describe('OpenID4VP and JAR validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  it.each([
    ['pre-registered', 'client_1', {}, true],
    ['pre-registered', 'client_1', { preRegisteredClients: ['other'] }, false],
    ['redirect_uri', 'https://wallet.example/cb', {}, true],
    ['redirect_uri', 'http://localhost/cb', { allowHttp: true }, true],
    ['redirect_uri', 'http://wallet.example/cb', { allowHttp: true }, false],
    ['redirect_uri', 'not a uri', {}, false],
    ['entity_id', 'https://verifier.example', {}, true],
    ['entity_id', 'http://verifier.example', {}, false],
    ['entity_id', ':', {}, false],
    ['did', 'did:web:verifier.example', {}, true],
    ['did', 'verifier.example', {}, false],
    ['did', 'did:web', {}, false],
    ['did', 'did:UPPER:value', {}, false],
    ['verifier_attestation', 'attested-client', {}, true],
    ['x509_san_dns', 'verifier.example', {}, true],
    ['x509_san_dns', '-invalid.example', {}, false],
    ['x509_san_uri', 'https://verifier.example/id', {}, true],
    ['x509_san_uri', 'http://verifier.example/id', {}, false],
    ['x509_san_uri', ':', {}, false],
    ['unsupported', 'client', {}, false],
  ])('validates %s client identifier %s', (scheme, clientId, options, valid) => {
    expect(validateClientIdScheme(clientId, scheme, options).valid).toBe(valid);
  });

  it('defaults to pre-registered and rejects missing or malformed client IDs', () => {
    expect(validateClientIdScheme(undefined, undefined)).toMatchObject({ valid: false });
    expect(validateClientIdScheme('bad id', undefined)).toMatchObject({
      valid: false,
      scheme: 'pre-registered',
    });
    expect(validateClientIdScheme('client_1', undefined)).toMatchObject({
      valid: true,
      scheme: 'pre-registered',
      identifier: 'client_1',
    });
  });

  it('accepts a complete Presentation Definition', () => {
    expect(
      validatePresentationDefinition({
        ...definition,
        submission_requirements: [{ rule: 'pick', count: 1, from: 'A' }],
      })
    ).toEqual({ valid: true, errors: [] });
  });

  it.each([null, 'not-an-object'])('rejects non-object Presentation Definition %s', (value) => {
    expect(validatePresentationDefinition(value)).toEqual({
      valid: false,
      errors: ['Presentation Definition must be an object'],
    });
  });

  it('reports malformed Presentation Definition metadata and descriptors', () => {
    const result = validatePresentationDefinition({
      id: 'x'.repeat(257),
      name: 1,
      purpose: 2,
      input_descriptors: [
        null,
        { id: '', name: 1, purpose: 2 },
        { id: 'dup', constraints: 'bad', format: 'bad' },
        { id: 'dup', constraints: { fields: 'bad', limit_disclosure: 'always' } },
      ],
      submission_requirements: 'bad',
      format: 'bad',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Presentation Definition id is too long (max 256 characters)',
        'Presentation Definition name must be a string',
        'input_descriptors[0] must be an object',
        'input_descriptors[1].constraints is required',
        'Duplicate input_descriptor id: dup',
        'submission_requirements must be an array',
        'format must be an object',
      ])
    );
  });

  it('reports invalid field constraints, JSON Schema, formats, and nested requirements', () => {
    const result = validatePresentationDefinition({
      id: 'pd-invalid',
      input_descriptors: [
        {
          id: 'bad-fields',
          constraints: {
            fields: [
              null,
              { path: 'not-array' },
              { path: [] },
              {
                path: [1, 'email'],
                id: 1,
                purpose: 2,
                optional: 'yes',
                filter: 'bad',
              },
              {
                path: ['$.age'],
                filter: {
                  type: ['number', 'invalid'],
                  enum: [],
                  pattern: '[',
                  format: 3,
                },
              },
              { path: ['$.name'], filter: { type: 3, enum: 'bad', pattern: 3 } },
            ],
          },
          format: { jwt_vc: 'bad', extension_format: true },
        },
      ],
      submission_requirements: [
        null,
        { rule: 'unknown' },
        { rule: 'pick', from: 2, count: 'one', min: 'zero', max: 'two' },
        { rule: 'pick', from: 'A', min: 2, max: 1 },
        { rule: 'all', from_nested: 'bad' },
        { rule: 'all', from_nested: [{ rule: 'all', from: 'A' }] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(20);
    expect(result.errors.join('\n')).toContain("must start with '$'");
    expect(result.errors.join('\n')).toContain('pattern is not a valid regular expression');
    expect(result.errors.join('\n')).toContain('min cannot be greater than max');
  });

  it('validates current JAR temporal, issuer, audience, and replay claims', () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'client-1',
      aud: ['https://issuer.example', 'other'],
      exp: now + 120,
      iat: now,
      nbf: now,
      jti: 'request-1',
    };
    expect(
      validateJARClaims(claims, {
        audience: 'https://issuer.example',
        expectedIssuer: 'client-1',
        requireJti: true,
        seenJtiSet: new Set(),
      })
    ).toEqual({ valid: true, errors: [], claims });
  });

  it('collects all material JAR claim failures', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = validateJARClaims(
      {
        iss: 'wrong',
        aud: 'wrong-audience',
        exp: now - 100,
        iat: now + 100,
        nbf: now + 100,
        jti: 'used',
      },
      {
        audience: 'https://issuer.example',
        expectedIssuer: 'client-1',
        maxAge: 10,
        clockSkew: 0,
        requireJti: true,
        seenJtiSet: new Set(['used']),
      }
    );
    expect(result.valid).toBe(false);
    expect(result.claims).toBeUndefined();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('iss claim mismatch'),
        expect.stringContaining('aud claim must include'),
        'Request object has expired',
        'Request object iat is in the future',
        'Request object is not yet valid (nbf)',
        'Request object has already been used (replay detected)',
      ])
    );
  });

  it.each([
    [null, 'Request object claims must be an object'],
    [{ aud: 'issuer' }, 'iss claim is required'],
    [{ iss: 'client' }, 'aud claim is required'],
    [{ iss: 'client', aud: 'issuer', exp: 'later' }, 'exp claim must be a number'],
    [{ iss: 'client', aud: 'issuer', iat: 'now' }, 'iat claim must be a number'],
    [{ iss: 'client', aud: 'issuer', nbf: 'now' }, 'nbf claim must be a number'],
    [{ iss: 'client', aud: 'issuer' }, 'jti claim is required'],
    [{ iss: 'client', aud: 'issuer', jti: 1 }, 'jti claim must be a string'],
  ])('rejects malformed JAR claims %#', (claims, error) => {
    expect(
      validateJARClaims(claims, { audience: 'issuer', requireJti: true }).errors.some((message) =>
        message.includes(error)
      )
    ).toBe(true);
  });

  it('detects conflicts between request object and query parameters', () => {
    expect(
      validateJARParameterConsistency(
        { client_id: 'object', redirect_uri: 'https://object/cb', response_type: 'code' },
        {
          client_id: 'query',
          redirect_uri: 'https://query/cb',
          response_type: 'token',
        }
      )
    ).toHaveLength(3);
    expect(validateJARParameterConsistency({ client_id: 'same' }, { client_id: 'same' })).toEqual(
      []
    );
    expect(validateJARParameterConsistency({}, {})).toEqual([]);
  });

  it('accepts a complete Presentation Submission matching the definition', () => {
    expect(
      validatePresentationSubmission(
        {
          id: 'submission-1',
          definition_id: 'pd-1',
          descriptor_map: [{ id: 'identity', format: 'dc+sd-jwt', path: '$' }],
        },
        definition as never
      )
    ).toEqual({ valid: true, errors: [] });
  });

  it('reports malformed and incomplete Presentation Submissions', () => {
    expect(validatePresentationSubmission(null, definition as never).valid).toBe(false);
    const result = validatePresentationSubmission(
      {
        id: 'x'.repeat(257),
        definition_id: 'other',
        descriptor_map: [
          null,
          { id: 'unknown', format: 'unknown', path: 'credential' },
          { id: 'identity', format: 'jwt_vc', path: '$', path_nested: 'bad' },
          {
            id: 'identity',
            format: 'dc+sd-jwt',
            path: '$',
            path_nested: { id: 'identity', format: 'dc+sd-jwt', path: '$.vc' },
          },
        ],
      },
      definition as never
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('definition_id mismatch');
    expect(result.errors.join('\n')).toContain('Duplicate descriptor_map entry');
    expect(result.errors.join('\n')).toContain('not a recognized credential format');
    expect(result.errors.join('\n')).toContain('path_nested must be an object');
  });

  it('enforces all, pick minimum, pick maximum, and nested submission requirements', () => {
    const groupedDefinition = {
      id: 'grouped',
      input_descriptors: [
        { ...descriptor, id: 'a', group: ['A'] },
        { ...descriptor, id: 'b', group: ['A'] },
      ],
      submission_requirements: [{ rule: 'all', from: 'A' }],
    };
    const submission = {
      id: 's',
      definition_id: 'grouped',
      descriptor_map: [{ id: 'a', format: 'dc+sd-jwt', path: '$' }],
    };
    expect(
      validatePresentationSubmission(submission, groupedDefinition as never).errors.join()
    ).toContain("rule 'all'");

    groupedDefinition.submission_requirements = [{ rule: 'pick', from: 'A', count: 2 }] as never;
    expect(
      validatePresentationSubmission(submission, groupedDefinition as never).errors.join()
    ).toContain("rule 'pick'");
    groupedDefinition.submission_requirements = [{ rule: 'pick', from: 'A', max: 0 }] as never;
    expect(
      validatePresentationSubmission(submission, groupedDefinition as never).errors.join()
    ).toContain('exceeded max');
    groupedDefinition.submission_requirements = [
      { rule: 'all', from_nested: [{ rule: 'pick', from: 'A', min: 2 }] },
    ] as never;
    expect(validatePresentationSubmission(submission, groupedDefinition as never).valid).toBe(
      false
    );
  });
});
