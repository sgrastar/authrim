import { describe, expect, it } from 'vitest';
import {
  IDENTIFIER_SALT_NAME,
  PERSISTENT_IDENTIFIER_ALGORITHMS,
  PERSISTENT_IDENTIFIER_FORMATS,
  PERSISTENT_IDENTIFIER_INPUTS,
  TRANSFORM_OPERATION_SCHEMAS,
  persistentIdentifierSettingsProblem,
  sharesConsumedInput,
  validateTransformRegistry,
} from '../../core/transforms';
import type {
  FieldRef,
  MappingRuleEdge,
  MappingTransformStep,
  TransformOperation,
  TransformOperationSchema,
} from '../../core/types';

type Param = TransformOperationSchema['parameters'][number];

const bool = (name: string): Param => ({ name, kind: 'boolean', required: false });
const str = (name: string, required = false): Param => ({ name, kind: 'string', required });
const oneToOne = { min: 1, max: 1 };

function schemaOf(operation: TransformOperation): TransformOperationSchema | undefined {
  return TRANSFORM_OPERATION_SCHEMAS.find((schema) => schema.operation === operation);
}

describe('persistent identifier vocabularies', () => {
  it('lists the supported formats, algorithms and inputs in order', () => {
    expect([...PERSISTENT_IDENTIFIER_FORMATS]).toEqual([
      'plain',
      'saml_targeted_id',
      'saml_pairwise_id',
      'saml_subject_id',
    ]);
    expect([...PERSISTENT_IDENTIFIER_ALGORITHMS]).toEqual([
      'authrim_sha256',
      'shibboleth',
      'keycloak_sha256',
      'simplesamlphp_targeted_id',
      'simplesamlphp_persistent_nameid',
      'simplesamlphp_pairwise_id',
      'simplesamlphp_subject_id',
    ]);
    expect([...PERSISTENT_IDENTIFIER_INPUTS]).toEqual(['account', 'source']);
  });

  it.each(['a', '0', 'a_b-c', 'a'.repeat(63)])('accepts the salt name %s', (name) => {
    expect(IDENTIFIER_SALT_NAME.test(name)).toBe(true);
  });

  it.each(['', '_a', '-a', 'A', 'a b', 'a.b', 'a'.repeat(64), 'a\n'])(
    'rejects the salt name %j',
    (name) => {
      expect(IDENTIFIER_SALT_NAME.test(name)).toBe(false);
    }
  );
});

