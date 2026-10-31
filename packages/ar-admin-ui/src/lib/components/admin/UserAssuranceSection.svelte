<script lang="ts">
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import {
		adminUsersAPI,
		type AdminEvidenceType,
		type AssuranceEvidence,
		type UserAssurance
	} from '$lib/api/admin-users';
	import AdminSection from './AdminSection.svelte';

	interface Props {
		userId: string;
		canWrite: boolean;
	}

	let { userId, canWrite }: Props = $props();

	const ADMIN_TYPES: AdminEvidenceType[] = [
		'document_check',
		'in_person_check',
		'remote_supervised_check',
		'admin_attestation'
	];

	let assurance = $state<UserAssurance | null>(null);
	let loadError = $state(false);
	let actionError = $state('');
	let saving = $state(false);

	let level = $state<'IAL1' | 'IAL2' | 'IAL3'>('IAL2');
	let evidenceType = $state<AdminEvidenceType>('document_check');
	let verifiedAt = $state(localNow());
	let expiresAt = $state('');
	let reference = $state('');
	/** The key of the recording being made: kept across a failed attempt, so a retry records it once. */
	let recordingKey: string | null = null;

	/** Now, to the minute, as a datetime-local value. */
	function localNow(): string {
		const minute = Math.floor(Date.now() / 60_000) * 60_000;
		const offset = new Date(minute).getTimezoneOffset() * 60_000;
		return new Date(minute - offset).toISOString().slice(0, 16);
	}

	function formatTime(value: string | null): string {
		if (!value) return $LL.admin_user_detail_assurance_never();
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function typeLabel(type: string): string {
		const labels: Record<string, () => string> = {
			admin_attestation: $LL.admin_user_detail_assurance_type_admin_attestation,
			document_check: $LL.admin_user_detail_assurance_type_document_check,
			in_person_check: $LL.admin_user_detail_assurance_type_in_person_check,
			remote_supervised_check: $LL.admin_user_detail_assurance_type_remote_supervised_check,
			scim: $LL.admin_user_detail_assurance_type_scim,
			import: $LL.admin_user_detail_assurance_type_import,
			tenant_policy: $LL.admin_user_detail_assurance_type_tenant_policy
		};
		return Object.hasOwn(labels, type) ? labels[type]() : type;
	}

	function statusLabel(status: AssuranceEvidence['status']): string {
		switch (status) {
			case 'active':
				return $LL.admin_user_detail_assurance_status_active();
			case 'pending':
				return $LL.admin_user_detail_assurance_status_pending();
			case 'expired':
				return $LL.admin_user_detail_assurance_status_expired();
			default:
				return $LL.admin_user_detail_assurance_status_revoked();
		}
	}

	async function load() {
		loadError = false;
		try {
			assurance = await adminUsersAPI.getAssurance(userId);
		} catch {
			loadError = true;
		}
	}

	$effect(() => {
		void userId;
		assurance = null;
		void load();
	});

	function resetForm() {
		level = 'IAL2';
		evidenceType = 'document_check';
		verifiedAt = localNow();
		expiresAt = '';
		reference = '';
		recordingKey = null;
	}

	async function record() {
		if (!canWrite || saving || !verifiedAt) return;
		saving = true;
		actionError = '';
		recordingKey ??= crypto.randomUUID();
		try {
			await adminUsersAPI.recordAssuranceEvidence(
				userId,
				{
					assurance_level: level,
					evidence_type: evidenceType,
					verified_at: new Date(verifiedAt).toISOString(),
					...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
					...(reference.trim() ? { evidence_storage_ref: reference.trim() } : {})
				},
				recordingKey
			);
			resetForm();
			await load();
		} catch (err) {
			actionError = $LL.admin_user_detail_assurance_record_error({
				message: err instanceof Error ? err.message : String(err)
			});
		} finally {
			saving = false;
		}
	}

	async function revoke(evidence: AssuranceEvidence) {
		if (!canWrite || saving) return;
		if (!window.confirm($LL.admin_user_detail_assurance_revoke_confirm())) return;
		saving = true;
		actionError = '';
		try {
			await adminUsersAPI.revokeAssuranceEvidence(userId, evidence.evidence_id);
			await load();
		} catch (err) {
			actionError = $LL.admin_user_detail_assurance_revoke_error({
				message: err instanceof Error ? err.message : String(err)
			});
			await load();
		} finally {
			saving = false;
		}
	}

	// Any change to what is being recorded is a new recording, with a new key.
	function edited() {
		recordingKey = null;
	}
</script>

<AdminSection
	title={$LL.admin_user_detail_assurance()}
	description={$LL.admin_user_detail_assurance_desc()}
>
	{#if loadError}
		<p class="assurance-error" role="alert">
			{$LL.admin_user_detail_assurance_load_error()}
			<button class="btn btn-secondary btn-sm" onclick={load}
				>{$LL.admin_user_detail_assurance_retry()}</button
			>
		</p>
	{:else if assurance}
		<div class="assurance-current">
			<span class="muted">{$LL.admin_user_detail_assurance_current()}</span>
			<strong class="assurance-level">{assurance.effective_ial.level}</strong>
			{#if assurance.effective_ial.evidence_id}
				<span class="muted"
					>{$LL.admin_user_detail_assurance_rests_on({
						date: formatTime(assurance.effective_ial.verified_at)
					})}</span
				>
			{:else}
				<span class="muted">{$LL.admin_user_detail_assurance_none()}</span>
			{/if}
		</div>

		{#if actionError}
			<p class="assurance-error" role="alert">{actionError}</p>
		{/if}

		{#if canWrite}
			<form
				class="assurance-form"
				onsubmit={(event) => {
					event.preventDefault();
					void record();
				}}
			>
				<label>
					<span>{$LL.admin_user_detail_assurance_level()}</span>
					<select class="form-input" bind:value={level} onchange={edited}>
						<option value="IAL1">IAL1</option>
						<option value="IAL2">IAL2</option>
						<option value="IAL3">IAL3</option>
					</select>
				</label>
				<label>
					<span>{$LL.admin_user_detail_assurance_type()}</span>
					<select class="form-input" bind:value={evidenceType} onchange={edited}>
						{#each ADMIN_TYPES as type (type)}
							<option value={type}>{typeLabel(type)}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>{$LL.admin_user_detail_assurance_verified()}</span>
					<input
						class="form-input"
						type="datetime-local"
						required
						max={localNow()}
						bind:value={verifiedAt}
						oninput={edited}
					/>
				</label>
				<label>
					<span>{$LL.admin_user_detail_assurance_expires()}</span>
					<input class="form-input" type="datetime-local" bind:value={expiresAt} oninput={edited} />
				</label>
				<label class="assurance-reference">
					<span>{$LL.admin_user_detail_assurance_reference()}</span>
					<input class="form-input" maxlength="512" bind:value={reference} oninput={edited} />
				</label>
				<div class="assurance-submit">
					<button class="btn btn-primary" type="submit" disabled={saving || !verifiedAt}>
						{saving
							? $LL.admin_user_detail_assurance_recording()
							: $LL.admin_user_detail_assurance_record()}
					</button>
				</div>
			</form>
		{/if}

		{#if assurance.evidence.length > 0}
			<div class="assurance-table-wrap">
				<table class="assurance-table">
					<thead>
						<tr>
							<th scope="col">{$LL.admin_user_detail_assurance_level()}</th>
							<th scope="col">{$LL.admin_user_detail_assurance_type()}</th>
							<th scope="col">{$LL.admin_user_detail_assurance_recorded_by()}</th>
							<th scope="col">{$LL.admin_user_detail_assurance_verified()}</th>
							<th scope="col">{$LL.admin_user_detail_assurance_expires_column()}</th>
							<th scope="col">{$LL.admin_user_detail_assurance_status()}</th>
							{#if canWrite}<th scope="col"
									><span class="sr-only">{$LL.admin_user_detail_assurance_revoke()}</span></th
								>{/if}
						</tr>
					</thead>
					<tbody>
						{#each assurance.evidence as evidence (evidence.evidence_id)}
							<tr>
								<td>{evidence.assurance_level ?? '-'}</td>
								<td>{typeLabel(evidence.evidence_type)}</td>
								<td class="muted">{evidence.issuer_ref ?? '-'}</td>
								<td>{formatTime(evidence.verified_at)}</td>
								<td>{formatTime(evidence.expires_at)}</td>
								<td>
									<span
										class={evidence.status === 'active'
											? 'badge badge-success'
											: 'badge badge-neutral'}>{statusLabel(evidence.status)}</span
									>
								</td>
								{#if canWrite}
									<td>
										{#if evidence.status !== 'revoked'}
											<button
												class="btn btn-secondary btn-sm"
												disabled={saving}
												onclick={() => revoke(evidence)}
											>
												{$LL.admin_user_detail_assurance_revoke()}
											</button>
										{/if}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if assurance.truncated}
				<p class="muted">{$LL.admin_user_detail_assurance_truncated()}</p>
			{/if}
		{/if}
	{/if}
</AdminSection>

<style>
	.assurance-current {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px 12px;
		margin-bottom: 16px;
	}

	.assurance-level {
		font-size: 1.25rem;
	}

	.assurance-error {
		color: var(--danger, #b42318);
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.assurance-form {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}

	.assurance-form label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.875rem;
	}

	.assurance-reference {
		grid-column: span 2;
	}

	.assurance-submit {
		display: flex;
		align-items: flex-end;
	}

	.assurance-table-wrap {
		overflow-x: auto;
	}

	.assurance-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	.assurance-table th,
	.assurance-table td {
		text-align: start;
		padding: 8px;
		border-bottom: 1px solid var(--border-color, #e5e7eb);
		white-space: nowrap;
	}

	.muted {
		color: var(--text-secondary, #6b7280);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	@media (max-width: 640px) {
		.assurance-reference {
			grid-column: auto;
		}
	}
</style>
