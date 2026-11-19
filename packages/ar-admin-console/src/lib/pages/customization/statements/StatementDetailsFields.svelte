<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import CheckRow from '#lib/ui/patterns/CheckRow.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import { LEGAL_BASES, LIMITS, type StatementEditorValue } from './statement-model';

	/**
	 * A statement's details, closed until opened: the legal basis, whether agreement can be
	 * withdrawn and what that means, how long records are kept, and how often people are asked
	 * again. On the statement's page, and when one is made from a service flow.
	 */
	type Details = Pick<
		StatementEditorValue,
		'legalBasis' | 'withdrawalAllowed' | 'withdrawalImpact' | 'retentionDays' | 'reconsentDays'
	>;

	interface Props {
		value: Details;
		disabled?: boolean;
		/** True while a number typed is not one that fits (it is not in `value` then). */
		invalid?: boolean;
	}

	let { value = $bindable(), disabled = false, invalid = $bindable(false) }: Props = $props();

	let retentionInvalid = $state(false);
	let intervalInvalid = $state(false);
	$effect(() => {
		invalid = retentionInvalid || intervalInvalid;
	});

	const bases = $derived(
		[...new Set([...LEGAL_BASES, value.legalBasis])].map((basis) => ({
			value: basis,
			label: (LEGAL_BASES as readonly string[]).includes(basis)
				? t(`cs.basis.${basis}` as MessageKey)
				: basis
		}))
	);
</script>

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
			bind:invalid={retentionInvalid}
		/>
		<NumberField
			label={t('cs.details.interval')}
			hint={t('cs.details.intervalHint')}
			unit={t('cs.details.days')}
			min={0}
			{disabled}
			field="reconsentDays"
			bind:value={value.reconsentDays}
			bind:invalid={intervalInvalid}
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
