import { describe, expect, it } from 'vitest';
import {
	conditionParamsForSave,
	initialConditionParams,
	type ConditionTypeMetadata
} from './admin-policies';

const validDuring = {
	type: 'valid_during',
	category: 'time',
	label: 'Valid During',
	description: '',
	params: [
		{ name: 'from', type: 'number', required: false, label: 'From' },
		{ name: 'to', type: 'number', required: false, label: 'To' }
	]
} as ConditionTypeMetadata;

const hasRole = {
	type: 'has_role',
	category: 'rbac',
	label: 'Has Role',
	description: '',
	params: [
		{ name: 'role', type: 'string', required: true, label: 'Role' },
		{ name: 'scope', type: 'string', required: false, label: 'Scope' },
		{ name: 'scopeTarget', type: 'string', required: false, label: 'Scope Target' }
	]
} as ConditionTypeMetadata;

const attributeEquals = {
	type: 'attribute_equals',
	category: 'abac',
	label: 'Attribute Equals',
	description: '',
	params: [
		{ name: 'name', type: 'string', required: true, label: 'Name' },
		{ name: 'value', type: 'string', required: true, label: 'Value' },
		{ name: 'checkExpiry', type: 'boolean', required: false, label: 'Check expiry' }
	]
} as ConditionTypeMetadata;

describe('the condition form', () => {
	it('starts numbers and switches unset, not at 0', () => {
		expect(initialConditionParams(validDuring)).toEqual({ from: undefined, to: undefined });
	});

	it('saves only the date bounds that were entered', () => {
		const start = { ...initialConditionParams(validDuring), from: 2000000000 };
		expect(conditionParamsForSave(validDuring, start)).toEqual({ from: 2000000000 });
		const end = { ...initialConditionParams(validDuring), to: 2000003600 };
		expect(conditionParamsForSave(validDuring, end)).toEqual({ to: 2000003600 });
		expect(conditionParamsForSave(validDuring, initialConditionParams(validDuring))).toEqual({});
	});

	it('leaves out optional text left empty, and keeps required values', () => {
		const values = { ...initialConditionParams(hasRole), role: 'auditor' };
		expect(conditionParamsForSave(hasRole, values)).toEqual({ role: 'auditor' });
		// A required value left empty is sent, so the server can say what is missing.
		expect(conditionParamsForSave(hasRole, initialConditionParams(hasRole))).toEqual({ role: '' });
	});

	it('leaves an untouched switch at its default', () => {
		const values = { ...initialConditionParams(attributeEquals), name: 'tier', value: 'premium' };
		expect(conditionParamsForSave(attributeEquals, values)).toEqual({
			name: 'tier',
			value: 'premium'
		});
	});
});
