/**
 * Rules of the access check page (Access → Access check), kept out of the component.
 */
import type { AccessCheckInput } from '#lib/api/access-check.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

/** `resource:action`: two parts without spaces (the resource's id has its own field). */
export const CHECK_PERMISSION_PATTERN = /^[^\s:]+:[^\s:]+$/;

export interface AccessCheckForm {
	subject_id: string;
	permission: string;
	resource_id: string;
	resource_group_id: string;
	/** A relationship to check too (ReBAC): its relation and object, both or neither. */
	rebac_relation: string;
	rebac_object: string;
}

export const EMPTY_FORM: AccessCheckForm = {
	subject_id: '',
	permission: '',
	resource_id: '',
	resource_group_id: '',
	rebac_relation: '',
	rebac_object: ''
};

export interface FormProblems {
	subject?: MessageKey;
	permission?: MessageKey;
	resource?: MessageKey;
	rebac?: MessageKey;
}

export function formProblems(form: AccessCheckForm): FormProblems {
	const problems: FormProblems = {};
	if (!form.subject_id.trim()) problems.subject = 'acc.form.subjectRequired';
	if (!form.permission.trim()) problems.permission = 'acc.form.permissionRequired';
	else if (!CHECK_PERMISSION_PATTERN.test(form.permission.trim()))
		problems.permission = 'acc.form.permissionInvalid';
	if (/[\s:]/.test(form.resource_id.trim())) problems.resource = 'acc.form.resourceInvalid';
	if (Boolean(form.rebac_relation.trim()) !== Boolean(form.rebac_object.trim()))
		problems.rebac = 'acc.form.rebacIncomplete';
	return problems;
}

export function checkInput(form: AccessCheckForm): AccessCheckInput {
	const optional = (value: string) => (value.trim() ? value.trim() : undefined);
	return {
		subject_id: form.subject_id.trim(),
		permission: form.permission.trim(),
		resource_id: optional(form.resource_id),
		resource_group_id: optional(form.resource_group_id),
		...(form.rebac_relation.trim() && form.rebac_object.trim()
			? { rebac: { relation: form.rebac_relation.trim(), object: form.rebac_object.trim() } }
			: {})
	};
}

/**
 * What was asked, frozen when the check is sent: the result is shown with this, never with the
 * form as it is now (the admin may already be typing the next question).
 */
export interface AskedCheck {
	subjectId: string;
	subjectLabel: string;
	permission: string;
	resourceId: string | null;
	resourceGroup: string | null;
	rebac: string | null;
}

export function askedCheck(
	form: AccessCheckForm,
	subjectLabel: string,
	resourceGroupLabel: string
): AskedCheck {
	const input = checkInput(form);
	return {
		subjectId: input.subject_id,
		subjectLabel: subjectLabel.trim() || input.subject_id,
		permission: input.permission,
		resourceId: input.resource_id ?? null,
		resourceGroup: input.resource_group_id ? resourceGroupLabel || input.resource_group_id : null,
		rebac: input.rebac ? `${input.rebac.relation} ${input.rebac.object}` : null
	};
}

const VIA: Readonly<Record<string, MessageKey>> = {
	direct: 'acc.via.direct',
	role: 'acc.via.role',
	group_role: 'acc.via.groupRole',
	rebac: 'acc.via.rebac',
	id_level: 'acc.via.idLevel',
	computed: 'acc.via.computed'
};

/** The way a check was allowed, in the admin's words; an unknown one keeps the API's name. */
export const viaLabel = (via: string): MessageKey | null => VIA[via] ?? null;
