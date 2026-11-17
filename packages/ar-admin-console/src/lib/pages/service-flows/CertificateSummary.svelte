<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import { record } from './advanced-settings';
	let { summary }: { summary?: Record<string, unknown> } = $props();
	const certificates = $derived(
		Array.isArray(summary?.certificates) ? summary.certificates.map(record) : []
	);
	const text = (value: unknown) => (typeof value === 'string' ? value : t('sf.live.unset'));
</script>

{#if certificates.length}
	{#each certificates as certificate, index (index)}
		<DetailList ruled>
			<DetailItem label={t('cs.live.certFingerprint')}
				>{text(certificate.fingerprintSha256)}</DetailItem
			>
			<DetailItem label={t('cs.live.validFrom')}>{text(certificate.validFrom)}</DetailItem>
			<DetailItem label={t('cs.live.validUntil')}>{text(certificate.validTo)}</DetailItem>
		</DetailList>
	{/each}
{:else}<Callout tone="info">{t('cs.live.certDetailsMissing')}</Callout>{/if}
