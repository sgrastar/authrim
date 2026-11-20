<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import EditableTable, { type EditColumn } from '#lib/ui/patterns/EditableTable.svelte';
	import {
		ATTRIBUTE_NAME_FORMATS,
		CLASSIFICATIONS,
		LEGAL_BASES,
		MULTIPLICITIES,
		VALUE_TYPES,
		emptyRow,
		type ProfileRow
	} from './destination-profile-model';
	import type { DestinationProtocol } from './templates/types';

	/**
	 * The attributes (SAML) or claims (OIDC) of an output source as a table edited in place. The
	 * columns every profile needs are always there; the rest (name format, classification) are
	 * shown with "Advanced". Rows can be pasted from a spreadsheet.
	 */
	interface Props {
		protocol: DestinationProtocol;
		rows: ProfileRow[];
		invalid?: boolean;
		disabled?: boolean;
	}
	let { protocol, rows = $bindable(), invalid = $bindable(false) }: Props = $props();

	let advanced = $state(false);
	const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

	const columns = $derived<EditColumn[]>([
		{
			key: 'key',
			label: t(protocol === 'saml' ? 'sf.dp.col.attribute' : 'sf.dp.col.claim'),
			kind: 'text',
			mono: true,
			required: true,
			unique: true,
			width: '26%'
		},
		{ key: 'label', label: t('sf.dp.col.label'), kind: 'text', width: '16%' },
		{
			key: 'valueType',
			label: t('sf.dp.col.type'),
			kind: 'select',
			options: options(VALUE_TYPES),
			width: '9rem'
		},
		{
			key: 'allowedValues',
			label: t('sf.dp.col.allowed'),
			kind: 'text',
			placeholder: t('sf.dp.col.allowedHint'),
			width: '16%'
		},
		{
			key: 'multiplicity',
			label: t('sf.dp.col.multiplicity'),
			kind: 'select',
			options: options(MULTIPLICITIES),
			width: '8rem'
		},
		{ key: 'nullable', label: t('sf.dp.col.nullable'), kind: 'checkbox', width: '6rem' },
		...(protocol === 'oidc'
			? ([
					{ key: 'scopes', label: t('sf.dp.col.scopes'), kind: 'text', width: '12%' },
					{ key: 'required', label: t('sf.dp.col.required'), kind: 'checkbox', width: '6rem' },
					{ key: 'idToken', label: t('sf.dp.col.idToken'), kind: 'checkbox', width: '7rem' },
					{ key: 'userinfo', label: t('sf.dp.col.userinfo'), kind: 'checkbox', width: '7rem' }
				] satisfies EditColumn[])
			: []),
		...(advanced
			? ([
					...(protocol === 'saml'
						? [
								{
									key: 'nameFormat',
									label: t('sf.dp.col.nameFormat'),
									kind: 'select',
									options: options(ATTRIBUTE_NAME_FORMATS),
									width: '16rem'
								} satisfies EditColumn
							]
						: []),
					{
						key: 'classification',
						label: t('sf.dp.col.classification'),
						kind: 'select',
						options: options(CLASSIFICATIONS),
						width: '9rem'
					},
					...(protocol === 'saml'
						? [
								{
									key: 'legalBasis',
									label: t('sf.dp.col.legalBasis'),
									kind: 'select',
									options: [{ value: '', label: '—' }, ...options(LEGAL_BASES)],
									width: '11rem'
								} satisfies EditColumn
							]
						: [])
				] satisfies EditColumn[])
			: [])
	]);
</script>

<div class="table">
	<div class="table__tools">
		<Checkbox bind:checked={advanced}>{t('sf.dp.advanced')}</Checkbox>
	</div>
	<EditableTable
		label={t(protocol === 'saml' ? 'sf.dp.table.saml' : 'sf.dp.table.oidc')}
		{columns}
		bind:rows
		makeRow={() => emptyRow(protocol)}
		rowName={(row) => row.key}
		addLabel={t(protocol === 'saml' ? 'sf.dp.addAttribute' : 'sf.dp.addClaim')}
		bind:invalid
	/>
</div>

<style>
	.table {
		display: grid;
		gap: var(--space-related);
	}

	.table__tools {
		display: flex;
		justify-content: flex-end;
	}
</style>
