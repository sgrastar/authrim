<script lang="ts">
	import { untrack } from 'svelte';
	import type { ClientDetail } from '#lib/api/clients.js';
	import { ApiError } from '#lib/api/api-error.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { clientMissingLabel } from './client-missing-label';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';

	let {
		client,
		canEdit,
		dirty = false,
		busy = false,
		pending = $bindable(false),
		update,
		onupdated,
		onreload
	}: {
		client: ClientDetail;
		canEdit: boolean;
		dirty?: boolean;
		busy?: boolean;
		pending?: boolean;
		update: (enabled: boolean, expectedUpdatedAt: number) => Promise<ClientDetail>;
		onupdated: (client: ClientDetail) => void;
		onreload: () => void;
	} = $props();
	let message = $state('');
	let conflict = $state(false);
	let missing = $state<string[]>([]);
	let observedVersion = untrack(() => client.updatedAt);
	$effect(() => {
		const version = client.updatedAt;
		untrack(() => {
			if (version !== observedVersion) {
				message = '';
				conflict = false;
				missing = [];
			}
			observedVersion = version;
		});
	});
	const blockers = $derived(missing.length ? missing : client.enableBlockers);
	const blocked = $derived(dirty || blockers.length > 0 || typeof client.updatedAt !== 'number');
	async function change() {
		if (
			!canEdit ||
			busy ||
			pending ||
			typeof client.updatedAt !== 'number' ||
			(!client.enabled && blocked)
		)
			return;
		pending = true;
		message = '';
		conflict = false;
		missing = [];
		try {
			onupdated(await update(!client.enabled, client.updatedAt));
		} catch (error) {
			conflict = error instanceof ApiError && error.status === 409;
			if (
				error instanceof ApiError &&
				error.code === 'client_configuration_required_to_enable' &&
				Array.isArray(error.body.missing)
			)
				missing = error.body.missing.filter((v): v is string => typeof v === 'string');
			message = t(
				error instanceof StepUpCancelledError
					? 'settings.stepUpCancelled'
					: conflict
						? 'sf.live.conflict'
						: 'sf.live.activationFailed'
			);
		} finally {
			pending = false;
		}
	}
</script>

<Card title={t('sf.live.status')}>
	<Badge tone={client.enabled ? 'success' : 'neutral'}
		>{t(client.enabled ? 'sf.live.enabled' : 'sf.live.disabled')}</Badge
	>
	{#if message}<Callout tone="warning" live
			>{message}{#if conflict}<Button onclick={onreload}>{t('sf.live.reload')}</Button
				>{/if}</Callout
		>{/if}
	{#if !client.enabled}
		<p>{t('sf.rp.disabledNote')}</p>
		{#if dirty}<Callout tone="info">{t('sf.live.saveFirst')}</Callout>{/if}
		{#if blockers.length}<Callout tone="warning"
				>{t('sf.rp.enableRequires')}
				<ul>
					{#each blockers as field (field)}<li>{clientMissingLabel(field)}</li>{/each}
				</ul></Callout
			>{/if}
	{/if}
	{#if canEdit}<div>
			<Button
				onclick={change}
				loading={pending}
				disabled={busy || pending || (!client.enabled && blocked)}
				>{t(client.enabled ? 'sf.live.disable' : 'sf.live.enable')}</Button
			>
		</div>{/if}
</Card>
