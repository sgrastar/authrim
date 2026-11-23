<script lang="ts">
	import { untrack } from 'svelte';
	import type { IpAllowlistEntry } from '#lib/api/admin-ip-allowlist.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import {
		countText,
		ipv4Text,
		parseIpv4,
		parseRange,
		rangeContains,
		type RangeProblem
	} from './ip-allowlist-model';

	/**
	 * Add an address or a range, or change one. Only IPv4 is taken: a single address or a CIDR
	 * range. Under the field it says what the range covers and whether it includes the address
	 * the administrator is on, so the first entry is not typed in blind (the limit then locks
	 * everyone else out, and this administrator too if the address is not in it).
	 */
	interface Props {
		open: boolean;
		/** The entry being changed; null to add one. */
		entry: IpAllowlistEntry | null;
		currentIp: string | null;
		/** Ranges already listed (the entry's own left out), to say so before asking the API. */
		taken: readonly string[];
		busy: boolean;
		/** Why the last save failed. Shown in the dialog, which stays open for another try. */
		error: string;
		onsubmit: (value: { ip_range: string; description: string }) => void;
		oncancel: () => void;
	}

	let { open, entry, currentIp, taken, busy, error, onsubmit, oncancel }: Props = $props();

	let range = $state('');
	let description = $state('');
	let tried = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			range = entry?.ip_range ?? '';
			description = entry?.description ?? '';
			tried = false;
		});
	});

	/** An entry made another way (IPv6): its range is left as it is, only its text changes. */
	const fixed = $derived(entry !== null && entry.ip_version === 6);
	const parsed = $derived(parseRange(range));
	const duplicate = $derived(parsed.ok && taken.includes(parsed.text));
	const mine = $derived(currentIp ? parseIpv4(currentIp) : null);

	const PROBLEM: Record<RangeProblem, MessageKey> = {
		empty: 'ip.err.empty',
		address: 'ip.err.address',
		prefix: 'ip.err.prefix',
		ipv6: 'ip.err.ipv6'
	};

	const fieldError = $derived.by(() => {
		if (fixed) return '';
		if (!parsed.ok) {
			// Say nothing about an empty field until the form is sent.
			return parsed.problem === 'empty' && !tried ? '' : t(PROBLEM[parsed.problem]);
		}
		return duplicate ? t('ip.err.duplicate') : '';
	});

	function submit() {
		tried = true;
		if (fixed) return onsubmit({ ip_range: entry?.ip_range ?? '', description });
		if (!parsed.ok || duplicate) return;
		onsubmit({ ip_range: parsed.text, description });
	}
</script>

<FormDialog
	{open}
	title={entry ? t('ip.edit.title') : t('ip.new.title')}
	submitLabel={entry ? t('ip.edit.submit') : t('ip.new.submit')}
	{busy}
	{error}
	onsubmit={submit}
	{oncancel}
>
	<TextField
		label={t('ip.field.range')}
		bind:value={range}
		hint={fixed ? t('ip.field.rangeIpv6') : t('ip.field.rangeHint')}
		error={fieldError}
		placeholder="203.0.113.0/24"
		disabled={fixed}
		autocomplete="off"
		spellcheck={false}
		inputmode="decimal"
	/>
	{#if !fixed}
		{#if mine !== null && currentIp}
			<div class="use">
				<Button size="sm" variant="secondary" onclick={() => (range = currentIp)}>
					{t('ip.useMine')} ({currentIp})
				</Button>
			</div>
		{/if}
		{#if parsed.ok}
			<Callout>
				<p>
					{#if parsed.range.prefix === 32}
						{t('ip.preview.single')}
					{:else if parsed.range.prefix === 0}
						{t('ip.preview.all')}
					{:else}
						{t('ip.preview.range', {
							first: ipv4Text(parsed.range.first),
							last: ipv4Text(parsed.range.last),
							count: countText(parsed.range.count, i18n.locale)
						})}
					{/if}
					{#if parsed.text !== range.trim()}
						{t('ip.preview.normalized', { range: parsed.text })}
					{/if}
				</p>
				{#if mine !== null}
					<p>
						{rangeContains(parsed.range, mine) ? t('ip.preview.mine') : t('ip.preview.notMine')}
					</p>
				{/if}
			</Callout>
		{/if}
	{/if}
	<TextField
		label={t('ip.field.description')}
		bind:value={description}
		placeholder={t('ip.field.descriptionPlaceholder')}
		maxlength={200}
	/>
</FormDialog>

<style>
	p {
		margin: 0;
	}
	.use {
		margin-block: var(--space-2, 0.5rem);
	}
</style>
