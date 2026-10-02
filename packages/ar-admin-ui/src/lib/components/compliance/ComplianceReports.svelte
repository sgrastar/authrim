<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminComplianceAPI,
		ComplianceAPIError,
		type AccessReview,
		type ComplianceReport,
		type ComplianceReportType
	} from '$lib/api/admin-compliance';
	import { Modal } from '$lib/components';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { toast } from '$lib/toast';
	import { formatDateTime, reportStatusClass, reportStatusLabel, reportTypeLabel } from './format';

	const PAGE_SIZE = 20;
	const TYPES: ComplianceReportType[] = [
		'access_review',
		'mfa_coverage',
		'compliance_status',
		'audit_log'
	];

	let reports = $state<ComplianceReport[]>([]);
	let nextCursor = $state<string | undefined>(undefined);
	let loading = $state(true);
	let loadError = $state('');
	let downloading = $state<string | null>(null);

	let showCreate = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let type = $state<ComplianceReportType>('compliance_status');
	let name = $state('');
	let reviewId = $state('');
	let from = $state('');
	let to = $state('');
	let reviews = $state<AccessReview[]>([]);
	let reviewsError = $state(false);
	/** Where loading the reviews goes on from (a page that failed). */
	let reviewsCursor: string | undefined;
	let reviewsGeneration = 0;

	async function load(more = false) {
		loading = true;
		loadError = '';
		try {
			const page = await adminComplianceAPI.listReports({
				limit: PAGE_SIZE,
				cursor: more ? nextCursor : undefined
			});
			reports = more ? [...reports, ...page.data] : page.data;
			nextCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
		} catch (error) {
			loadError = error instanceof Error ? error.message : $LL.admin_compliance_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	async function openCreate() {
		type = 'compliance_status';
		name = '';
		reviewId = '';
		from = '';
		to = '';
		createError = '';
		showCreate = true;
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
				const page = await adminComplianceAPI.listAccessReviews({
					limit: 100,
					cursor: reviewsCursor
				});
				if (current !== reviewsGeneration) return;
				reviews = [...reviews, ...page.data];
				reviewsCursor = page.pagination.has_more ? page.pagination.next_cursor : undefined;
			} while (reviewsCursor);
		} catch {
			if (current === reviewsGeneration) reviewsError = true;
		}
	}

	/** A local date-time input (no zone) as the instant it names here. */
	function toIso(local: string): string | undefined {
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
				createError = $LL.admin_compliance_report_review_required();
				return;
			}
			parameters.review_id = reviewId;
		}
		if (type === 'audit_log') {
			const fromIso = toIso(from);
			const toIsoValue = toIso(to);
			if (!fromIso || !toIsoValue || Date.parse(toIsoValue) <= Date.parse(fromIso)) {
				createError = $LL.admin_compliance_report_period_required();
				return;
			}
			parameters.from = fromIso;
			parameters.to = toIsoValue;
		}
		creating = true;
		try {
			const report = await adminComplianceAPI.createReport({
				type,
				...(name.trim() ? { name: name.trim() } : {}),
				...(Object.keys(parameters).length > 0 ? { parameters } : {})
			});
			reports = [report, ...reports];
			showCreate = false;
			toast.success($LL.admin_compliance_report_created());
		} catch (error) {
			if (error instanceof ComplianceAPIError && error.code === 'report_too_large') {
				createError = $LL.admin_compliance_report_too_large();
				void load();
			} else if (error instanceof ComplianceAPIError && error.code === 'audit_log_not_queryable') {
				createError = $LL.admin_compliance_report_not_queryable();
			} else if (
				error instanceof ComplianceAPIError &&
				error.code === 'report_storage_unavailable'
			) {
				createError = $LL.admin_compliance_report_storage_unavailable();
			} else {
				createError = error instanceof Error ? error.message : $LL.admin_compliance_report_failed();
			}
		} finally {
			creating = false;
		}
	}

	async function download(report: ComplianceReport) {
		downloading = report.report_id;
		try {
			const { blob, filename } = await adminComplianceAPI.downloadReport(report.report_id);
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = filename;
			link.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : $LL.admin_compliance_download_failed());
		} finally {
			downloading = null;
		}
	}
</script>

<div class="tab-header-actions">
	<p class="text-secondary">{$LL.admin_compliance_reports_hint()}</p>
	<button class="btn btn-primary" onclick={openCreate}>{$LL.admin_compliance_new_report()}</button>
</div>

