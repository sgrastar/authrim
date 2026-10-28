<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';

	/**
	 * Try the connection before it is used: a test user signs in and the result is listed stage
	 * by stage. Dummy: running the test only waits a moment and passes.
	 */
	interface Props {
		lead: string;
		/** What passed, one line each. */
		checks: readonly string[];
		/** One thing worth a look, shown as a note. */
		note?: string;
		tested: boolean;
	}

	let { lead, checks, note, tested = $bindable() }: Props = $props();

	let testing = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function run() {
		testing = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			tested = true;
			testing = false;
		}, 700);
	}

	// Leaving the step ends a test that is still running; its result is not recorded afterwards.
	$effect(() => () => clearTimeout(timer));
</script>

<p class="lead">{lead}</p>
<div>
	<Button variant="secondary" icon="rocket" loading={testing} onclick={run}
		>{tested ? t('sf.test.again') : t('sf.test.run')}</Button
	>
</div>
{#if tested}
	<ul class="checks" aria-label={t('sf.test.results')}>
		{#each checks as check (check)}
			<li><Badge tone="success" dot>{t('sf.value.passed')}</Badge> {check}</li>
		{/each}
		{#if note}<li><Badge tone="warning" dot>{t('sf.test.note')}</Badge> {note}</li>{/if}
	</ul>
{:else}
	<Callout tone="info">{t('sf.test.toGoOn')}</Callout>
{/if}

<style>
	.lead {
		margin: 0;
		color: var(--text-secondary);
	}

	.checks {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.checks li {
		display: flex;
		gap: var(--space-related);
		align-items: baseline;
	}
</style>