describe('transform operation schemas', () => {
  const arrayFlags = [bool('trimItems'), bool('omitEmpty'), bool('unique')];

  it('describes the collection operations', () => {
    expect(schemaOf('copy')).toEqual({ operation: 'copy', inputArity: oneToOne, parameters: [] });
    expect(schemaOf('as_array')).toEqual({
      operation: 'as_array',
      inputArity: oneToOne,
      parameters: arrayFlags,
      outputCardinality: 'multi',
    });
    expect(schemaOf('split')).toEqual({
      operation: 'split',
      inputArity: oneToOne,
      parameters: [str('delimiter'), ...arrayFlags],
      outputCardinality: 'multi',
    });
    expect(schemaOf('join')).toEqual({
      operation: 'join',
      inputArity: { min: 1 },
      parameters: [str('delimiter'), ...arrayFlags],
      outputValueType: 'string',
      outputCardinality: 'single',
    });
    expect(schemaOf('first')).toEqual({
      operation: 'first',
      inputArity: { min: 1 },
      parameters: [bool('trimItems'), bool('omitEmpty')],
      outputCardinality: 'single',
    });
  });

  it('describes the persistent identifier operation', () => {
    expect(schemaOf('persistent_identifier')).toEqual({
      operation: 'persistent_identifier',
      inputArity: { min: 0, max: 0 },
      parameters: [
        { name: 'input', kind: 'enum', required: true, allowedValues: ['account', 'source'] },
        str('source'),
        {
          name: 'format',
          kind: 'enum',
          required: true,
          allowedValues: ['plain', 'saml_targeted_id', 'saml_pairwise_id', 'saml_subject_id'],
        },
        {
          name: 'algorithm',
          kind: 'enum',
          required: true,
          allowedValues: [
            'authrim_sha256',
            'shibboleth',
            'keycloak_sha256',
            'simplesamlphp_targeted_id',
            'simplesamlphp_persistent_nameid',
            'simplesamlphp_pairwise_id',
            'simplesamlphp_subject_id',
          ],
        },
        {
          name: 'digest',
          kind: 'enum',
          required: false,
          allowedValues: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'],
        },
        { name: 'encoding', kind: 'enum', required: false, allowedValues: ['base64', 'base32'] },
        {
          name: 'audience',
          kind: 'enum',
          required: false,
          allowedValues: ['auto', 'sector', 'sp_entity_id'],
        },
        str('scope'),
        str('salt'),
        str('exceptions'),
        {
          name: 'stored',
          kind: 'enum',
          required: false,
          allowedValues: ['off', 'prefer', 'require'],
        },
        str('store'),
        str('sourceMetadataSet'),
        str('destinationMetadataSet'),
      ],
      outputValueType: 'string',
      outputCardinality: 'single',
    });
  });

  it('describes the text and JSON shaping operations', () => {
    expect(schemaOf('affix_text')).toEqual({
      operation: 'affix_text',
      inputArity: oneToOne,
      parameters: [str('prefix'), str('suffix')],
      outputValueType: 'string',
      outputCardinality: 'single',
    });
    expect(schemaOf('concat')).toEqual({
      operation: 'concat',
      inputArity: { min: 1 },
      parameters: [str('delimiter')],
      outputValueType: 'string',
      outputCardinality: 'single',
    });
    expect(schemaOf('fallback')).toEqual({
      operation: 'fallback',
      inputArity: { min: 1 },
      parameters: [],
    });
    expect(schemaOf('normalize')).toEqual({
      operation: 'normalize',
      inputArity: oneToOne,
      parameters: [
        { name: 'mode', kind: 'enum', required: true, allowedValues: ['whitespace', 'unicode'] },
      ],
      outputValueType: 'string',
      outputCardinality: 'single',
    });
    expect(schemaOf('case')).toEqual({
      operation: 'case',
      inputArity: oneToOne,
      parameters: [
        { name: 'mode', kind: 'enum', required: true, allowedValues: ['lower', 'upper', 'title'] },
      ],
      outputValueType: 'string',
      outputCardinality: 'single',
    });
    expect(schemaOf('trim')).toEqual({
      operation: 'trim',
      inputArity: oneToOne,
      parameters: [],
      outputValueType: 'string',
      outputCardinality: 'single',
    });
    expect(schemaOf('text_to_boolean')).toEqual({
      operation: 'text_to_boolean',
      inputArity: oneToOne,
      parameters: [str('trueValues'), str('falseValues'), str('nullValues')],
      outputValueType: 'boolean',
      outputCardinality: 'single',
    });
    expect(schemaOf('json_build')).toEqual({
      operation: 'json_build',
      inputArity: { min: 1 },
      parameters: [
        str('keyMap'),
        {
          name: 'nullHandling',
          kind: 'enum',
          required: true,
          allowedValues: ['omit', 'include_null'],
        },
      ],
      outputValueType: 'json',
      outputCardinality: 'single',
    });
    const pathParam = [str('path', true)];
    expect(schemaOf('json_extract_text')).toEqual({
      operation: 'json_extract_text',
      inputArity: oneToOne,
      parameters: pathParam,
      outputValueType: 'string',
      outputCardinality: 'single',
    });
    expect(schemaOf('json_extract_boolean')).toEqual({
      operation: 'json_extract_boolean',
      inputArity: oneToOne,
      parameters: pathParam,
      outputValueType: 'boolean',
      outputCardinality: 'single',
    });
    expect(schemaOf('json_extract_integer')).toEqual({
      operation: 'json_extract_integer',
      inputArity: oneToOne,
      parameters: pathParam,
      outputValueType: 'number',
      outputCardinality: 'single',
    });
  });
});

