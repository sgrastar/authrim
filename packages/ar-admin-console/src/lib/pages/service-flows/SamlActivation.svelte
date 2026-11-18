<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type { SamlProviderStatus } from '#lib/api/saml-providers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';

	let {
		provider,
		canEdit,
		dirty = false,
		busy = false,
		showStatus = true,
		pending = $bindable(false),
		update,
		onupdated,
		onreload
	}: {
		provider: SamlProviderStatus;
		canEdit: boolean;
		dirty?: boolean;
		busy?: boolean;
		showStatus?: boolean;
		pending?: boolean;
		update: (input: { enabled: boolean; expectedUpdatedAt: string }) => Promise<SamlProviderStatus>;
		onupdated: (provider: SamlProviderStatus) => void;
		onreload: () => void;
	} = $props();
	let message = $state('');
	let conflict = $state(false);
	let observedVersion = untrack(() => provider.updatedAt);
	let operationVersion = '';
	$effect(() => {
		const version = provider.updatedAt;
		untrack(() => {
			if (version !== observedVersion && version !== operationVersion) {
				message = '';
				conflict = false;
			}
			observedVersion = version;
		});
	});
	const blocked = $derived(
		dirty || provider.configurationMissing || !provider.hasMapping || provider.trustBlocked
	);
	async function change() {
		if (!canEdit || busy || pending || (!provider.enabled && blocked)) return;
		const enabled = !provider.enabled;
		const expectedUpdatedAt = provider.updatedAt;
		pending = true;
		message = '';
		conflict = false;
		try {
			const result = await update({ enabled, expectedUpdatedAt });
			operationVersion = result.updatedAt;
			onupdated(result);
			if (enabled && !result.enabled) message = t('sf.live.activationRejected');
		} catch (error) {
			conflict = error instanceof ApiError && error.status === 409;
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
	{#if showStatus}<Badge tone={provider.enabled ? 'success' : 'neutral'}
			>{t(provider.enabled ? 'sf.live.enabled' : 'sf.live.disabled')}</Badge
		>{/if}
	{#if message}<Callout tone="warning" live
			>{message}{#if conflict}<Button onclick={onreload}>{t('sf.live.reload')}</Button
				>{/if}</Callout
		>{/if}
	{#if !provider.enabled}
		{#if dirty}<Callout tone="info">{t('sf.live.saveFirst')}</Callout>
		{:else if provider.configurationMissing}<Callout tone="warning"
				>{t('sf.draft.metadataRequired')}</Callout
			>
		{:else if !provider.hasMapping}<Callout tone="warning">{t('sf.live.mappingRequired')}</Callout>
		{:else if provider.trustBlocked}<Callout tone="warning">{t('sf.live.trustRequired')}</Callout
			>{/if}
	{/if}
	{#if canEdit}<div>
			<Button
				onclick={change}
				loading={pending}
				disabled={busy || pending || (!provider.enabled && blocked)}
				>{t(provider.enabled ? 'sf.live.disable' : 'sf.live.enable')}</Button
			>
		</div>{/if}
</Card>
