<script lang="ts">
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type { FederationSourcesClient } from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';

	/**
	 * Deleting the federation. Connections made from its entities ("individual settings") stay:
	 * they are the tenant's own. The dialog says how many, so deleting is never a surprise.
	 */
	interface Props {
		sourceId: string;
		name: string;
		client: FederationSourcesClient;
		/** The federation is gone: leave its page. */
		ondeleted: () => void;
	}
	let { sourceId, name, client, ondeleted }: Props = $props();

	let asking = $state(false);
	let explicitCount = $state<number | null>(null);
	let loading = $state(false);
	let busy = $state(false);
	let failure = $state('');

	async function ask() {
		loading = true;
		failure = '';
		try {
			explicitCount = (await client.entities(sourceId, { state: 'explicit', limit: 1 })).total;
		} catch {
			// Not knowing is not a reason to refuse: the dialog just cannot say how many.
			explicitCount = null;
		} finally {
			loading = false;
			asking = true;
		}
	}

	async function confirm() {
		busy = true;
		failure = '';
		try {
			await client.remove(sourceId);
			asking = false;
			ondeleted();
		} catch (error) {
			asking = false;
			failure =
				error instanceof StepUpCancelledError
					? t('settings.stepUpCancelled')
					: error instanceof Error && error.message
						? error.message
						: t('sf.fed.delete.failed');
		} finally {
			busy = false;
		}
	}
</script>

<Card title={t('sf.fed.delete.title')} tone="warning">
	<p>{t('sf.fed.delete.body')}</p>
	{#if failure}<Callout tone="danger" live>{failure}</Callout>{/if}
	<div>
		<Button variant="danger" {loading} onclick={ask}>{t('sf.fed.delete.button')}</Button>
	</div>
</Card>

<ConfirmDialog
	open={asking}
	title={t('sf.fed.delete.confirmTitle', { name })}
	body={explicitCount
		? t('sf.fed.delete.confirmWithExplicit', { count: explicitCount })
		: t('sf.fed.delete.confirmBody')}
	confirmLabel={t('sf.fed.delete.button')}
	tone="danger"
	{busy}
	onconfirm={confirm}
	oncancel={() => (asking = false)}
/>
