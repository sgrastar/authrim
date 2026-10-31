import { t, type MessageKey } from '$lib/i18n/i18n.svelte';

/**
 * The pieces every table-defined flow is made of (sign-up, sign-in, and the user sync flows of
 * SCIM and CSV): what a setting looks like, how a step groups settings, what a flow is. The flows
 * themselves are in `account-flow-model.ts` and `sync-flow-spec.ts`.
 */
/** The flows that sign people up and in. */
export type AccountFlowId = 'registration' | 'login';
/** The flows that bring users in or send them out: SCIM and CSV. */
export type SyncFlowId = 'scim-in' | 'scim-out' | 'csv';
export type FlowId = AccountFlowId | SyncFlowId;

/** The part of each field key that belongs to the flow (`reg.name`, `sout.timing`). */
export const FLOW_PREFIX: Record<FlowId, string> = {
	registration: 'reg',
	login: 'login',
	'scim-in': 'sin',
	'scim-out': 'sout',
	csv: 'csv'
};

export function isSyncFlow(flow: FlowId): flow is SyncFlowId {
	return flow === 'scim-in' || flow === 'scim-out' || flow === 'csv';
}

export type AccountValue = string | string[];

/** What has been set in one flow: the values by field, and the optional steps that were added. */
export interface AccountFlowState {
	values: Record<string, AccountValue>;
	added: string[];
}

export function emptyFlowState(): AccountFlowState {
	return { values: {}, added: [] };
}

export interface AccountChoice {
	value: string;
	label: string;
}

export interface AccountField {
	key: string;
	kind: 'select' | 'checks' | 'text';
	/** The label of a select, the heading of a group of checkboxes. */
	label: MessageKey;
	hint?: MessageKey;
	/** The choices, in the current language (none for a text field). */
	options: () => AccountChoice[];
	/** The setting is not done until this has a value (while it is shown). */
	required?: boolean;
	/** Shown only for some values of the fields before it. */
	showWhen?: (values: Record<string, AccountValue>) => boolean;
}

export interface AccountPart {
	id: string;
	label: MessageKey;
	lead: MessageKey;
	/** A fact about how the step behaves that is not a choice. */
	note?: MessageKey;
	fields: readonly AccountField[];
}

export interface AccountGroup {
	id: string;
	label: MessageKey;
	parts: readonly string[];
	/** Not there at first: added with the flow's "+" and taken away again with its ×. */
	optional?: boolean;
}

export interface AccountFlowDef {
	id: FlowId;
	title: MessageKey;
	subtitle: MessageKey;
	summary: MessageKey;
	start: { title: MessageKey; detail: MessageKey };
	end: { title: MessageKey; detail: MessageKey };
	groups: readonly AccountGroup[];
	/** The flow can be run from its overview (a one-shot run). */
	run?: 'csv' | 'scim-out';
}

/** Choices whose texts are the keys `af.<prefix>.<value>`. */
export function choices(prefix: string, values: readonly string[]): () => AccountChoice[] {
	return () => values.map((value) => ({ value, label: t(`af.${prefix}.${value}` as MessageKey) }));
}

export const includes = (key: string, value: string) => (values: Record<string, AccountValue>) =>
	Array.isArray(values[key]) && values[key].includes(value);

/**
 * The flow's own settings: its name, and the second thing it needs. A sign-up or sign-in flow
 * says where it is used; a sync flow says which system is on the other side. What the wizard
 * asks, and the frame of general settings on the overview.
 */
export function aboutFields(flow: FlowId): AccountField[] {
	const prefix = FLOW_PREFIX[flow];
	const name: AccountField = {
		key: `${prefix}.name`,
		kind: 'text',
		label: 'af.field.name',
		options: () => [],
		required: true
	};
	return [
		name,
		isSyncFlow(flow)
			? {
					key: `${prefix}.partner`,
					kind: 'text',
					label: 'af.field.partner',
					options: () => [],
					required: true
				}
			: {
					key: `${prefix}.scope`,
					kind: 'select',
					label: 'af.field.scope',
					options: choices('scope', ['default-ui', 'other-ui']),
					required: true
				}
	];
}
