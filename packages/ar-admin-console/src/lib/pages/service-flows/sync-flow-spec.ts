import {
	aboutFields,
	choices,
	type AccountField,
	type AccountFlowDef,
	type AccountPart,
	type SyncFlowId
} from './flow-spec';

/**
 * The flows that move users between Authrim and another system: SCIM received from it, SCIM sent
 * to it, and a CSV file read in. Defined like the sign-up and sign-in flows (see
 * `account-flow-model.ts`): data, drawn by one form. What the other side is (its name, which
 * system) is the flow's own settings, on the overview; the steps are what Authrim does with each
 * user that passes through: matching it with an account, mapping its fields, giving it a role.
 *
 * A mapping only runs with the set someone chose; for SCIM received it is a step of the flow from
 * the start (a user cannot be brought in without one), elsewhere it is added with the "+".
 */

/**
 * The sync flows offered: SCIM received and a CSV import. SCIM sent is defined below, for when it
 * is supported, but is not offered yet (not in the wizard, not in the list).
 */
export const SYNC_FLOW_IDS: readonly SyncFlowId[] = ['scim-in', 'csv'];

const select = (
	key: string,
	label: AccountField['label'],
	prefix: string,
	values: readonly string[],
	extra: Partial<AccountField> = {}
): AccountField => ({
	key,
	kind: 'select',
	label,
	options: choices(prefix, values),
	required: true,
	...extra
});

/** The mapping and the role assignment: the same settings in each flow, with its own keys. */
function commonParts(prefix: string, withRole = true): Record<string, AccountPart> {
	const parts: Record<string, AccountPart> = {
		[`${prefix}-mapping`]: {
			id: `${prefix}-mapping`,
			label: 'af.part.sync-mapping',
			lead: 'af.lead.sync-mapping',
			note: 'af.note.sync-mapping',
			fields: [
				select(`${prefix}.mappingSet`, 'af.field.mappingSet', 'mappingSet', [
					'tenant-default',
					'staff',
					'minimal'
				])
			]
		}
	};
	// Users sent out already have their roles here: only what comes in is given one.
	if (withRole)
		parts[`${prefix}-role`] = {
			id: `${prefix}-role`,
			label: 'af.part.sync-role',
			lead: 'af.lead.sync-role',
			fields: [select(`${prefix}.role`, 'af.field.role', 'role', ['member', 'editor', 'admin'])]
		};
	return parts;
}

function aboutPart(flow: SyncFlowId, prefix: string): Record<string, AccountPart> {
	return {
		[`${prefix}-about`]: {
			id: `${prefix}-about`,
			label: 'af.part.sync-about',
			lead: 'af.lead.sync-about',
			note: 'af.note.sync-about',
			fields: aboutFields(flow)
		}
	};
}

