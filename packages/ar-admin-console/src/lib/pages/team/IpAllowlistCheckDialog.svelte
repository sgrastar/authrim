<script lang="ts">
	import { untrack } from 'svelte';
	import type { IpAllowlistEntry } from '#lib/api/admin-ip-allowlist.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { accessState, parseIpv4, type AccessState } from './ip-allowlist-model';

	/**
	 * Try an address against the enabled entries without changing anything: would it get into the
	 * admin console? It is judged here, the way the Admin API judges it, so an administrator who
	 * may only read the limit can use it too.
	 */
	interface Props {
		open: boolean;
		entries: readonly IpAllowlistEntry[];
		/** Filled in when it is an IPv4 address, to try the one in use first. */
		currentIp: string | null;
		oncancel: () => void;
	}

	let { open, entries, currentIp, oncancel }: Props = $props();

	let address = $state('');
	let invalid = $state(false);
	let result = $state<{ ip: string; state: AccessState } | null>(null);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			address = currentIp && parseIpv4(currentIp) !== null ? currentIp : '';
			invalid = false;
			result = null;
		});
	});

	function run() {
		const ip = address.trim();
		if (parseIpv4(ip) === null) {
			invalid = true;
			result = null;
			return;
		}
		invalid = false;
		result = { ip, state: accessState(entries, ip) };
	}
</script>

<FormDialog
	{open}
	title={t('ip.check.title')}
	description={t('ip.check.desc')}
	submitLabel={t('ip.check.submit')}
	onsubmit={run}
	{oncancel}
>
	<TextField
		label={t('ip.check.field')}
		bind:value={address}
		error={invalid ? t('ip.check.invalid') : ''}
		placeholder="203.0.113.5"
		autocomplete="off"
		spellcheck={false}
		inputmode="decimal"
	/>
	{#if result}
		<Callout
			tone={result.state === 'blocked' ? 'danger' : 'info'}
			icon={result.state === 'blocked' ? 'warningCircle' : 'checkCircle'}
			live
		>
			{#if result.state === 'open'}
				{t('ip.check.open')}
			{:else if result.state === 'blocked'}
				{t('ip.check.blocked', { ip: result.ip })}
			{:else}
				{t('ip.check.allowed', { ip: result.ip })}
			{/if}
		</Callout>
	{/if}
</FormDialog>
