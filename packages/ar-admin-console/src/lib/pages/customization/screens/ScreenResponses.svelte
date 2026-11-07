<script lang="ts">
	import { untrack } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type { ScreenResponseRecord, ScreensClient } from '#lib/api/screens.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';

	/**
	 * A screen's response records, newest first, a page at a time: what signed-in users answered
	 * to its parts whose answers go to the record. Personal data: the page shows it only to those
	 * who may view users, and the API checks the same.
	 */
	interface Props {
		client: ScreensClient;
		screenId: string;
		/** What each answer key is called on the screen (the part's label), when it still is. */
		labelOf?: (key: string) => string | undefined;
		/** The label of a choice the screen still offers, by answer key and value. */
		choiceOf?: (key: string, value: string) => string | undefined;
	}

	let { client, screenId, labelOf = () => undefined, choiceOf = () => undefined }: Props = $props();

	const PAGE = 25;
	let responses = $state<ScreenResponseRecord[]>([]);
	let cursor = $state<string | null>(null);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'failed'>('loading');
	let more = $state(false);

	async function read(next: string | null) {
		const page = await client.responses(screenId, { limit: PAGE, cursor: next });
		responses = next ? [...responses, ...page.responses] : page.responses;
		cursor = page.next_cursor;
	}

	async function load() {
		phase = 'loading';
		try {
			await read(null);
			phase = 'ready';
		} catch (error) {
			phase = error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed';
		}
	}

	async function loadMore() {
		more = true;
		try {
			await read(cursor);
		} catch {
			phase = 'failed';
		} finally {
			more = false;
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const answerText = (key: string, value: string | boolean) =>
		typeof value === 'boolean'
			? t(value ? 'sc.responses.yes' : 'sc.responses.no')
			: (choiceOf(key, value) ?? value);

	const columns = $derived([
		{ key: 'when', label: t('sc.responses.col.when'), width: '20%' },
		{ key: 'user', label: t('sc.responses.col.user'), width: '24%' },
		{ key: 'answers', label: t('sc.responses.col.answers') }
	]);
</script>

<p class="desc">{t('sc.responses.desc')}</p>
{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'forbidden'}
	<EmptyState icon="lock" title={t('sc.responses.noAccess')} />
{:else if phase === 'failed'}
	<EmptyState icon="warningCircle" title={t('sc.responses.loadFailed')}>
		{#snippet action()}
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		{/snippet}
	</EmptyState>
{:else}
	<DataTable
		caption={t('sc.editor.tab.responses')}
		{columns}
		rows={responses}
		rowKey={(row) => row.id}
	>
		{#snippet cell(row, column)}
			{#if column.key === 'when'}
				<DateTime value={row.updated_at} stacked />
			{:else if column.key === 'user'}
				<code>{row.user_id}</code>
			{:else}
				<dl class="answers">
					{#each Object.entries(row.answers) as [key, value] (key)}
						<dt>{labelOf(key) ?? key}</dt>
						<dd>{answerText(key, value)}</dd>
					{/each}
				</dl>
			{/if}
		{/snippet}
		{#snippet empty()}
			<EmptyState icon="list" title={t('sc.responses.empty')} />
		{/snippet}
	</DataTable>
	{#if cursor}
		<div class="more">
			<Button size="sm" loading={more} onclick={loadMore}>{t('sc.responses.more')}</Button>
		</div>
	{/if}
{/if}

<style>
	.desc {
		margin: 0 0 12px;
		color: var(--text-secondary);
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
		overflow-wrap: anywhere;
	}

	.answers {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 2px 12px;
		margin: 0;
	}

	.answers dt {
		color: var(--text-secondary);
	}

	.answers dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.more {
		display: flex;
		justify-content: center;
		margin-top: 12px;
	}
</style>
