import { describe, expect, it } from 'vitest';
import { buildSalesforceSamlPreviewSample } from '../sample-data';

describe('identity mapping preview sample', () => {
	it('keeps the three-lane graph connected through canonical targets', () => {
		const sample = buildSalesforceSamlPreviewSample();
		const sourceIds = new Set(
			sample.nodes.filter((node) => node.role === 'source').map((node) => node.id)
		);
		const targetIds = new Set(
			sample.nodes.filter((node) => node.role === 'target').map((node) => node.id)
		);
		const destinationIds = new Set(
			sample.nodes.filter((node) => node.role === 'destination').map((node) => node.id)
		);

		expect(sourceIds.size).toBeGreaterThan(20);
		expect(targetIds.size).toBeGreaterThan(8);
		expect(destinationIds.size).toBeGreaterThan(3);
		expect(sample.edges.some((edge) => sourceIds.has(edge.from) && targetIds.has(edge.to))).toBe(
			true
		);
		expect(
			sample.edges.some((edge) => targetIds.has(edge.from) && destinationIds.has(edge.to))
		).toBe(true);
	});

	it('does not infer an OIDC subject from imported login columns', () => {
		const sample = buildSalesforceSamlPreviewSample();
		const usernameRule = sample.rules['rule-sf-user-username'];

		expect(usernameRule.target).toContain('identity_bindings.provider_subject_key_hash');
		expect(usernameRule.destination).not.toContain('OIDC ID token');
		expect(usernameRule.release).toBe('sample policy preview only');
	});

	it('keeps attribute release consent preview separate from raw values', () => {
		const sample = buildSalesforceSamlPreviewSample();
		const emailRule = sample.rules['rule-sf-user-email'];
		const departmentRule = sample.rules['rule-sf-user-department'];

		expect(emailRule.consentStatus).toBe('required');
		expect(emailRule.legalBasis).toBe('consent');
		expect(emailRule.consentMode).toBe('until_attributes_change');
		expect(emailRule.attributeSetHash).toMatch(/^attrset_/);
		expect(departmentRule.consentStatus).toBe('not_required');
		expect(JSON.stringify(emailRule)).not.toContain('person@example');
	});
});
