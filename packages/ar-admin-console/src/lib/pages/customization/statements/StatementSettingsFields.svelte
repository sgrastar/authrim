<script lang="ts">
	import type { ConsentStatement } from '#lib/api/consent-statements.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckRow from '#lib/ui/patterns/CheckRow.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import {
		CATEGORY_KINDS,
		LEGAL_BASES,
		LIMITS,
		versionLabel,
		type StatementEditorValue
	} from './statement-model';

	/**
	 * A statement's own settings. Basic: its key (it does not change) and kind. Details, closed
	 * until opened: the legal basis, whether agreement can be withdrawn and what that means, how
	 * long records are kept, and how often people are asked again.
	 */
	interface Props {
		statement: ConsentStatement;
		value: StatementEditorValue;
		disabled?: boolean;
	}

	let { statement, value = $bindable(), disabled = false }: Props = $props();

	const kinds = $derived(
		CATEGORY_KINDS.map((kind) => ({ value: kind, label: t(`cs.kind.${kind}` as MessageKey) }))
	);
	const bases = $derived(
		[...new Set([...LEGAL_BASES, value.legalBasis])].map((basis) => ({
			value: basis,
			label: (LEGAL_BASES as readonly string[]).includes(basis)
				? t(`cs.basis.${basis}` as MessageKey)
				: basis
		}))
	);
</script>

<Card title={t('cs.basic.title')}>
	<div class="settings">
		<DetailList ruled>
			<DetailItem label={t('cs.basic.slug')}><code>{statement.slug}</code></DetailItem>
			{#if statement.required_consent_version}
				<DetailItem label={t('cs.basic.required')}>
					{versionLabel(statement.required_consent_version)}
				</DetailItem>
			{/if}
		</DetailList>
		<Select
			label={t('cs.basic.kind')}
			options={kinds}
			{disabled}
			field="category"
			bind:value={value.category}
		/>
	</div>
</Card>

<Disclosure title={t('cs.details.title')} description={t('cs.details.intro')} boxed>
	<div class="settings">
		<Select
			label={t('cs.details.basis')}
			info={t('cs.details.basisInfo')}
			options={bases}
			{disabled}
			field="legalBasis"
			bind:value={value.legalBasis}
		/>
		<CheckRow
			label={t('cs.details.withdrawal')}
			text={t('cs.details.withdrawalText')}
			description={t('cs.details.withdrawalInfo')}
			{disabled}
			field="withdrawalAllowed"
			bind:checked={value.withdrawalAllowed}
		/>
		<TextArea
			label={t('cs.details.impact')}
			hint={t('cs.details.impactHint')}
			rows={3}
			maxlength={LIMITS.impact}
			disabled={disabled || !value.withdrawalAllowed}
			field="withdrawalImpact"
			bind:value={value.withdrawalImpact}
		/>
		<NumberField
			label={t('cs.details.retention')}
			hint={t('cs.details.retentionHint')}
			unit={t('cs.details.days')}
			min={0}
			{disabled}
			field="retentionDays"
			bind:value={value.retentionDays}
		/>
		<NumberField
			label={t('cs.details.interval')}
			hint={t('cs.details.intervalHint')}
			unit={t('cs.details.days')}
			min={0}
			{disabled}
			field="reconsentDays"
			bind:value={value.reconsentDays}
		/>
	</div>
</Disclosure>

<style>
	.settings {
		display: grid;
		gap: var(--space-related);
		min-inline-size: 0;
	}
</style>
