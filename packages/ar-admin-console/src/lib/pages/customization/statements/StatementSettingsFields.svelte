<script lang="ts">
	import type { ConsentStatement } from '#lib/api/consent-statements.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import StatementDetailsFields from './StatementDetailsFields.svelte';
	import { CATEGORY_KINDS, versionLabel, type StatementEditorValue } from './statement-model';

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

<StatementDetailsFields bind:value {disabled} />

<style>
	.settings {
		display: grid;
		gap: var(--space-related);
		min-inline-size: 0;
	}
</style>