{#if loadError}
	<div class="alert alert-error" role="alert">
		{loadError}
		<button class="btn btn-secondary btn-sm" onclick={() => load()}>
			{$LL.admin_compliance_retry()}
		</button>
	</div>
{/if}

{#if loading && reports.length === 0}
	<div class="loading-state">{$LL.admin_compliance_loading()}</div>
{:else if reports.length === 0 && !loadError}
	<div class="empty-state"><p>{$LL.admin_compliance_no_reports()}</p></div>
{:else}
	<AdminDataTable width="wide">
		<thead>
			<tr>
				<th>{$LL.admin_compliance_report_type()}</th>
				<th>{$LL.admin_compliance_requested()}</th>
				<th>{$LL.admin_compliance_retention_records()}</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each reports as report (report.report_id)}
				<tr>
					<td>
						<div class="cell-primary">{report.name}</div>
						<div class="cell-secondary">{reportTypeLabel($LL, report.type)}</div>
						<span class={reportStatusClass(report.status)}>
							{reportStatusLabel($LL, report.status)}
						</span>
						{#if report.status === 'failed' && report.error === 'too_large'}
							<div class="cell-secondary">{$LL.admin_compliance_report_too_large()}</div>
						{/if}
					</td>
					<td class="text-secondary">
						{formatDateTime(report.created_at)}
						{#if report.status === 'completed' && report.expires_at}
							<div class="cell-secondary">
								{$LL.admin_compliance_report_expires({ at: formatDateTime(report.expires_at) })}
							</div>
						{/if}
					</td>
					<td class="text-secondary">
						{report.row_count === null
							? '—'
							: $LL.admin_compliance_report_rows({ count: report.row_count })}
						{#if report.format}
							<div class="cell-secondary">{report.format.toUpperCase()}</div>
						{/if}
					</td>
					<td class="text-right">
						{#if report.downloadable}
							<button
								class="btn btn-secondary btn-sm"
								disabled={downloading === report.report_id}
								onclick={() => download(report)}
							>
								{$LL.admin_compliance_download()}
							</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</AdminDataTable>
	{#if nextCursor}
		<div class="center-actions">
			<button class="btn btn-secondary" disabled={loading} onclick={() => load(true)}>
				{$LL.admin_compliance_load_more()}
			</button>
		</div>
	{/if}
{/if}

<Modal
	open={showCreate}
	onClose={() => (showCreate = false)}
	title={$LL.admin_compliance_new_report()}
	size="md"
>
	<div class="form-section">
		{#if createError}
			<div class="alert alert-error" role="alert">{createError}</div>
		{/if}
		<div class="form-group">
			<label class="form-label" for="report-type">{$LL.admin_compliance_report_type()}</label>
			<select id="report-type" class="form-select" bind:value={type}>
				{#each TYPES as option (option)}
					<option value={option}>{reportTypeLabel($LL, option)}</option>
				{/each}
			</select>
		</div>
		{#if type === 'access_review'}
			<div class="form-group">
				<label class="form-label" for="report-review">{$LL.admin_compliance_report_review()}</label>
				<select id="report-review" class="form-select" bind:value={reviewId}>
					<option value="">—</option>
					{#each reviews as review (review.review_id)}
						<option value={review.review_id}>{review.name}</option>
					{/each}
				</select>
				{#if reviewsError}
					<p class="form-error" role="alert">
						{$LL.admin_compliance_reviews_partial()}
						<button type="button" class="btn btn-link btn-sm" onclick={loadReviews}>
							{$LL.admin_compliance_retry()}
						</button>
					</p>
				{/if}
			</div>
		{/if}
		{#if type === 'audit_log'}
			<div class="form-grid">
				<div class="form-group">
					<label class="form-label" for="report-from">{$LL.admin_compliance_report_from()}</label>
					<input id="report-from" class="form-input" type="datetime-local" bind:value={from} />
				</div>
				<div class="form-group">
					<label class="form-label" for="report-to">{$LL.admin_compliance_report_to()}</label>
					<input id="report-to" class="form-input" type="datetime-local" bind:value={to} />
				</div>
			</div>
			<p class="form-hint">{$LL.admin_compliance_report_period_hint()}</p>
		{/if}
		<div class="form-group">
			<label class="form-label" for="report-name">{$LL.admin_compliance_report_name()}</label>
			<input id="report-name" class="form-input" maxlength="200" bind:value={name} />
		</div>
	</div>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showCreate = false)}>
			{$LL.admin_compliance_cancel()}
		</button>
		<button class="btn btn-primary" disabled={creating} onclick={create}>
			{$LL.admin_compliance_generate()}
		</button>
	{/snippet}
</Modal>
