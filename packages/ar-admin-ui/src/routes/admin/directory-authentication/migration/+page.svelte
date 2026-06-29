<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminDirectoryAuthAPI,
		type DirectoryAuthMigrationCampaign,
		type DirectoryAuthMigrationUserState,
		type DirectoryAuthMigrationUserStateRecord,
		type DirectoryAuthTenantPolicy
	} from '$lib/api/admin-directory-auth';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import DirectoryAuthenticationTabs from '../DirectoryAuthenticationTabs.svelte';

	let loading = $state(true);
	let saving = $state(false);
	let resettingStateId = $state('');
	let error = $state('');
	let successMessage = $state('');
	let tenantId = $state('');
	let tenantPolicy = $state<DirectoryAuthTenantPolicy | null>(null);
	let campaigns = $state<DirectoryAuthMigrationCampaign[]>([]);
	let userStates = $state<DirectoryAuthMigrationUserStateRecord[]>([]);
	let newCampaignName = $state('Passkey migration campaign');
	let newCampaignMode = $state<DirectoryAuthMigrationCampaign['mode']>(
		'grace_then_require_passkey'
	);
	let newEmailFallbackMode =
		$state<DirectoryAuthMigrationCampaign['email_code_fallback_mode']>('tenant_default');
	let tenantFallbackMode =
		$state<DirectoryAuthTenantPolicy['email_code_fallback_mode']>('migration_recovery');
	let campaignDrafts = $state<
		Record<
			string,
			{
				status: DirectoryAuthMigrationCampaign['status'];
				mode: DirectoryAuthMigrationCampaign['mode'];
				passkey_prompt_mode: DirectoryAuthMigrationCampaign['passkey_prompt_mode'];
				email_code_fallback_mode: DirectoryAuthMigrationCampaign['email_code_fallback_mode'];
				grace_period_days: number;
				transaction_ttl_seconds: number;
				target_policy_text: string;
			}
		>
	>({});
	let stateFilterState = $state<DirectoryAuthMigrationUserState | ''>('');
	let stateFilterCampaignId = $state('');
	let stateFilterUserId = $state('');
	let resetReasons = $state<Record<string, string>>({});

	const currentTenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());

	function formatTime(value: number | null | undefined): string {
		if (!value) return '-';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
	}

	function migrationModeLabel(value: DirectoryAuthMigrationCampaign['mode']): string {
		if (value === 'directory_login_allowed')
			return $LL.admin_directory_authentication_mode_directory_login_allowed();
		if (value === 'prompt_passkey') return $LL.admin_directory_authentication_mode_prompt_passkey();
		if (value === 'grace_then_require_passkey')
			return $LL.admin_directory_authentication_mode_grace_then_require_passkey();
		if (value === 'require_passkey_after_directory')
			return $LL.admin_directory_authentication_mode_require_passkey_after_directory();
		return $LL.admin_directory_authentication_option_disabled();
	}

	function campaignStatusLabel(value: DirectoryAuthMigrationCampaign['status']): string {
		if (value === 'draft') return $LL.admin_directory_authentication_option_draft();
		if (value === 'active') return $LL.admin_directory_authentication_option_active();
		if (value === 'paused') return $LL.admin_directory_authentication_option_paused();
		if (value === 'archived') return $LL.admin_directory_authentication_option_archived();
		return $LL.admin_directory_authentication_option_disabled();
	}

	function promptModeLabel(value: DirectoryAuthMigrationCampaign['passkey_prompt_mode']): string {
		if (value === 'campaign_only') return $LL.admin_directory_authentication_option_campaign_only();
		if (value === 'optional') return $LL.admin_directory_authentication_option_optional();
		return $LL.admin_directory_authentication_option_none();
	}

	function emailFallbackModeLabel(
		value:
			| DirectoryAuthTenantPolicy['email_code_fallback_mode']
			| DirectoryAuthMigrationCampaign['email_code_fallback_mode']
	): string {
		if (value === 'tenant_default')
			return $LL.admin_directory_authentication_option_tenant_default();
		if (value === 'migration_recovery')
			return $LL.admin_directory_authentication_option_migration_recovery();
		if (value === 'admin_invitation_only')
			return $LL.admin_directory_authentication_option_admin_invitation_only();
		if (value === 'login_method') return $LL.admin_directory_authentication_option_login_method();
		if (value === 'directory_unavailable_recovery')
			return $LL.admin_directory_authentication_option_directory_unavailable_recovery();
		return $LL.admin_directory_authentication_option_disabled();
	}

	function migrationUserStateLabel(value: DirectoryAuthMigrationUserState): string {
		if (value === 'eligible') return $LL.admin_directory_authentication_state_eligible();
		if (value === 'prompted') return $LL.admin_directory_authentication_state_prompted();
		if (value === 'deferred') return $LL.admin_directory_authentication_state_deferred();
		if (value === 'passkey_required')
			return $LL.admin_directory_authentication_state_passkey_required();
		if (value === 'enrolled') return $LL.admin_directory_authentication_state_enrolled();
		if (value === 'blocked') return $LL.admin_directory_authentication_state_blocked();
		if (value === 'recovered') return $LL.admin_directory_authentication_state_recovered();
		return $LL.admin_directory_authentication_state_not_applicable();
	}

	function campaignStateCounts(campaignId: string) {
		const counts: Record<string, number> = {};
		for (const state of userStates) {
			if (state.campaign_id !== campaignId) continue;
			counts[state.state] = (counts[state.state] ?? 0) + 1;
		}
		return Object.entries(counts)
			.map(
				([state, count]) =>
					`${migrationUserStateLabel(state as DirectoryAuthMigrationUserState)}: ${count}`
			)
			.join(', ');
	}

	function campaignCohortCounts(campaignId: string) {
		const counts: Record<string, number> = {};
		for (const state of userStates) {
			if (state.campaign_id !== campaignId || !state.cohort_key) continue;
			counts[state.cohort_key] = (counts[state.cohort_key] ?? 0) + 1;
		}
		return Object.entries(counts)
			.map(([cohort, count]) => `${cohort}: ${count}`)
			.join(', ');
	}

	function campaignReasonCounts(campaignId: string) {
		const counts: Record<string, number> = {};
		for (const state of userStates) {
			if (state.campaign_id !== campaignId) continue;
			const reason = state.blocked_reason || state.recovery_reason;
			if (!reason) continue;
			counts[reason] = (counts[reason] ?? 0) + 1;
		}
		return Object.entries(counts)
			.map(([reason, count]) => `${reason}: ${count}`)
			.join(', ');
	}

	function formatJson(value: unknown): string {
		return JSON.stringify(value ?? {}, null, 2);
	}

	function createCampaignDrafts(items: DirectoryAuthMigrationCampaign[]) {
		const next: typeof campaignDrafts = {};
		for (const campaign of items) {
			next[campaign.id] = {
				status: campaign.status,
				mode: campaign.mode,
				passkey_prompt_mode: campaign.passkey_prompt_mode,
				email_code_fallback_mode: campaign.email_code_fallback_mode,
				grace_period_days: campaign.grace_period_days,
				transaction_ttl_seconds: campaign.transaction_ttl_seconds,
				target_policy_text: formatJson(campaign.target_policy)
			};
		}
		campaignDrafts = next;
	}

	function parseTargetPolicy(text: string): unknown {
		const trimmed = text.trim();
		if (!trimmed) return {};
		return JSON.parse(trimmed);
	}

	async function loadMigration(selectedTenantId: string, preserveMessage = false) {
		loading = true;
		error = '';
		if (!preserveMessage) successMessage = '';
		tenantId = selectedTenantId;
		try {
			const [policyResponse, campaignResponse, stateResponse] = await Promise.all([
				adminDirectoryAuthAPI.getTenantPolicy(selectedTenantId),
				adminDirectoryAuthAPI.listCampaigns(selectedTenantId),
				adminDirectoryAuthAPI.listUserStates(selectedTenantId, {
					state: stateFilterState || undefined,
					campaign_id: stateFilterCampaignId.trim() || undefined,
					user_id: stateFilterUserId.trim() || undefined
				})
			]);
			tenantPolicy = policyResponse.policy;
			tenantFallbackMode = policyResponse.policy.email_code_fallback_mode;
			campaigns = campaignResponse.items;
			createCampaignDrafts(campaignResponse.items);
			userStates = stateResponse.items;
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_migration_load_failed();
			tenantPolicy = null;
			campaigns = [];
			campaignDrafts = {};
			userStates = [];
		} finally {
			loading = false;
		}
	}

	async function saveTenantPolicy() {
		if (!tenantId || !canEdit) return;
		saving = true;
		error = '';
		successMessage = '';
		try {
			const response = await adminDirectoryAuthAPI.updateTenantPolicy(tenantId, {
				email_code_fallback_mode: tenantFallbackMode
			});
			tenantPolicy = response.policy;
			successMessage = $LL.admin_directory_authentication_migration_policy_saved();
			await loadMigration(tenantId, true);
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_migration_policy_save_failed();
		} finally {
			saving = false;
		}
	}

	async function createCampaign() {
		if (!tenantId || !canEdit || !newCampaignName.trim()) return;
		saving = true;
		error = '';
		successMessage = '';
		try {
			await adminDirectoryAuthAPI.createCampaign(tenantId, {
				name: newCampaignName.trim(),
				status: 'disabled',
				mode: newCampaignMode,
				passkey_prompt_mode: 'campaign_only',
				email_code_fallback_mode: newEmailFallbackMode,
				grace_period_days: 30,
				transaction_ttl_seconds: 600,
				target_policy: {
					assignments: [],
					note: 'Campaign remains inert until explicitly enabled and assigned.'
				}
			});
			successMessage = $LL.admin_directory_authentication_migration_campaign_created();
			await loadMigration(tenantId);
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_migration_campaign_create_failed();
		} finally {
			saving = false;
		}
	}

	async function saveCampaign(campaign: DirectoryAuthMigrationCampaign) {
		if (!tenantId || !canEdit) return;
		const draft = campaignDrafts[campaign.id];
		if (!draft) return;
		saving = true;
		error = '';
		successMessage = '';
		try {
			await adminDirectoryAuthAPI.updateCampaign(tenantId, campaign.id, {
				status: draft.status,
				mode: draft.mode,
				passkey_prompt_mode: draft.passkey_prompt_mode,
				email_code_fallback_mode: draft.email_code_fallback_mode,
				grace_period_days: Number(draft.grace_period_days),
				transaction_ttl_seconds: Number(draft.transaction_ttl_seconds),
				target_policy: parseTargetPolicy(draft.target_policy_text)
			});
			successMessage = $LL.admin_directory_authentication_migration_campaign_updated();
			await loadMigration(tenantId, true);
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_migration_campaign_update_failed();
		} finally {
			saving = false;
		}
	}

	async function searchUserStates() {
		if (!tenantId) return;
		loading = true;
		error = '';
		try {
			const response = await adminDirectoryAuthAPI.listUserStates(tenantId, {
				state: stateFilterState || undefined,
				campaign_id: stateFilterCampaignId.trim() || undefined,
				user_id: stateFilterUserId.trim() || undefined
			});
			userStates = response.items;
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_migration_search_failed();
			userStates = [];
		} finally {
			loading = false;
		}
	}

	async function resetState(state: DirectoryAuthMigrationUserStateRecord) {
		if (!tenantId || !canEdit) return;
		resettingStateId = state.id;
		error = '';
		successMessage = '';
		try {
			await adminDirectoryAuthAPI.resetUserState(
				tenantId,
				state.id,
				resetReasons[state.id]?.trim() || 'admin_reset'
			);
			successMessage = $LL.admin_directory_authentication_migration_state_reset();
			await loadMigration(tenantId);
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_directory_authentication_migration_state_reset_failed();
		} finally {
			resettingStateId = '';
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
		const selectedTenantId = settingsContext.tenantId;
		if (!selectedTenantId) {
			loading = false;
			error = $LL.admin_directory_authentication_migration_select_tenant();
			return;
		}
		await loadMigration(selectedTenantId);
	});

	$effect(() => {
		if (!currentTenantId || loading || currentTenantId === tenantId) return;
		void loadMigration(currentTenantId);
	});
