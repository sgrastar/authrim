<script lang="ts">
	import {
		errorCode,
		type AccessReview,
		type ComplianceClient,
		type ComplianceReport,
		type ReportType
	} from '$lib/api/compliance';
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { formatNumber } from '$lib/ui/format';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '$lib/ui/patterns/FormDialog.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import { toast } from '$lib/ui/toast/toast.svelte';
	import { label, reportTone, timeText } from './labels';

	interface Props {
		client: ComplianceClient;
		tenantId: string;
	}

	let { client, tenantId }: Props = $props();

	const TYPES: ReportType[] = ['compliance_status', 'mfa_coverage', 'access_review', 'audit_log'];

	let reports = $state<ComplianceReport[] | null>(null);
	let nextCursor = $state<string | undefined>(undefined);
	let loadError = $state('');
	let loadingMore = $state(false);
	let downloading = $state<string | null>(null);

	let creating = $state(false);
	let busy = $state(false);
	let createError = $state('');
	let type = $state<string>('compliance_status');
	let name = $state('');
	let reviewId = $state('');
	let from = $state('');
	let to = $state('');
	let reviews = $state<AccessReview[]>([]);
	let reviewsError = $state(false);
	/** Where loading the reviews goes on from (a page that failed). */
	let reviewsCursor: string | undefined;
	let reviewsGeneration = 0;

	async function load() {
		loadError = '';
		try {
			const page = await client.reports(tenantId);
			reports = page.data;
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch {
			loadError = t('cmp.loadFailed');
			reports = reports ?? [];
		}
	}

	async function loadMore() {
		if (loadingMore || !nextCursor) return;
		loadingMore = true;
		try {
			const page = await client.reports(tenantId, nextCursor);
			reports = [...(reports ?? []), ...page.data];
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch {
			loadError = t('cmp.loadFailed');
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		void load();
	});

	async function openCreate() {
		type = 'compliance_status';
		name = '';
		reviewId = '';
		from = '';
		to = '';
		createError = '';
		creating = true;
		reviewsGeneration += 1;
		reviews = [];
		reviewsCursor = undefined;
		await loadReviews();
	}

	/**
	 * Every review, older ones included, to choose from. What loaded stays if a page fails, and
	 * trying again goes on from that page.
	 */
	async function loadReviews() {
		// Each opening of the dialog loads its own list: an earlier opening's answers are dropped.
		const current = reviewsGeneration;
		reviewsError = false;
		try {
			do {
				const page = await client.reviews(tenantId, reviewsCursor);
				if (current !== reviewsGeneration) return;
				reviews = [...reviews, ...page.data];
				reviewsCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
			} while (reviewsCursor);
		} catch {
			if (current === reviewsGeneration) reviewsError = true;
		}
	}

	/** A local date-time input (no zone) as the instant it names here. */
	function instant(local: string): string | undefined {
		if (!local) return undefined;
		const date = new Date(local);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}

	async function create() {
		createError = '';
		const parameters: { review_id?: string; from?: string; to?: string } = {};
		if (type === 'access_review') {
			// One of the reviews offered (a choice from an earlier list is not sent).
			if (!reviews.some((review) => review.review_id === reviewId)) {
				createError = t('cmp.report.reviewRequired');
				return;
			}
			parameters.review_id = reviewId;
		}
		if (type === 'audit_log') {
			const start = instant(from);
			const end = instant(to);
			if (!start || !end || Date.parse(end) <= Date.parse(start)) {
				createError = t('cmp.report.periodRequired');
				return;
			}
			parameters.from = start;
			parameters.to = end;
		}
		busy = true;
		try {
			const report = await client.createReport(tenantId, {
				type: type as ReportType,
				...(name.trim() ? { name: name.trim() } : {}),
				...(Object.keys(parameters).length > 0 ? { parameters } : {})
			});
			reports = [report, ...(reports ?? [])];
			creating = false;
			toast.success(t('cmp.report.created'));
		} catch (error) {
			const code = errorCode(error);
			createError =
				code === 'report_too_large'
					? t('cmp.report.tooLarge')
					: code === 'audit_log_not_queryable'
						? t('cmp.report.notQueryable')
						: code === 'report_storage_unavailable'
							? t('cmp.report.storageUnavailable')
							: t('cmp.report.failed');
			// A report too large is recorded as failed: show it.
			if (code === 'report_too_large') void load();
		} finally {
			busy = false;
		}
	}

	async function download(report: ComplianceReport) {
		if (downloading) return;
		downloading = report.report_id;
		try {
			const { blob, filename } = await client.download(tenantId, report.report_id);
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = filename;
			link.click();
			URL.revokeObjectURL(url);
		} catch {
			toast.error(t('cmp.downloadFailed'));
		} finally {
			downloading = null;
		}
	}

	const typeOptions = $derived(
		TYPES.map((value) => ({ value, label: t(`cmp.report.type.${value}`) }))
	);
	const reviewOptions = $derived(
		reviews.map((review) => ({ value: review.review_id, label: review.name }))
	);
</script>

<Callout tone="info">{t('cmp.report.desc')}</Callout>

{#if loadError}
	<Callout tone="danger" live>
		{loadError}
		<Button variant="secondary" size="sm" onclick={load}>{t('cmp.retry')}</Button>
	</Callout>
{/if}

{#if reports === null}
	<LoadingState label={t('cmp.loading')} />
{:else}
	<Card flush>
		{#snippet actions()}
			<Button variant="primary" icon="plus" onclick={openCreate}>{t('cmp.report.new')}</Button>
		{/snippet}
		<DataTable
			caption={t('cmp.tab.reports')}
			columns={[
				{ key: 'report', label: t('cmp.report.type'), width: '36%' },
				{ key: 'generated', label: t('cmp.report.generated') },
				{ key: 'rows', label: t('cmp.ret.col.records'), width: '16%' },
				{ key: 'download', label: '', width: '10rem', align: 'end' }
			]}
			rows={reports}
			rowKey={(report) => report.report_id}
		>
			{#snippet cell(report, column)}
				{#if column.key === 'report'}
					<div class="stack">
						<strong>{report.name}</strong>
						<span class="muted">{label('cmp.report.type.', report.type)}</span>
						<Badge tone={reportTone(report.status)}
							>{label('cmp.report.status.', report.status)}</Badge
						>
						{#if report.status === 'failed' && report.error === 'too_large'}
							<span class="muted">{t('cmp.report.tooLarge')}</span>
						{/if}
					</div>
				{:else if column.key === 'generated'}
					<div class="stack">
						<span>{timeText(report.created_at)}</span>
						{#if report.status === 'completed' && report.expires_at}
							<span class="muted">{t('cmp.report.until', { at: timeText(report.expires_at) })}</span
							>
						{/if}
					</div>
				{:else if column.key === 'rows'}
					{report.row_count === null
						? '—'
						: t('cmp.report.rows', { count: formatNumber(report.row_count, i18n.locale) })}
				{:else if report.downloadable}
					<Button
						variant="secondary"
						size="sm"
						loading={downloading === report.report_id}
						onclick={() => download(report)}
					>
						{t('cmp.download')}
					</Button>
				{/if}
			{/snippet}
			{#snippet empty()}
				<EmptyState icon="file" title={t('cmp.report.none')} />
			{/snippet}
		</DataTable>
	</Card>
	{#if nextCursor}
		<div class="more">
			<Button variant="secondary" loading={loadingMore} onclick={loadMore}
				>{t('cmp.loadMore')}</Button
			>
		</div>
	{/if}
{/if}

<FormDialog
	open={creating}
	title={t('cmp.report.new')}
	submitLabel={t('cmp.report.generate')}
	{busy}
	error={createError}
	onsubmit={create}
	oncancel={() => (creating = false)}
>
	<Select label={t('cmp.report.type')} options={typeOptions} bind:value={type} />
	{#if type === 'access_review'}
		<Select
			label={t('cmp.report.review')}
			options={reviewOptions}
			placeholder
			error={reviewsError ? t('cmp.reviewsPartial') : undefined}
			bind:value={reviewId}
		/>
		{#if reviewsError}
			<div>
				<Button variant="secondary" size="sm" onclick={loadReviews}>{t('cmp.retry')}</Button>
			</div>
		{/if}
	{/if}
	{#if type === 'audit_log'}
		<div class="period">
			<TextField label={t('cmp.report.from')} type="datetime-local" bind:value={from} />
			<TextField label={t('cmp.report.to')} type="datetime-local" bind:value={to} />
		</div>
		<p class="muted">{t('cmp.report.periodHint')}</p>
	{/if}
	<TextField label={t('cmp.report.name')} maxlength={200} bind:value={name} />
</FormDialog>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.muted {
		color: var(--text-secondary);
	}

	.period {
		display: grid;
		grid-template-columns: 1fr 1fr;
		align-items: end;
		gap: var(--space-related);
	}

	.more {
		display: flex;
		justify-content: center;
		margin-top: var(--space-related);
	}
</style>
