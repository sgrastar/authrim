<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DurationField from '#lib/ui/primitives/DurationField.svelte';

	/**
	 * How a SAML partner's metadata is kept current: read again on a schedule, or only by hand, and
	 * when it was last read. Dummy: "Read it now" only pretends.
	 */
	interface Props {
		mode: 'automatic' | 'manual';
		interval: number | null;
	}

	let { mode = $bindable(), interval = $bindable() }: Props = $props();

	let lastRead = $state('2026-11-13 09:12');
	let reading = $state(false);

	async function readNow() {
		reading = true;
		await new Promise((resolve) => setTimeout(resolve, 300));
		lastRead = '2026-11-13 10:00';
		reading = false;
	}
</script>

<SelectRow
	label={t('cs.row.metadataRefresh')}
	value={mode}
	onchange={(value) => (mode = value as 'automatic' | 'manual')}
	options={[
		{ value: 'automatic', label: t('cs.refresh.automatic') },
		{ value: 'manual', label: t('cs.refresh.manual') }
	]}
/>
{#if mode === 'automatic'}
	<FieldRow label={t('cs.row.metadataInterval')} plain>
		<DurationField
			label={t('cs.row.metadataInterval')}
			hideLabel
			min={3600}
			max={604800}
			units={['hours', 'days']}
			bind:value={interval}
		/>
	</FieldRow>
{/if}
<DetailList columns={1} ruled>
	<DetailItem label={t('cs.row.lastRead')}>
		{lastRead}
		<Badge tone="success" dot>{t('cs.refresh.ok')}</Badge>
		{#snippet end()}
			<Button variant="secondary" size="sm" disabled={reading} onclick={readNow}
				>{t('cs.refresh.now')}</Button
			>
		{/snippet}
	</DetailItem>
</DetailList>
