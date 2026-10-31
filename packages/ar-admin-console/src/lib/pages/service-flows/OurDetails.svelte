<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import CopyButton from '$lib/ui/primitives/CopyButton.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';

	/**
	 * What Authrim gives the other side to register on its own side: addresses, an entity ID,
	 * a certificate fingerprint. Each value has a copy button at the end of its row. Nothing here
	 * is switched on or recorded: the person registers the values on the other side, and the
	 * connection's test shows whether it worked.
	 */
	interface Props {
		items: readonly { label: string; value: string }[];
		/** What the other side is: an app, a service or a provider. */
		partner: 'app' | 'service' | 'provider';
		/** Offer the metadata file (SAML). */
		download?: boolean;
		/** A line under the lead, for what is fixed or special about these values. */
		note?: string;
	}

	let { items, partner, download = false, note }: Props = $props();

	const partnerName = $derived(t(`sf.partner.${partner}`));
</script>

<p class="lead">{t('sf.ours.lead', { partner: partnerName })}</p>
{#if note}<p class="note">{note}</p>{/if}
<DetailList columns={1} ruled>
	{#each items as item (item.label)}
		<DetailItem label={item.label}>
			<code>{item.value}</code>
			{#snippet end()}
				<CopyButton
					variant="icon"
					text={item.value}
					label={t('sf.ours.copy', { label: item.label })}
				/>
			{/snippet}
		</DetailItem>
	{/each}
</DetailList>
{#if download}
	<div>
		<Button variant="secondary" icon="arrowOut">{t('sf.ours.download')}</Button>
	</div>
{/if}

<style>
	.lead {
		margin: 0;
		color: var(--text-secondary);
	}

	.note {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>