</script>

<svelte:head>
	<title>{$LL.admin_directory_authentication_migration_page_title()}</title>
</svelte:head>

{#snippet headerActions()}
	<button
		class="btn btn-primary"
		disabled={loading || !tenantId}
		onclick={() => loadMigration(tenantId)}
	>
		{$LL.admin_directory_authentication_pending_refresh()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_directory_authentication_migration_title()}
		description={$LL.admin_directory_authentication_migration_description()}
		actions={headerActions}
	/>

	<DirectoryAuthenticationTabs active="migration" />

	{#if error}
		<div class="alert alert--error">{error}</div>
	{/if}
	{#if successMessage}
		<div class="alert alert--success">{successMessage}</div>
	{/if}

	<AdminSection
		title={$LL.admin_directory_authentication_migration_tenant_policy_title()}
		description={$LL.admin_directory_authentication_migration_tenant_policy_description()}
	>
		<div class="policy-row">
			<label>
				<span>{$LL.admin_directory_authentication_migration_tenant_fallback_label()}</span>
				<select bind:value={tenantFallbackMode} disabled={!canEdit || saving}>
					<option value="migration_recovery">{emailFallbackModeLabel('migration_recovery')}</option>
					<option value="admin_invitation_only"
						>{emailFallbackModeLabel('admin_invitation_only')}</option
					>
					<option value="login_method">{emailFallbackModeLabel('login_method')}</option>
					<option value="directory_unavailable_recovery"
						>{emailFallbackModeLabel('directory_unavailable_recovery')}</option
					>
					<option value="disabled">{emailFallbackModeLabel('disabled')}</option>
				</select>
			</label>
			<button class="btn btn-primary" disabled={!canEdit || saving} onclick={saveTenantPolicy}>
				{$LL.admin_directory_authentication_migration_save_policy()}
			</button>
		</div>
		{#if tenantPolicy}
			<p class="meta-line">
				{$LL.admin_directory_authentication_migration_current()}
				{emailFallbackModeLabel(tenantPolicy.email_code_fallback_mode)};
				{$LL.admin_directory_authentication_migration_updated()}
				{formatTime(tenantPolicy.updated_at)}
				{$LL.admin_directory_authentication_migration_by()}
				{tenantPolicy.updated_by ?? '-'}
			</p>
		{/if}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_migration_campaigns_title()}
		description={$LL.admin_directory_authentication_migration_campaigns_description()}
	>
		<div class="create-row">
			<label>
				<span>{$LL.admin_directory_authentication_migration_campaign_name()}</span>
				<input bind:value={newCampaignName} disabled={!canEdit || saving} />
			</label>
			<label>
				<span>{$LL.admin_directory_authentication_migration_campaign_mode()}</span>
				<select bind:value={newCampaignMode} disabled={!canEdit || saving}>
					<option value="directory_login_allowed"
						>{migrationModeLabel('directory_login_allowed')}</option
					>
					<option value="prompt_passkey">{migrationModeLabel('prompt_passkey')}</option>
					<option value="grace_then_require_passkey"
						>{migrationModeLabel('grace_then_require_passkey')}</option
					>
					<option value="require_passkey_after_directory"
						>{migrationModeLabel('require_passkey_after_directory')}</option
					>
					<option value="disabled">{migrationModeLabel('disabled')}</option>
				</select>
			</label>
			<label>
				<span>{$LL.admin_directory_authentication_migration_email_fallback()}</span>
				<select bind:value={newEmailFallbackMode} disabled={!canEdit || saving}>
					<option value="tenant_default">{emailFallbackModeLabel('tenant_default')}</option>
					<option value="migration_recovery">{emailFallbackModeLabel('migration_recovery')}</option>
					<option value="admin_invitation_only"
						>{emailFallbackModeLabel('admin_invitation_only')}</option
					>
					<option value="login_method">{emailFallbackModeLabel('login_method')}</option>
					<option value="directory_unavailable_recovery"
						>{emailFallbackModeLabel('directory_unavailable_recovery')}</option
					>
					<option value="disabled">{emailFallbackModeLabel('disabled')}</option>
				</select>
				<small>{$LL.admin_directory_authentication_migration_admin_invitation_hint()}</small>
			</label>
			<button
				type="button"
				class="btn btn-primary"
				disabled={!canEdit || saving || !newCampaignName.trim()}
				onclick={createCampaign}
			>
				{$LL.admin_directory_authentication_migration_create_disabled_campaign()}
			</button>
		</div>

		{#if loading}
			<p class="state-text">{$LL.admin_directory_authentication_loading_short()}</p>
		{:else if campaigns.length === 0}
			<div class="empty-state">{$LL.admin_directory_authentication_migration_no_campaigns()}</div>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>{$LL.admin_directory_authentication_migration_campaign_name()}</th>
							<th>{$LL.admin_directory_authentication_migration_status()}</th>
							<th>{$LL.admin_directory_authentication_migration_campaign_mode()}</th>
							<th>{$LL.admin_directory_authentication_migration_prompt()}</th>
							<th>{$LL.admin_directory_authentication_migration_email_fallback()}</th>
							<th>{$LL.admin_directory_authentication_migration_grace()}</th>
							<th>{$LL.admin_directory_authentication_migration_target_policy()}</th>
							<th>{$LL.admin_directory_authentication_migration_user_states_column()}</th>
							<th>{$LL.admin_directory_authentication_migration_cohorts()}</th>
							<th>{$LL.admin_directory_authentication_migration_reasons()}</th>
							<th>{$LL.admin_directory_authentication_migration_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each campaigns as campaign (campaign.id)}
							<tr>
								<td>
									<strong>{campaign.name}</strong>
									{#if campaign.is_template}
										<span class="muted"
											>{$LL.admin_directory_authentication_migration_template()}</span
										>
									{/if}
									<p class="meta-line">
										{$LL.admin_directory_authentication_updated()}
										{formatTime(campaign.updated_at)}
									</p>
								</td>
								<td>
									<select
										bind:value={campaignDrafts[campaign.id].status}
										disabled={!canEdit || saving}
									>
										<option value="disabled">{campaignStatusLabel('disabled')}</option>
										<option value="draft">{campaignStatusLabel('draft')}</option>
										<option value="active">{campaignStatusLabel('active')}</option>
										<option value="paused">{campaignStatusLabel('paused')}</option>
										<option value="archived">{campaignStatusLabel('archived')}</option>
									</select>
								</td>
								<td>
									<select
										bind:value={campaignDrafts[campaign.id].mode}
										disabled={!canEdit || saving}
									>
										<option value="directory_login_allowed"
											>{migrationModeLabel('directory_login_allowed')}</option
										>
										<option value="prompt_passkey">{migrationModeLabel('prompt_passkey')}</option>
										<option value="grace_then_require_passkey"
											>{migrationModeLabel('grace_then_require_passkey')}</option
										>
										<option value="require_passkey_after_directory"
											>{migrationModeLabel('require_passkey_after_directory')}</option
										>
										<option value="disabled">{migrationModeLabel('disabled')}</option>
									</select>
								</td>
								<td>
									<select
										bind:value={campaignDrafts[campaign.id].passkey_prompt_mode}
										disabled={!canEdit || saving}
									>
										<option value="campaign_only">{promptModeLabel('campaign_only')}</option>
										<option value="optional">{promptModeLabel('optional')}</option>
										<option value="none">{promptModeLabel('none')}</option>
									</select>
								</td>
								<td>
									<select
										bind:value={campaignDrafts[campaign.id].email_code_fallback_mode}
										disabled={!canEdit || saving}
									>
										<option value="tenant_default"
											>{emailFallbackModeLabel('tenant_default')}</option
										>
										<option value="migration_recovery"
											>{emailFallbackModeLabel('migration_recovery')}</option
										>
										<option value="admin_invitation_only"
											>{emailFallbackModeLabel('admin_invitation_only')}</option
										>
										<option value="login_method">{emailFallbackModeLabel('login_method')}</option>
										<option value="directory_unavailable_recovery"
											>{emailFallbackModeLabel('directory_unavailable_recovery')}</option
										>
										<option value="disabled">{emailFallbackModeLabel('disabled')}</option>
									</select>
									<p class="meta-line">
										{$LL.admin_directory_authentication_migration_effective()}
										{emailFallbackModeLabel(campaign.effective_email_code_fallback_mode)}
									</p>
								</td>
								<td>
									<input
										type="number"
										min="0"
										max="365"
										bind:value={campaignDrafts[campaign.id].grace_period_days}
										disabled={!canEdit || saving}
									/>
									<p class="meta-line">
										{$LL.admin_directory_authentication_migration_ttl()}
										{campaign.transaction_ttl_seconds}s
									</p>
								</td>
								<td>
									<textarea
										bind:value={campaignDrafts[campaign.id].target_policy_text}
										disabled={!canEdit || saving}
										rows="5"
									></textarea>
								</td>
								<td>{campaignStateCounts(campaign.id) || '-'}</td>
								<td>{campaignCohortCounts(campaign.id) || '-'}</td>
								<td>{campaignReasonCounts(campaign.id) || '-'}</td>
								<td>
									<button
										type="button"
										class="btn btn-secondary btn-small"
										disabled={!canEdit || saving}
										onclick={() => saveCampaign(campaign)}
									>
										{$LL.admin_directory_authentication_save()}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</AdminSection>

	<AdminSection
		title={$LL.admin_directory_authentication_migration_user_states_title()}
		description={$LL.admin_directory_authentication_migration_user_states_description()}
	>
		<div class="filter-row">
			<label>
				<span>{$LL.admin_directory_authentication_migration_user_state()}</span>
				<select bind:value={stateFilterState}>
					<option value="">{$LL.admin_directory_authentication_migration_any_state()}</option>
					<option value="eligible">{migrationUserStateLabel('eligible')}</option>
					<option value="prompted">{migrationUserStateLabel('prompted')}</option>
					<option value="deferred">{migrationUserStateLabel('deferred')}</option>
					<option value="passkey_required">{migrationUserStateLabel('passkey_required')}</option>
					<option value="enrolled">{migrationUserStateLabel('enrolled')}</option>
					<option value="blocked">{migrationUserStateLabel('blocked')}</option>
					<option value="recovered">{migrationUserStateLabel('recovered')}</option>
				</select>
			</label>
			<label>
				<span>{$LL.admin_directory_authentication_migration_campaign_id()}</span>
				<input bind:value={stateFilterCampaignId} placeholder="damc_..." />
			</label>
			<label>
				<span>{$LL.admin_directory_authentication_migration_user_id()}</span>
				<input bind:value={stateFilterUserId} placeholder="user_..." />
			</label>
			<button class="btn btn-secondary" disabled={loading || !tenantId} onclick={searchUserStates}>
				{$LL.admin_directory_authentication_migration_search()}
			</button>
		</div>
		{#if loading}
			<p class="state-text">{$LL.admin_directory_authentication_loading_short()}</p>
		{:else if userStates.length === 0}
			<div class="empty-state">{$LL.admin_directory_authentication_migration_no_user_states()}</div>
		{:else}
			<div class="state-list">
				{#each userStates as state (state.id)}
					<section class="state-row">
						<div>
							<strong>{state.user_id ?? state.directory_subject ?? state.id}</strong>
							<p>
								<span>{migrationUserStateLabel(state.state)}</span>
								<span>{state.connector_id ?? '-'}</span>
								<span>{state.cohort_key ?? '-'}</span>
								<span>{state.blocked_reason || state.recovery_reason || '-'}</span>
								<span>
									{$LL.admin_directory_authentication_migration_first_login()}
									{formatTime(state.first_directory_login_at)}
								</span>
							</p>
						</div>
						<div class="reset-controls">
							<input
								placeholder={$LL.admin_directory_authentication_migration_reset_reason()}
								bind:value={resetReasons[state.id]}
								disabled={!canEdit || resettingStateId === state.id}
							/>
							<button
								type="button"
								class="btn btn-secondary"
								disabled={!canEdit || resettingStateId === state.id}
								onclick={() => resetState(state)}
							>
								{$LL.admin_directory_authentication_migration_reset()}
							</button>
						</div>
					</section>
				{/each}
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
	.create-row {
		display: grid;
		grid-template-columns: minmax(200px, 1fr) minmax(200px, 1fr) minmax(240px, 1.2fr) auto;
		gap: 0.75rem;
		align-items: end;
	}

	.policy-row,
	.filter-row {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) auto;
		gap: 0.75rem;
		align-items: end;
	}

	.filter-row {
		grid-template-columns: minmax(160px, 0.8fr) minmax(220px, 1fr) minmax(220px, 1fr) auto;
		margin-bottom: 1rem;
	}

	label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.875rem;
	}

	label small {
		color: var(--color-text-muted);
		line-height: 1.35;
	}

	input,
	select,
	textarea {
		min-height: 2.5rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
		color: var(--color-text);
		padding: 0 0.75rem;
	}

	textarea {
		width: min(28rem, 100%);
		min-height: 8rem;
		padding: 0.5rem 0.75rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
		resize: vertical;
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	th,
	td {
		border-bottom: 1px solid var(--color-border);
		padding: 0.75rem;
		text-align: left;
		vertical-align: top;
	}

	.muted {
		display: inline-flex;
		border-radius: 999px;
		padding: 0.15rem 0.5rem;
		background: var(--color-surface-muted);
		font-size: 0.75rem;
	}

	.meta-line {
		margin: 0.25rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}

	.state-list {
		display: grid;
		gap: 0.75rem;
	}

	.state-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
		gap: 1rem;
		align-items: center;
		border-bottom: 1px solid var(--color-border);
		padding: 0.75rem 0;
	}

	.state-row p {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.25rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
	}

	.reset-controls {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.5rem;
	}

	@media (max-width: 760px) {
		.create-row,
		.policy-row,
		.filter-row,
		.state-row,
		.reset-controls {
			grid-template-columns: 1fr;
		}
	}
</style>