export const SYNC_PARTS: Record<string, AccountPart> = {
	...aboutPart('scim-in', 'sin'),
	...aboutPart('scim-out', 'sout'),
	...aboutPart('csv', 'csv'),
	...commonParts('sin'),
	...commonParts('sout', false),
	...commonParts('csv'),

	'sin-match': {
		id: 'sin-match',
		label: 'af.part.sin-match',
		lead: 'af.lead.sin-match',
		fields: [
			select('sin.matchKey', 'af.field.matchKey', 'matchKey', ['userName', 'email', 'externalId']),
			select('sin.onMissing', 'af.field.sin.onMissing', 'onMissing', ['create', 'ignore'])
		]
	},
	'sin-update': {
		id: 'sin-update',
		label: 'af.part.sin-update',
		lead: 'af.lead.sin-update',
		fields: [
			select('sin.update', 'af.field.update', 'updatePolicy', ['overwrite', 'merge']),
			select('sin.removed', 'af.field.sin.removed', 'removed', ['deactivate', 'delete', 'keep'])
		]
	},

	'sout-scope': {
		id: 'sout-scope',
		label: 'af.part.sout-scope',
		lead: 'af.lead.sout-scope',
		fields: [
			select('sout.scope', 'af.field.sout.scope', 'syncScope', ['all', 'byRole', 'byGroup']),
			{
				key: 'sout.roles',
				kind: 'checks',
				label: 'af.field.sout.roles',
				options: choices('role', ['member', 'editor', 'admin']),
				required: true,
				showWhen: (values) => values['sout.scope'] === 'byRole'
			},
			{
				key: 'sout.groups',
				kind: 'checks',
				label: 'af.field.sout.groups',
				options: choices('syncGroup', ['engineering', 'sales', 'support']),
				required: true,
				showWhen: (values) => values['sout.scope'] === 'byGroup'
			},
			select('sout.removed', 'af.field.sout.removed', 'removed', ['deactivate', 'delete', 'keep'])
		]
	},
	'sout-timing': {
		id: 'sout-timing',
		label: 'af.part.sout-timing',
		lead: 'af.lead.sout-timing',
		fields: [
			select('sout.timing', 'af.field.sout.timing', 'timing', ['onChange', 'hourly', 'daily']),
			select('sout.onError', 'af.field.sout.onError', 'onError', ['retry', 'stop'])
		]
	},

	'csv-format': {
		id: 'csv-format',
		label: 'af.part.csv-format',
		lead: 'af.lead.csv-format',
		fields: [
			select('csv.delimiter', 'af.field.csv.delimiter', 'delimiter', ['comma', 'tab', 'semicolon']),
			select('csv.header', 'af.field.csv.header', 'header', ['yes', 'no']),
			select('csv.encoding', 'af.field.csv.encoding', 'encoding', ['utf8', 'sjis'])
		]
	},
	'csv-match': {
		id: 'csv-match',
		label: 'af.part.csv-match',
		lead: 'af.lead.csv-match',
		fields: [
			select('csv.matchKey', 'af.field.matchKey', 'matchKey', ['email', 'employeeId', 'userName']),
			select('csv.onMissing', 'af.field.csv.onMissing', 'onMissing', ['create', 'ignore']),
			select('csv.onExisting', 'af.field.csv.onExisting', 'onExisting', [
				'overwrite',
				'skip',
				'fill'
			])
		]
	}
};

export const SYNC_FLOWS: Record<SyncFlowId, AccountFlowDef> = {
	'scim-in': {
		id: 'scim-in',
		title: 'af.flow.scim-in.title',
		subtitle: 'af.flow.scim-in.subtitle',
		summary: 'af.flow.scim-in.summary',
		start: { title: 'af.flow.scim-in.start', detail: 'af.flow.scim-in.startDetail' },
		end: { title: 'af.flow.syncEnd', detail: 'af.flow.syncEndDetail' },
		groups: [
			{ id: 'match', label: 'af.group.syncMatch', parts: ['sin-match', 'sin-update'] },
			{ id: 'mapping', label: 'af.group.syncMapping', parts: ['sin-mapping'] },
			{ id: 'role', label: 'af.group.syncRole', parts: ['sin-role'], optional: true }
		]
	},
	'scim-out': {
		id: 'scim-out',
		title: 'af.flow.scim-out.title',
		subtitle: 'af.flow.scim-out.subtitle',
		summary: 'af.flow.scim-out.summary',
		start: { title: 'af.flow.scim-out.start', detail: 'af.flow.syncEndDetail' },
		end: { title: 'af.flow.scim-out.end', detail: 'af.flow.scim-out.endDetail' },
		run: 'scim-out',
		groups: [
			{ id: 'scope', label: 'af.group.syncScope', parts: ['sout-scope'] },
			{
				id: 'mapping',
				label: 'af.group.syncMapping',
				parts: ['sout-mapping'],
				optional: true
			},
			{ id: 'timing', label: 'af.group.syncTiming', parts: ['sout-timing'] }
		]
	},
	csv: {
		id: 'csv',
		title: 'af.flow.csv.title',
		subtitle: 'af.flow.csv.subtitle',
		summary: 'af.flow.csv.summary',
		start: { title: 'af.flow.csv.start', detail: 'af.flow.csv.startDetail' },
		end: { title: 'af.flow.syncEnd', detail: 'af.flow.syncEndDetail' },
		run: 'csv',
		groups: [
			{ id: 'format', label: 'af.group.csvFormat', parts: ['csv-format'] },
			{ id: 'match', label: 'af.group.syncMatch', parts: ['csv-match'] },
			{
				id: 'mapping',
				label: 'af.group.syncMapping',
				parts: ['csv-mapping'],
				optional: true
			},
			{ id: 'role', label: 'af.group.syncRole', parts: ['csv-role'], optional: true }
		]
	}
};
