<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminComplianceAPI,
		ComplianceAPIError,
		type DataRetentionStatus,
		type RetentionCategory
	} from '$lib/api/admin-compliance';
	import { Modal } from '$lib/components';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { toast } from '$lib/toast';
	import {
		attentionReasonLabel,
		categoryLabel,
		formatDateTime,
		formatRetention,
		formatSeconds
	} from './format';

	let status = $state<DataRetentionStatus | null>(null);
	let loading = $state(true);
	let error = $state('');

	let showLookup = $state(false);
	let lookupDays = $state(180);
	let lookupError = $state('');
	let saving = $state(false);
	/** Set once the server asked to confirm a shortening: the retention it read then. */
	let shorteningFrom = $state<number | null>(null);
	let confirmShortening = $state(false);

	async function load() {
		loading = true;
		error = '';
		try {
			status = await adminComplianceAPI.getDataRetentionStatus();
		} catch (e) {
			error = e instanceof Error ? e.message : $LL.admin_compliance_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	function deletionText(category: RetentionCategory): string {
		const deletion = category.deletion;
		switch (deletion.kind) {
			case 'scheduled_task':
				return deletion.enabled
					? $LL.admin_compliance_deletion_task()
					: $LL.admin_compliance_deletion_task_disabled({
							reason: deletion.disabled_reason ?? '—'
						});
			case 'expiry':
				return $LL.admin_compliance_deletion_expiry();
			case 'not_stored':
				return $LL.admin_compliance_deletion_not_stored();
			default:
				return $LL.admin_compliance_deletion_not_deleted();
		}
	}

	function lastRunText(category: RetentionCategory): string | null {
		const deletion = category.deletion;
		if (deletion.kind !== 'scheduled_task') return null;
		return deletion.tenant_last_run
			? $LL.admin_compliance_deletion_last_run({
					at: formatDateTime(deletion.tenant_last_run.at),
					outcome: deletion.tenant_last_run.outcome
				})
			: $LL.admin_compliance_deletion_never_run();
	}

	function editText(category: RetentionCategory): string {
		switch (category.edit.kind) {
			case 'settings':
				return $LL.admin_compliance_edit_where_settings({ category: category.edit.category ?? '' });
			case 'session_settings':
				return $LL.admin_compliance_edit_where_session();
			case 'audit_profile':
			case 'audit_routing_rules':
				return $LL.admin_compliance_edit_where_audit();
			case 'audit_pii_config':
				return $LL.admin_compliance_edit_where_pii();
			case 'lookup_directory':
				return $LL.admin_compliance_edit_where_lookup();
			default:
				return $LL.admin_compliance_edit_where_none();
		}
	}

	function variesText(category: RetentionCategory): string | null {
		switch (category.varies) {
			case 'by_route':
				return $LL.admin_compliance_varies_by_route();
			case 'by_app':
				return $LL.admin_compliance_varies_by_app();
			case 'by_sign_in_method':
				return $LL.admin_compliance_varies_by_sign_in_method();
			case 'by_request':
				return $LL.admin_compliance_varies_by_request();
			default:
				return null;
		}
	}

	function openLookup(category: RetentionCategory) {
		lookupDays = category.retention.value;
		lookupError = '';
		shorteningFrom = null;
		confirmShortening = false;
		showLookup = true;
	}

	async function saveLookup() {
		saving = true;
		lookupError = '';
		const requested = lookupDays;
		try {
			await adminComplianceAPI.updateLookupRetention({
				retention_days: lookupDays,
				...(shorteningFrom !== null && confirmShortening
					? { confirm_shortening: true, expected_current_retention_days: shorteningFrom }
					: {})
			});
			toast.success($LL.admin_compliance_lookup_saved());
			showLookup = false;
			await load();
		} catch (e) {
			// An answer for a value no longer entered changes nothing.
			if (lookupDays !== requested) return;
			if (
				e instanceof ComplianceAPIError &&
				e.code === 'retention_shortening_confirmation_required' &&
				typeof e.body?.current_retention_days === 'number'
			) {
				// Confirmed against the retention read now: a confirmation given for another one
				// (changed by someone else meanwhile) is asked again.
				shorteningFrom = e.body.current_retention_days;
				confirmShortening = false;
				lookupError = $LL.admin_compliance_lookup_shorten_confirm({
					from: shorteningFrom,
					to: lookupDays
				});
			} else {
				lookupError = e instanceof Error ? e.message : $LL.admin_compliance_lookup_failed();
			}
		} finally {
			saving = false;
		}
	}
</script>

<p class="text-secondary">{$LL.admin_compliance_retention_hint()}</p>

{#if error}
	<div class="alert alert-error" role="alert">
		{error}
		<button class="btn btn-secondary btn-sm" onclick={load}>{$LL.admin_compliance_retry()}</button>
	</div>
{/if}

{#if loading && !status}
	<div class="loading-state">{$LL.admin_compliance_loading()}</div>
{:else if status}
	{#if status.summary.attention.length > 0}
		<AdminSection title={$LL.admin_compliance_retention_attention()}>
			<ul class="attention-list">
				{#each status.summary.attention as item (`${item.category}:${item.reason}`)}
					<li>
						<span class="cell-primary">{categoryLabel($LL, item.category)}</span>:
						{attentionReasonLabel($LL, item.reason)}
					</li>
				{/each}
			</ul>
		</AdminSection>
	{/if}

	<AdminDataTable width="xwide">
		<thead>
			<tr>
				<th>{$LL.admin_compliance_retention_category()}</th>
				<th>{$LL.admin_compliance_retention_kept()}</th>
				<th>{$LL.admin_compliance_retention_deleted_by()}</th>
				<th class="text-right">{$LL.admin_compliance_retention_records()}</th>
				<th>{$LL.admin_compliance_retention_set_in()}</th>
			</tr>
		</thead>
		<tbody>
			{#each status.categories as category (category.id)}
				<tr>
					<td><div class="cell-primary">{categoryLabel($LL, category.id)}</div></td>
					<td>
						<div>{formatRetention($LL, category.retention)}</div>
						{#if category.cap}
							<div class="cell-secondary">
								{$LL.admin_compliance_capped({ value: formatSeconds($LL, category.cap.seconds) })}
							</div>
						{/if}
						{#if variesText(category)}
							<div class="cell-secondary">{variesText(category)}</div>
						{/if}
						{#if category.extension && category.extension.absolute_limit_seconds === null}
							<div class="cell-secondary">{$LL.admin_compliance_no_absolute_limit()}</div>
						{/if}
					</td>
					<td>
						<div>{deletionText(category)}</div>
						{#if lastRunText(category)}
							<div class="cell-secondary">{lastRunText(category)}</div>
						{/if}
						{#if category.archive}
							<div class="cell-secondary">{$LL.admin_compliance_archive_kept()}</div>
						{/if}
					</td>
					<td class="text-right">
						{category.counts
							? $LL.admin_compliance_records_expired({
									total: category.counts.total,
									expired: category.counts.expired
								})
							: '—'}
					</td>
					<td>
						{editText(category)}
						{#if category.edit.kind === 'lookup_directory'}
							<button class="btn btn-secondary btn-sm" onclick={() => openLookup(category)}>
								{$LL.admin_compliance_lookup_edit()}
							</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</AdminDataTable>
{/if}

<Modal
	open={showLookup}
	onClose={() => (showLookup = false)}
	title={$LL.admin_compliance_lookup_title()}
	size="sm"
>
	<div class="form-section">
		{#if lookupError}
			<div class="alert alert-warning" role="alert">{lookupError}</div>
		{/if}
		<div class="form-group">
			<label class="form-label" for="lookup-days">{$LL.admin_compliance_lookup_days()}</label>
			<input
				id="lookup-days"
				class="form-input"
				type="number"
				min="30"
				max="3650"
				disabled={saving}
				bind:value={lookupDays}
				oninput={() => {
					// A new value is confirmed anew, against what the API says then.
					shorteningFrom = null;
					confirmShortening = false;
					lookupError = '';
				}}
			/>
		</div>
		{#if shorteningFrom !== null}
			<label class="checkbox-label">
				<input type="checkbox" bind:checked={confirmShortening} />
				{$LL.admin_compliance_lookup_shorten_check()}
			</label>
		{/if}
	</div>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showLookup = false)}>
			{$LL.admin_compliance_cancel()}
		</button>
		<button
			class="btn btn-primary"
			disabled={saving || (shorteningFrom !== null && !confirmShortening)}
			onclick={saveLookup}
		>
			{$LL.admin_compliance_save()}
		</button>
	{/snippet}
</Modal>

<style>
	.attention-list {
		margin: 0;
		padding-left: 20px;
	}

	.attention-list li + li {
		margin-top: 4px;
	}
</style>
