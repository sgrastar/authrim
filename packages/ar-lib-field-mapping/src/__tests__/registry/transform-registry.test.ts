import { describe, expect, it } from 'vitest';
import {
  TRANSFORM_OPERATION_SCHEMAS,
  executeTransformStep,
  validateTransformRegistry,
  validateTransformStep,
} from '../../core/transforms';
import type { MappingTransformStep } from '../../core/types';
import { edge, fieldRef, sourceValue } from '../../test-support';

describe('transform registry', () => {
  it('has unique operation schemas', () => {
    expect(validateTransformRegistry()).toEqual([]);
  });

  it('returns structured reason codes for invalid transform parameters', () => {
    const step: MappingTransformStep = {
      id: 'transform.test',
      inputEdgeIds: ['edge.test'],
      operation: 'case',
      parameters: { mode: 'capitalize', extra: true },
      outputTargetRef: { side: 'canonical', namespace: 'authrim.profile', path: 'displayName' },
    };
    const result = validateTransformStep(step);

    expect(result.reasons.map((item) => item.code)).toEqual([
      'transform.invalid_parameter',
      'transform.unknown_parameter',
    ]);

    expect(executeTransformStep({ step, edgeValues: new Map() }).value).toBeUndefined();
  });

  it('contains the registered operation set', () => {
    expect(TRANSFORM_OPERATION_SCHEMAS.map((schema) => schema.operation).sort()).toEqual([
      'affix_text',
      'array_build',
      'as_array',
      'ascii_digits',
      'case',
      'concat',
      'conditional',
      'constant_boolean',
      'constant_number',
      'constant_text',
      'copy',
      'date_format',
      'default_if_empty',
      'fallback',
      'filter_values',
      'first',
      'has_value',
      'hash',
      'join',
      'json_build',
      'json_extract_array',
      'json_extract_boolean',
      'json_extract_integer',
      'json_extract_or',
      'json_extract_text',
      'keep_part',
      'normalize',
      'normalize_empty',
      'persistent_identifier',
      'regex_replace',
      'remove_text',
      'replace_text',
      'split',
      'strip_accents',
      'text_to_boolean',
      'text_to_number',
      'to_fullwidth',
      'to_halfwidth',
      'trim',
      'value_map',
    ]);
  });

  it('executes PR1 transform operations', () => {
    const sourceRef = fieldRef('csv', 'email');
    const targetRef = { side: 'canonical' as const, namespace: 'authrim.profile', path: 'email' };
    const mappingEdge = edge(sourceRef, targetRef);
    const edgeValues = new Map([
      [mappingEdge.id, sourceValue('csv', 'email', ' USER@EXAMPLE.TEST ')],
    ]);

    expect(
      executeTransformStep({
        step: {
          id: 'transform.email.trim',
          inputEdgeIds: [mappingEdge.id],
          operation: 'trim',
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe('USER@EXAMPLE.TEST');

    expect(
      executeTransformStep({
        step: {
          id: 'transform.email.case',
          inputEdgeIds: [mappingEdge.id],
          operation: 'case',
          parameters: { mode: 'lower' },
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe(' user@example.test ');

    expect(
      executeTransformStep({
        step: {
          id: 'transform.email.affix',
          inputEdgeIds: [mappingEdge.id],
          operation: 'affix_text',
          parameters: { prefix: 'mailto:', suffix: '' },
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe('mailto:USER@EXAMPLE.TEST');
  });

  it('converts configured text tokens to nullable booleans', () => {
    const sourceRef = fieldRef('csv', 'active');
    const targetRef = { side: 'canonical' as const, namespace: 'authrim.profile', path: 'active' };
    const mappingEdge = edge(sourceRef, targetRef);
    const step: MappingTransformStep = {
      id: 'transform.active.text-to-boolean',
      inputEdgeIds: [mappingEdge.id],
      operation: 'text_to_boolean',
      parameters: {
        trueValues: '利用中,enabled',
        falseValues: '停止,inactive',
        nullValues: '未確認,unknown',
      },
      outputTargetRef: targetRef,
    };

    expect(
      executeTransformStep({
        step,
        edgeValues: new Map([[mappingEdge.id, sourceValue('csv', 'active', '利用中')]]),
      }).value?.value
    ).toBe(true);
    expect(
      executeTransformStep({
        step,
        edgeValues: new Map([[mappingEdge.id, sourceValue('csv', 'active', '停止')]]),
      }).value?.value
    ).toBe(false);
    expect(
      executeTransformStep({
        step,
        edgeValues: new Map([[mappingEdge.id, sourceValue('csv', 'active', '未確認')]]),
      }).value?.value
    ).toBeNull();
  });

  it('converts between single and multi values with array cleanup options', () => {
    const sourceRef = fieldRef('csv', 'affiliation');
    const targetRef = {
      side: 'destination' as const,
      namespace: 'saml.attribute',
      path: 'eduPersonAffiliation',
    };
    const mappingEdge = edge(sourceRef, targetRef);
    const edgeValues = new Map([
      [mappingEdge.id, sourceValue('csv', 'affiliation', ' student, faculty,student, ')],
    ]);

    expect(
      executeTransformStep({
        step: {
          id: 'transform.affiliation.split',
          inputEdgeIds: [mappingEdge.id],
          operation: 'split',
          parameters: { delimiter: ',', trimItems: true, omitEmpty: true, unique: true },
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toEqual(['student', 'faculty']);

    expect(
      executeTransformStep({
        step: {
          id: 'transform.affiliation.join',
          inputEdgeIds: [mappingEdge.id],
          operation: 'join',
          parameters: { delimiter: ';', trimItems: true, omitEmpty: true, unique: true },
          outputTargetRef: targetRef,
        },
        edgeValues: new Map([
          [
            mappingEdge.id,
            sourceValue('csv', 'affiliation', [' student ', '', 'faculty', 'student']),
          ],
        ]),
      }).value?.value
    ).toBe('student;faculty');

    expect(
      executeTransformStep({
        step: {
          id: 'transform.affiliation.first',
          inputEdgeIds: [mappingEdge.id],
          operation: 'first',
          parameters: { trimItems: true, omitEmpty: true },
          outputTargetRef: targetRef,
        },
        edgeValues: new Map([
          [mappingEdge.id, sourceValue('csv', 'affiliation', ['', ' primary@example.test '])],
        ]),
      }).value?.value
    ).toBe('primary@example.test');

    expect(
      executeTransformStep({
        step: {
          id: 'transform.affiliation.as-array',
          inputEdgeIds: [mappingEdge.id],
          operation: 'as_array',
          parameters: { trimItems: true, omitEmpty: true },
          outputTargetRef: targetRef,
        },
        edgeValues: new Map([[mappingEdge.id, sourceValue('csv', 'affiliation', ' staff ')]]),
      }).value?.value
    ).toEqual(['staff']);
  });

  it('builds JSON from multiple source values and parses single JSON text inputs', () => {
    const departmentRef = fieldRef('csv', 'department');
    const rolesRef = fieldRef('csv', 'roles');
    const targetRef = { side: 'canonical' as const, namespace: 'authrim.profile', path: 'profile' };
    const departmentEdge = edge(departmentRef, targetRef);
    const rolesEdge = edge(rolesRef, targetRef);
    const multiStep: MappingTransformStep = {
      id: 'transform.profile.json-build',
      inputEdgeIds: [departmentEdge.id, rolesEdge.id],
      operation: 'json_build',
      parameters: {
        keyMap: '{"department":"departmentName","roles":"roles"}',
        nullHandling: 'omit',
      },
      outputTargetRef: targetRef,
    };

    expect(
      executeTransformStep({
        step: multiStep,
        edgeValues: new Map([
          [departmentEdge.id, sourceValue('csv', 'department', 'library')],
          [rolesEdge.id, sourceValue('csv', 'roles', '["patron","staff"]')],
        ]),
      }).value?.value
    ).toEqual({ departmentName: 'library', roles: ['patron', 'staff'] });

    const jsonEdge = edge(fieldRef('csv', 'profile'), targetRef);
    expect(
      executeTransformStep({
        step: {
          id: 'transform.profile.parse-json',
          inputEdgeIds: [jsonEdge.id],
          operation: 'json_build',
          parameters: { nullHandling: 'omit' },
          outputTargetRef: targetRef,
        },
        edgeValues: new Map([[jsonEdge.id, sourceValue('csv', 'profile', '{"active":true}')]]),
      }).value?.value
    ).toEqual({ active: true });
  });

  it('extracts typed values from JSON inputs', () => {
    const sourceRef = fieldRef('csv', 'profile');
    const targetRef = { side: 'canonical' as const, namespace: 'authrim.profile', path: 'profile' };
    const mappingEdge = edge(sourceRef, targetRef);
    const edgeValues = new Map([
      [
        mappingEdge.id,
        sourceValue('csv', 'profile', {
          active: 'yes',
          quota: { limit: '42' },
          emails: [{ value: 'user@example.test' }],
        }),
      ],
    ]);

    expect(
      executeTransformStep({
        step: {
          id: 'transform.profile.email',
          inputEdgeIds: [mappingEdge.id],
          operation: 'json_extract_text',
          parameters: { path: 'emails[0].value' },
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe('user@example.test');
    expect(
      executeTransformStep({
        step: {
          id: 'transform.profile.active',
          inputEdgeIds: [mappingEdge.id],
          operation: 'json_extract_boolean',
          parameters: { path: 'active' },
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe(true);
    expect(
      executeTransformStep({
        step: {
          id: 'transform.profile.limit',
          inputEdgeIds: [mappingEdge.id],
          operation: 'json_extract_integer',
          parameters: { path: 'quota.limit' },
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe(42);
  });

  it('rejects oversized transform parameters before execution', () => {
    const step: MappingTransformStep = {
      id: 'transform.profile.path',
      inputEdgeIds: ['edge.profile'],
      operation: 'json_extract_text',
      parameters: { path: `profile.${'x'.repeat(512)}` },
      outputTargetRef: {
        side: 'canonical',
        namespace: 'authrim.profile',
        path: 'profile',
      },
    };

    const validation = validateTransformStep(step);
    expect(validation.reasons.map((item) => item.code)).toContain('transform.invalid_parameter');
    expect(executeTransformStep({ step, edgeValues: new Map() }).value).toBeUndefined();
  });

  it('does not parse JSON transform inputs above the runtime budget', () => {
    const sourceRef = fieldRef('csv', 'profile');
    const targetRef = { side: 'canonical' as const, namespace: 'authrim.profile', path: 'profile' };
    const mappingEdge = edge(sourceRef, targetRef);
    const largeJson = JSON.stringify({
      payload: 'x'.repeat(33 * 1024),
    });

    const result = executeTransformStep({
      step: {
        id: 'transform.profile.parse-json',
        inputEdgeIds: [mappingEdge.id],
        operation: 'json_build',
        parameters: { nullHandling: 'omit' },
        outputTargetRef: targetRef,
      },
      edgeValues: new Map([[mappingEdge.id, sourceValue('csv', 'profile', largeJson)]]),
    });

    expect(result.value).toBeUndefined();
    expect(result.reasons.map((item) => item.code)).toContain('transform.limit_exceeded');
  });
});
