<script lang="ts">
	import type { IpAllowlistEntry } from '#lib/api/admin-ip-allowlist.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import { accessState } from './ip-allowlist-model';

	/**
	 * Whether the limit is on, and whether the address the administrator is using now gets in. With
	 * no enabled entry every address does; the line says so, so that a first entry is not added
	 * blind. The limit is judged from the entries (the API's own flag counts disabled ones too).
	 */
	interface Props {
		entries: readonly IpAllowlistEntry[];
		currentIp: string | null;
	}

	let { entries, currentIp }: Props = $props();

	const state = $derived(accessState(entries, currentIp));
	const open = $derived(state === 'open');
	const ipv6 = $derived(currentIp?.includes(':') ?? false);
</script>

<Callout
	tone={open ? 'warning' : 'info'}
	icon={open ? 'warningCircle' : 'shieldCheck'}
	title={open ? t('ip.status.open.title') : t('ip.status.active.title')}
>
	<p>{open ? t('ip.status.open.body') : t('ip.status.active.body')}</p>
	<p class="you">
		{#if currentIp}
			<span>{t('ip.you.label')}</span>
			<code>{currentIp}</code>
			{#if state === 'blocked'}
				<Badge tone="danger" dot>{t('ip.you.blocked')}</Badge>
			{:else if state === 'unknown'}
				<Badge dot>{t('ip.you.unknown')}</Badge>
			{:else}
				<Badge tone="success" dot>{t('ip.you.allowed')}</Badge>
			{/if}
		{:else}
			<span>{t('ip.you.none')}</span>
		{/if}
	</p>
	{#if ipv6 && state !== 'allowed'}
		<p class="note">{t('ip.you.ipv6')}</p>
	{/if}
</Callout>

<style>
	p {
		margin: 0;
	}
	.you {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 0.5rem);
		margin-block-start: var(--space-2, 0.5rem);
	}
	.note {
		margin-block-start: var(--space-1, 0.25rem);
	}
	code {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
