<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';

	/**
	 * A one-shot run of a sync flow from its overview: a CSV import (a file is chosen at each run,
	 * and is not kept for the next one) or sending the users in scope over SCIM. It waits until
	 * the flow's required settings are set. A demo: nothing is read, sent or changed; the result
	 * is made up.
	 */
	interface Props {
		kind: 'csv' | 'scim-out';
		/** The flow's required settings are all set. */
		ready: boolean;
	}

	let { kind, ready }: Props = $props();

	let file = $state('');
	let running = $state(false);
	let done = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const canRun = $derived(ready && !running && (kind !== 'csv' || file.trim() !== ''));
	const RESULT: Record<typeof kind, { key: string; value: number }[]> = {
		csv: [
			{ key: 'af.run.processed', value: 12 },
			{ key: 'af.run.created', value: 8 },
			{ key: 'af.run.updated', value: 3 },
			{ key: 'af.run.skipped', value: 1 }
		],
		'scim-out': [
			{ key: 'af.run.processed', value: 42 },
			{ key: 'af.run.created', value: 5 },
			{ key: 'af.run.updated', value: 36 },
			{ key: 'af.run.skipped', value: 1 }
		]
	};

	/** A different file is a different run: whatever was under way or shown is dropped. */
	function edit() {
		clearTimeout(timer);
		running = false;
		done = false;
	}

	function run() {
		running = true;
		done = false;
		clearTimeout(timer);
		timer = setTimeout(() => {
			running = false;
			done = true;
		}, 700);
	}

	$effect(() => () => clearTimeout(timer));
</script>

<Card title={t('af.run.title')}>
	<div class="run">
		<p class="lead">{t(kind === 'csv' ? 'af.run.lead.csv' : 'af.run.lead.scim-out')}</p>
		{#if kind === 'csv'}
			<TextField
				label={t('af.run.fileName')}
				placeholder="users.csv"
				bind:value={file}
				oninput={edit}
			/>
		{/if}
		{#if !ready}<Callout tone="info">{t('af.run.needsSetup')}</Callout>{/if}
		<div>
			<Button disabled={!canRun} loading={running} onclick={run}
				>{running ? t('af.run.running') : t('af.run.button')}</Button
			>
		</div>
		{#if done}
			<section class="result" aria-label={t('af.run.result')}>
				<h3>{t('af.run.result')}</h3>
				<DetailList columns={1} ruled>
					{#each RESULT[kind] as row (row.key)}
						<DetailItem label={t(row.key as Parameters<typeof t>[0])}>{row.value}</DetailItem>
					{/each}
				</DetailList>
			</section>
		{/if}
		<p class="demo">{t('af.run.demo')}</p>
	</div>
</Card>

<style>
	.run {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.lead {
		margin: 0;
		color: var(--text-secondary);
	}

	.result {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}

	.result h3 {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.demo {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>
