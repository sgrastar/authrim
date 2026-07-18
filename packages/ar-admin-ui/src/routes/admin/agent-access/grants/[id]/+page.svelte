<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AdminAgentGrant,
		type AdminAgentGrantAuditEvent,
		type AgentGrantStatus
	} from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let grant: AdminAgentGrant | null = $state(null);
	let events: AdminAgentGrantAuditEvent[] = $state([]);
	let purpose = $state('');
	let expiresOn = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	const canWrite = $derived(adminAuth.hasPermission('admin:agent_grants:write'));
	const canRevoke = $derived(adminAuth.hasPermission('admin:agent_grants:revoke'));

	function statusLabel(value: AgentGrantStatus): string {
		if (value === 'active') return $LL.admin_agent_access_status_active();
		if (value === 'suspended') return $LL.admin_agent_access_status_suspended();
		return $LL.admin_agent_access_status_revoked();
	}

	function formatDate(value: number | null): string {
		return value ? new Date(value).toLocaleString() : '-';
	}

	function setGrant(value: AdminAgentGrant) {
		grant = value;
		purpose = value.purpose || '';
		expiresOn = value.expires_at ? new Date(value.expires_at).toISOString().slice(0, 10) : '';
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const id = $page.params.id;
			if (!id) throw new Error($LL.admin_agent_access_load_error());
			const [loadedGrant, loadedEvents] = await Promise.all([
				adminAgentAccessAPI.getGrant(id),
				adminAgentAccessAPI.listGrantAudit(id)
			]);
			setGrant(loadedGrant);
			events = loadedEvents;
			notice =
				$page.url.searchParams.get('created') === '1' ? $LL.admin_agent_access_grant_created() : '';
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	}

	async function save() {
		if (!grant) return;
		saving = true;
		error = '';
		try {
			await adminAgentAccessAPI.updateGrant(grant.id, {
				purpose: purpose.trim() || null,
				expires_at: expiresOn ? new Date(`${expiresOn}T23:59:59.999`).getTime() : null
			});
			notice = $LL.admin_agent_access_updated_notice();
			const [updated, updatedEvents] = await Promise.all([
				adminAgentAccessAPI.getGrant(grant.id),
				adminAgentAccessAPI.listGrantAudit(grant.id)
			]);
			setGrant(updated);
			events = updatedEvents;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}

	async function transition(kind: 'suspend' | 'resume' | 'revoke') {
		if (!grant) return;
		const message =
			kind === 'suspend'
				? $LL.admin_agent_access_suspend_confirm()
				: kind === 'resume'
					? $LL.admin_agent_access_resume_confirm()
					: $LL.admin_agent_access_revoke_confirm();
		if (!window.confirm(message)) return;
		saving = true;
		error = '';
		try {
			if (kind === 'suspend') await adminAgentAccessAPI.suspendGrant(grant.id);
			else if (kind === 'resume') await adminAgentAccessAPI.resumeGrant(grant.id);
			else await adminAgentAccessAPI.revokeGrant(grant.id);
			notice = $LL.admin_agent_access_transition_notice();
			const [updated, updatedEvents] = await Promise.all([
				adminAgentAccessAPI.getGrant(grant.id),
				adminAgentAccessAPI.listGrantAudit(grant.id)
			]);
			setGrant(updated);
			events = updatedEvents;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}

	async function preauthorize() {
		if (!grant || !window.confirm($LL.admin_agent_access_preauthorize_confirm())) return;
		saving = true;
		error = '';
		try {
			await adminAgentAccessAPI.preauthorizeGrant(grant.id);
			notice = $LL.admin_agent_access_preauthorized_notice();
			const [updated, updatedEvents] = await Promise.all([
				adminAgentAccessAPI.getGrant(grant.id),
				adminAgentAccessAPI.listGrantAudit(grant.id)
			]);
			setGrant(updated);
			events = updatedEvents;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

<svelte:head><title>{$LL.admin_agent_access_grant_detail_title()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_grant_detail_title()}
		description={$LL.admin_agent_access_grant_detail_description()}
	>
		{#snippet titleAccessory()}
			{#if grant}
				<span class="status" data-status={grant.status}>{statusLabel(grant.status)}</span>
			{/if}
		{/snippet}
	</AdminPageHeader>
	<AgentAccessNav />

	{#if loading}
		<div class="loading-state">{$LL.admin_agent_access_loading()}</div>
	{:else if !grant}
		<div class="alert alert-error">{error || $LL.admin_agent_access_load_error()}</div>
	{:else}
		{#if error}<div class="alert alert-error">{error}</div>{/if}
		{#if notice}<div class="alert alert-success">{notice}</div>{/if}

		<div class="detail-grid">
			<AdminSection>
				<dl>
					<div>
						<dt>{$LL.admin_agent_access_grant_id()}</dt>
						<dd>{grant.id}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_client()}</dt>
						<dd>{grant.client_id}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_delegator()}</dt>
						<dd>{grant.delegator_id}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_machine_principal()}</dt>
						<dd>{grant.machine_principal_id || '—'}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_scope()}</dt>
						<dd>{grant.scopes.join(' ')}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_task_sets_title()}</dt>
						<dd>{grant.task_set_id ? `${grant.task_set_id} · v${grant.task_set_version}` : '—'}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_scope_policies_title()}</dt>
						<dd>
							{grant.scope_policy_id
								? `${grant.scope_policy_id} · v${grant.scope_policy_version}`
								: '—'}
						</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_digest()}</dt>
						<dd class="snapshot-hash">{grant.access_snapshot_hash || '—'}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_generation()}</dt>
						<dd>{grant.generation}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_consent_version()}</dt>
						<dd>{grant.consent_version}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_last_used()}</dt>
						<dd>{formatDate(grant.last_used_at)}</dd>
					</div>
					<div>
						<dt>{$LL.admin_agent_access_created()}</dt>
						<dd>{formatDate(grant.created_at)}</dd>
					</div>
				</dl>
			</AdminSection>

			<AdminSection>
				<fieldset disabled={!canWrite || grant.status !== 'active' || saving}>
					<legend>{$LL.admin_agent_access_permissions()}</legend>
					<p class="eligibility-note">{$LL.admin_agent_access_versioned_access_immutable()}</p>
					<ul class="resolved-permissions">
						{#each grant.permissions as permission (permission)}<li>{permission}</li>{/each}
					</ul>
					<label class="field">
						<span>{$LL.admin_agent_access_purpose()}</span>
						<textarea bind:value={purpose} maxlength="500"></textarea>
					</label>
					<label class="field">
						<span>{$LL.admin_agent_access_expiration()}</span>
						<input type="date" bind:value={expiresOn} />
					</label>
				</fieldset>
				{#if canWrite && grant.status === 'active'}
					<div class="actions">
						<button class="btn btn-primary" onclick={save} disabled={saving}
							>{saving ? $LL.admin_agent_access_saving() : $LL.admin_agent_access_save()}</button
						>
					</div>
				{/if}
			</AdminSection>
		</div>

		<div class="transitions">
			{#if canWrite && grant.status === 'active' && grant.delegation_mode === 'admin_pre_authorized' && !grant.consent_current}<button
					class="btn btn-primary"
					onclick={preauthorize}
					disabled={saving}>{$LL.admin_agent_access_preauthorize()}</button
				>{/if}
			{#if canWrite && grant.status === 'active'}<button
					class="btn btn-secondary"
					onclick={() => transition('suspend')}
					disabled={saving}>{$LL.admin_agent_access_suspend()}</button
				>{/if}
			{#if canWrite && grant.status === 'suspended'}<button
					class="btn btn-secondary"
					onclick={() => transition('resume')}
					disabled={saving}>{$LL.admin_agent_access_resume()}</button
				>{/if}
			{#if canRevoke && grant.status !== 'revoked'}<button
					class="btn btn-danger"
					onclick={() => transition('revoke')}
					disabled={saving}>{$LL.admin_agent_access_revoke()}</button
				>{/if}
		</div>

		<section class="audit">
			<h2>{$LL.admin_agent_access_audit_title()}</h2>
			{#each events as event (event.id)}
				<article>
					<div><strong>{event.action}</strong><span>{event.result} · {event.severity}</span></div>
					<time>{formatDate(event.created_at)}</time>
				</article>
			{:else}<p>{$LL.admin_agent_access_audit_empty()}</p>{/each}
		</section>
	{/if}
</AdminPageShell>

<style>
	.detail-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(340px, 1fr);
		gap: 18px;
	}
	dl {
		display: grid;
		gap: 11px;
		margin: 0;
	}
	dl div {
		display: grid;
		grid-template-columns: minmax(130px, 0.35fr) 1fr;
		gap: 12px;
		padding-bottom: 10px;
		border-bottom: 1px solid var(--color-border);
	}
	dt {
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}
	dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		overflow-wrap: anywhere;
	}
	fieldset {
		display: grid;
		gap: 8px;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 6px;
		font-weight: 700;
	}
	.eligibility-note {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--color-text-muted);
	}
	.field {
		display: grid;
		gap: 6px;
		margin-top: 8px;
		font-size: 0.8rem;
		font-weight: 700;
	}
	textarea,
	input[type='date'] {
		width: 100%;
		padding: 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface);
		color: var(--color-text);
	}
	textarea {
		min-height: 88px;
		resize: vertical;
	}
	.actions,
	.transitions {
		display: flex;
		justify-content: flex-end;
		gap: 9px;
		margin-top: 16px;
	}
	.status {
		display: inline-flex;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
	}
	.status[data-status='active'] {
		color: var(--color-success);
	}
	.status[data-status='suspended'] {
		color: var(--color-warning);
	}
	.status[data-status='revoked'] {
		color: var(--color-error);
	}
	.audit {
		margin-top: 26px;
	}
	.audit h2 {
		margin: 0 0 10px;
		font-size: 1rem;
	}
	.audit article {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		padding: 11px 0;
		border-bottom: 1px solid var(--color-border);
	}
	.audit article div {
		display: grid;
		gap: 3px;
	}
	.audit article span,
	.audit time,
	.audit p {
		color: var(--color-text-muted);
		font-size: 0.74rem;
	}
	.loading-state {
		padding: 32px;
		color: var(--color-text-muted);
		text-align: center;
	}
	@media (max-width: 900px) {
		.detail-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