describe('validateTransformRegistry', () => {
  it('reports every repeated operation by name', () => {
    const copy = schemaOf('copy');
    const trim = schemaOf('trim');
    if (!copy || !trim) throw new Error('missing schema');
    expect(validateTransformRegistry([copy, trim])).toEqual([]);
    expect(validateTransformRegistry([copy, trim, copy, trim, copy])).toEqual([
      'duplicate transform operation: copy',
      'duplicate transform operation: trim',
      'duplicate transform operation: copy',
    ]);
    expect(validateTransformRegistry([])).toEqual([]);
  });
});

describe('persistentIdentifierSettingsProblem', () => {
  const BASE = { input: 'account', format: 'plain', algorithm: 'authrim_sha256' };
  const problem = (extra: Record<string, unknown>) =>
    persistentIdentifierSettingsProblem({ ...BASE, ...extra });

  it('accepts a minimal valid set and treats absent parameters as invalid', () => {
    expect(persistentIdentifierSettingsProblem(BASE)).toBeNull();
    expect(persistentIdentifierSettingsProblem(undefined)).toBe('format');
    expect(persistentIdentifierSettingsProblem({})).toBe('format');
  });

  it('checks the format, the algorithm and the input in that order', () => {
    expect(problem({ format: undefined, algorithm: undefined, input: undefined })).toBe('format');
    expect(problem({ format: 'nope' })).toBe('format');
    expect(problem({ format: 5 })).toBe('format');
    expect(problem({ algorithm: undefined, input: undefined })).toBe('algorithm');
    expect(problem({ algorithm: 'nope' })).toBe('algorithm');
    expect(problem({ algorithm: 5 })).toBe('algorithm');
    expect(problem({ input: undefined })).toBe('input');
    expect(problem({ input: 'nope' })).toBe('input');
    expect(problem({ input: 5 })).toBe('input');
  });

  it('requires a valid source name exactly when the input is a source', () => {
    expect(problem({ input: 'source', source: 'employee-ids' })).toBeNull();
    expect(problem({ input: 'source', source: 'a'.repeat(63) })).toBeNull();
    expect(problem({ input: 'source' })).toBe('source');
    expect(problem({ input: 'source', source: 'a'.repeat(64) })).toBe('source');
    expect(problem({ input: 'source', source: 'Bad Name' })).toBe('source');
    expect(problem({ input: 'source', source: 'ok name' })).toBe('source');
    expect(problem({ input: 'source', source: 5 })).toBe('source');
    expect(problem({ input: 'account', source: 'employee-ids' })).toBe('source');
  });

  it('validates the salt and exceptions names', () => {
    expect(problem({ salt: 'my-salt' })).toBeNull();
    expect(problem({ salt: 'BAD' })).toBe('salt');
    expect(problem({ salt: 'bad name' })).toBe('salt');
    expect(problem({ salt: 5 })).toBe('salt');
    expect(problem({ salt: '' })).toBe('salt');
    expect(problem({ exceptions: 'old-list' })).toBeNull();
    expect(problem({ exceptions: 'BAD' })).toBe('exceptions');
    expect(problem({ exceptions: 'bad name' })).toBe('exceptions');
    expect(problem({ exceptions: 5 })).toBe('exceptions');
  });

  const allowed: Record<string, string[]> = {
    authrim_sha256: ['plain', 'saml_targeted_id', 'saml_pairwise_id'],
    shibboleth: ['plain', 'saml_targeted_id', 'saml_pairwise_id'],
    keycloak_sha256: ['plain'],
    simplesamlphp_targeted_id: ['plain', 'saml_targeted_id'],
    simplesamlphp_persistent_nameid: ['plain', 'saml_targeted_id'],
    simplesamlphp_pairwise_id: ['saml_pairwise_id'],
    simplesamlphp_subject_id: ['saml_subject_id'],
  };

  it.each(
    PERSISTENT_IDENTIFIER_ALGORITHMS.flatMap((algorithm) =>
      PERSISTENT_IDENTIFIER_FORMATS.map((format) => [algorithm, format] as const)
    )
  )('algorithm %s with format %s', (algorithm, format) => {
    const fits = allowed[algorithm]?.includes(format) ?? false;
    // A scope is always supplied so only the combination decides the outcome.
    expect(problem({ algorithm, format, scope: 'example.test' })).toBe(
      fits ? null : 'format_algorithm'
    );
  });

  it('keeps identifiers kept from another IdP consistent with their store', () => {
    expect(problem({ stored: 'off' })).toBeNull();
    expect(problem({ stored: 'prefer', store: 'old-idp' })).toBeNull();
    expect(problem({ stored: 'require', store: 'old-idp' })).toBeNull();
    expect(problem({ stored: 'prefer' })).toBe('store');
    expect(problem({ stored: 'require', store: 'BAD' })).toBe('store');
    expect(problem({ stored: 'require', store: 5 })).toBe('store');
    expect(problem({ store: 'old-idp' })).toBe('store');
    expect(problem({ stored: 'off', store: 'old-idp' })).toBe('store');
  });

  it('allows digest and encoding only for shibboleth', () => {
    const shibboleth = { algorithm: 'shibboleth' };
    expect(problem({ ...shibboleth, digest: 'SHA-1' })).toBeNull();
    expect(problem({ ...shibboleth, encoding: 'base32' })).toBeNull();
    expect(problem({ digest: 'SHA-1' })).toBe('digest_or_encoding');
    expect(problem({ encoding: 'base32' })).toBe('digest_or_encoding');
    expect(problem({ digest: 'SHA-1', encoding: 'base32' })).toBe('digest_or_encoding');
  });

  it('validates the scope pattern and requires it for scoped formats', () => {
    expect(problem({ scope: 'example.test' })).toBeNull();
    expect(problem({ scope: 'a' })).toBeNull();
    expect(problem({ scope: `a${'b'.repeat(126)}` })).toBeNull();
    expect(problem({ scope: `a${'b'.repeat(127)}` })).toBe('scope');
    expect(problem({ scope: '' })).toBe('scope');
    expect(problem({ scope: '-a' })).toBe('scope');
    expect(problem({ scope: '.a' })).toBe('scope');
    expect(problem({ scope: 'a_b' })).toBe('scope');
    expect(problem({ scope: 'a b' })).toBe('scope');
    expect(problem({ scope: 'a.b-c' })).toBeNull();
    expect(problem({ scope: 5 })).toBe('scope');
    expect(problem({ scope: 'ok\n' })).toBe('scope');
    expect(problem({ format: 'saml_pairwise_id' })).toBe('scope');
    expect(problem({ format: 'saml_pairwise_id', scope: 'example.test' })).toBeNull();
    const subject = { algorithm: 'simplesamlphp_subject_id', format: 'saml_subject_id' };
    expect(problem(subject)).toBe('scope');
    expect(problem({ ...subject, scope: 'example.test' })).toBeNull();
    const pairwise = { algorithm: 'simplesamlphp_pairwise_id', format: 'saml_pairwise_id' };
    expect(problem(pairwise)).toBe('scope');
    expect(problem({ ...pairwise, scope: 'example.test' })).toBeNull();
  });
});

