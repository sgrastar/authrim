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

  it('contains the PR1 operation set', () => {
    expect(TRANSFORM_OPERATION_SCHEMAS.map((schema) => schema.operation).sort()).toEqual([
      'affix_text',
      'case',
      'concat',
      'copy',
      'fallback',
      'json_build',
      'json_extract_boolean',
      'json_extract_integer',
      'json_extract_text',
      'normalize',
      'oidc_pairwise_sub',
      'saml_edu_person_targeted_id',
      'text_to_boolean',
      'trim',
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
  });

  it('adds configured prefixes and suffixes to text values', () => {
    const sourceRef = fieldRef('csv', 'orcid_id');
    const targetRef = {
      side: 'destination' as const,
      namespace: 'saml.attribute',
      path: 'eduPersonOrcid',
    };
    const mappingEdge = edge(sourceRef, targetRef);

    expect(
      executeTransformStep({
        step: {
          id: 'transform.orcid.url',
          inputEdgeIds: [mappingEdge.id],
          operation: 'affix_text',
          parameters: { prefix: 'https://orcid.org/', suffix: '' },
          outputTargetRef: targetRef,
        },
        edgeValues: new Map([
          [mappingEdge.id, sourceValue('csv', 'orcid_id', '0000-0002-1825-0097')],
        ]),
      }).value?.value
    ).toBe('https://orcid.org/0000-0002-1825-0097');
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

  it('builds OIDC pairwise sub from runtime client context', () => {
    const targetRef = {
      side: 'destination' as const,
      namespace: 'oidc.claim',
      path: 'sub',
    };
    const result = executeTransformStep({
      step: {
        id: 'transform.oidc.pairwise-sub',
        inputEdgeIds: [],
        operation: 'oidc_pairwise_sub',
        outputTargetRef: targetRef,
      },
      edgeValues: new Map(),
      runtimeContext: {
        oidc: {
          pairwiseSubject: 'pairwise-client-subject',
        },
      },
    });

    expect(result.value?.value).toBe('pairwise-client-subject');
  });

  it('builds SAML eduPersonTargetedID from runtime SP context', () => {
    const targetRef = {
      side: 'destination' as const,
      namespace: 'saml.attribute',
      path: 'eduPersonTargetedID',
    };
    const result = executeTransformStep({
      step: {
        id: 'transform.saml.targeted-id',
        inputEdgeIds: [],
        operation: 'saml_edu_person_targeted_id',
        outputTargetRef: targetRef,
      },
      edgeValues: new Map(),
      runtimeContext: {
        saml: {
          localEntityId: 'https://idp.example.edu/idp/shibboleth',
          partnerEntityId: 'https://sp.example.org/shibboleth-sp',
          eduPersonTargetedIdOpaque: 'opaque-subject',
        },
      },
    });

    expect(result.value?.value).toBe(
      'https://idp.example.edu/idp/shibboleth!https://sp.example.org/shibboleth-sp!opaque-subject'
    );
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
    expect(result.reasons.map((item) => item.code)).toContain('transform.invalid_output');
  });
});
