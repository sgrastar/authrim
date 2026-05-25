import { describe, expect, it } from 'vitest';
import {
  applySAMLAttributePresetToSPConfig,
  cloneSAMLAttributeReleasePolicyFromPreset,
  getSAMLAttributePreset,
  normalizeSAMLSPAttributePresetConfig,
  SAML_ATTRIBUTE_PRESET_VERSION,
  SAML_BUILTIN_ATTRIBUTE_PRESETS,
} from '../attribute-presets';
import { NAMEID_FORMATS } from '../../common/constants';

describe('SAML built-in attribute preset catalog', () => {
  it('publishes stable preset identifiers with clone/edit semantics', () => {
    expect(SAML_BUILTIN_ATTRIBUTE_PRESETS.map((preset) => preset.id)).toEqual([
      'basic.v1',
      'academic_publisher.v1',
      'enterprise_saas.v1',
      'research_federation.v1',
    ]);

    for (const preset of SAML_BUILTIN_ATTRIBUTE_PRESETS) {
      expect(preset.version).toBe(SAML_ATTRIBUTE_PRESET_VERSION);
      expect(preset.applicationMode).toBe('clone_edit');
      expect(['stable', 'experimental']).toContain(preset.stability);
      expect(preset.buildRules().length).toBeGreaterThan(0);
    }
  });

  it('includes a basic email/name preset for common SPs', () => {
    const preset = getSAMLAttributePreset('basic.v1');

    expect(preset.label).toBe('Basic Profile');
    expect(preset.buildRules()).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
        source: 'claim',
        claim: 'email',
        required: true,
      },
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
        source: 'claim',
        claim: 'name',
        required: false,
      },
    ]);
  });

  it('returns cloned release policies so saved SP configs can be edited independently', () => {
    const first = cloneSAMLAttributeReleasePolicyFromPreset('academic_publisher.v1');
    const second = cloneSAMLAttributeReleasePolicyFromPreset('academic_publisher.v1');

    first.attributes[0].required = false;

    expect(first.presetId).toBe('academic_publisher.v1');
    expect(first.presetVersion).toBe(SAML_ATTRIBUTE_PRESET_VERSION);
    expect(second.attributes[0].required).toBe(true);
  });

  it('rejects unknown preset ids', () => {
    expect(() => getSAMLAttributePreset('unknown.v1' as never)).toThrow(
      'Unknown SAML attribute preset'
    );
  });

  it('persists preset id and version when applying a preset to an SP config', () => {
    const config = applySAMLAttributePresetToSPConfig(
      {
        entityId: 'https://publisher.example.test/saml/sp',
        acsUrl: 'https://publisher.example.test/saml/acs',
        nameIdFormat: NAMEID_FORMATS.PERSISTENT,
        attributeMapping: {},
        signAssertions: true,
        signResponses: true,
        allowedBindings: ['post'],
      },
      'academic_publisher.v1'
    );

    expect(config.attributePresetId).toBe('academic_publisher.v1');
    expect(config.attributePresetVersion).toBe(SAML_ATTRIBUTE_PRESET_VERSION);
    expect(config.attributeReleasePolicy?.attributes.length).toBeGreaterThan(0);
  });

  it('keeps edited release policy content while filling a missing preset version', () => {
    const config = normalizeSAMLSPAttributePresetConfig({
      entityId: 'https://publisher.example.test/saml/sp',
      acsUrl: 'https://publisher.example.test/saml/acs',
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      attributeMapping: {},
      attributePresetId: 'academic_publisher.v1',
      attributeReleasePolicy: {
        attributes: [
          {
            name: 'urn:example:edited',
            source: 'custom_claim',
            claim: 'edited',
          },
        ],
      },
      signAssertions: true,
      signResponses: true,
      allowedBindings: ['post'],
    });

    expect(config.attributePresetVersion).toBe(SAML_ATTRIBUTE_PRESET_VERSION);
    expect(config.attributeReleasePolicy?.attributes).toEqual([
      {
        name: 'urn:example:edited',
        source: 'custom_claim',
        claim: 'edited',
      },
    ]);
  });
});