describe('sharesConsumedInput', () => {
  const ref = (path: string, extra: Partial<FieldRef> = {}): FieldRef => ({
    side: 'canonical',
    namespace: 'authrim.profile',
    path,
    ...extra,
  });
  const pid = (target: FieldRef): MappingTransformStep => ({
    id: 'pid',
    inputEdgeIds: [],
    operation: 'persistent_identifier',
    outputTargetRef: target,
  });
  const other = (target: FieldRef): MappingTransformStep => ({
    id: 'trim',
    inputEdgeIds: ['e'],
    operation: 'trim',
    outputTargetRef: target,
  });
  const edgeTo = (target: FieldRef): MappingRuleEdge => ({
    id: 'e',
    sourceRef: { side: 'source', namespace: 'csv', path: 'in' },
    targetRef: target,
  });

  it('is true when an edge writes the output of an identifier step', () => {
    expect(sharesConsumedInput([pid(ref('sub'))], [edgeTo(ref('sub'))])).toBe(true);
    expect(sharesConsumedInput([other(ref('x')), pid(ref('sub'))], [edgeTo(ref('sub'))])).toBe(
      true
    );
    expect(sharesConsumedInput([pid(ref('a')), pid(ref('b'))], [edgeTo(ref('b'))])).toBe(true);
    expect(sharesConsumedInput([pid(ref('sub'))], [edgeTo(ref('x')), edgeTo(ref('sub'))])).toBe(
      true
    );
  });

  it('is false for other operations, other targets and empty inputs', () => {
    expect(sharesConsumedInput([other(ref('sub'))], [edgeTo(ref('sub'))])).toBe(false);
    expect(sharesConsumedInput([pid(ref('sub'))], [edgeTo(ref('other'))])).toBe(false);
    expect(sharesConsumedInput([pid(ref('sub'))], [])).toBe(false);
    expect(sharesConsumedInput([], [edgeTo(ref('sub'))])).toBe(false);
    expect(sharesConsumedInput()).toBe(false);
    expect(sharesConsumedInput(undefined, [edgeTo(ref('sub'))])).toBe(false);
    expect(sharesConsumedInput([pid(ref('sub'))])).toBe(false);
  });

  it('matches targets by catalog entry id when both have one', () => {
    const left = ref('a', { catalogEntryId: 'field.x' });
    expect(
      sharesConsumedInput(
        [pid(left)],
        [edgeTo(ref('zzz', { side: 'source', catalogEntryId: 'field.x' }))]
      )
    ).toBe(true);
    expect(
      sharesConsumedInput([pid(left)], [edgeTo(ref('a', { catalogEntryId: 'field.y' }))])
    ).toBe(false);
  });

  it('otherwise compares side, namespace and path with side defaulting to source', () => {
    const sourceSide = (path: string, namespace = 'authrim.profile'): FieldRef =>
      ({ namespace, path }) as FieldRef;
    expect(sharesConsumedInput([pid(sourceSide('a'))], [edgeTo(sourceSide('a'))])).toBe(true);
    expect(
      sharesConsumedInput([pid(sourceSide('a'))], [edgeTo(ref('a', { side: 'source' }))])
    ).toBe(true);
    expect(
      sharesConsumedInput([pid(ref('a', { side: 'source' }))], [edgeTo(sourceSide('a'))])
    ).toBe(true);
    expect(sharesConsumedInput([pid(sourceSide('a'))], [edgeTo(ref('a'))])).toBe(false);
    expect(sharesConsumedInput([pid(ref('a'))], [edgeTo(sourceSide('a'))])).toBe(false);
    expect(sharesConsumedInput([pid(sourceSide('a'))], [edgeTo(sourceSide('b'))])).toBe(false);
    expect(sharesConsumedInput([pid(sourceSide('a'))], [edgeTo(sourceSide('a', 'other'))])).toBe(
      false
    );
    expect(
      sharesConsumedInput([pid(ref('a', { catalogEntryId: 'field.x' }))], [edgeTo(ref('a'))])
    ).toBe(true);
    expect(
      sharesConsumedInput([pid(ref('a', { catalogEntryId: 'field.x' }))], [edgeTo(ref('b'))])
    ).toBe(false);
  });
});
