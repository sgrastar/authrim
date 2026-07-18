<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { adminAgentAccessAPI, type AgentAccessSettings } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let settings: AgentAccessSettings | null = $state(null);
	let highRiskPermissions = $state('');
	let eligibleStandardTools = $state<
		Array<{ tool_id: string; name: string; permissions: string[] }>
	>([]);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	const canWrite = $derived(adminAuth.hasPermission('admin:agent_settings:write'));

	onMount(async () => {
		try {
			const [loadedSettings, catalog] = await Promise.all([
				adminAgentAccessAPI.getSettings(),
				adminAgentAccessAPI.getToolCatalog()
			]);
			settings = loadedSettings;
			eligibleStandardTools = catalog.tools
				.filter((tool) => tool.public_client_standard_opt_in_eligible)
				.map((tool) => ({
					tool_id: tool.tool_id,
					name: tool.name,
					permissions: tool.permissions
				}));
			highRiskPermissions = settings.highRiskPermissionsAdditional.join('\n');
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});

	function parseLines(value: string): string[] {
		return [
			...new Set(
				value
					.split(/\r?\n|,/)
					.map((entry) => entry.trim())
					.filter(Boolean)
			)
		].sort();
	}

	function valid(value: AgentAccessSettings): boolean {
		return (
			value.maxTokenTtlSeconds >= 60 &&
			value.maxTokenTtlSeconds <= 900 &&
			value.elevationTtlSeconds >= 60 &&
			value.elevationTtlSeconds <= 300 &&
			value.rateLimitPerMinute >= 1 &&
			value.rateLimitPerMinute <= 1000 &&
			value.publicClientStandardRateLimitPerMinute >= 1 &&
			value.publicClientStandardRateLimitPerMinute <= 60 &&
			value.publicClientStandardRateLimitPerMinute <= value.rateLimitPerMinute
		);
	}

	function setPublicStandardTool(toolId: string, enabled: boolean) {
		if (!settings) return;
		const selected = new SvelteSet(settings.publicClientStandardToolIds);
		if (enabled) selected.add(toolId);
		else selected.delete(toolId);
		settings.publicClientStandardToolIds = [...selected].sort();
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!settings || !valid(settings)) {
			error = $LL.admin_agent_access_settings_invalid();
			return;
		}
		saving = true;
		error = '';
		notice = '';
		try {
			settings = await adminAgentAccessAPI.updateSettings({
				...settings,
				highRiskPermissionsAdditional: parseLines(highRiskPermissions)
			});
			highRiskPermissions = settings.highRiskPermissionsAdditional.join('\n');
			notice = $LL.admin_agent_access_settings_saved();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_settings_title()}</title></svelte:head>

<AdminPageShell width="narrow">
	<AdminPageHeader
		title={$LL.admin_agent_access_settings_title()}
		description={$LL.admin_agent_access_settings_description()}
	/>
	<AgentAccessNav />

	{#if loading}
		<div class="loading-state">{$LL.admin_agent_access_loading()}</div>
	{:else if !settings}
		<div class="alert alert-error">{error || $LL.admin_agent_access_load_error()}</div>
	{:else}
		{#if error}<div class="alert alert-error">{error}</div>{/if}
		{#if notice}<div class="alert alert-success">{notice}</div>{/if}
		<form onsubmit={save}>
			<AdminSection>
				<fieldset disabled={!canWrite || saving}>
					<label class="toggle-row">
						<input type="checkbox" bind:checked={settings.enabled} />
						<span
							><strong>{$LL.admin_agent_access_setting_enabled()}</strong><small
								>{$LL.admin_agent_access_setting_enabled_help()}</small
							></span
						>
					</label>
					<label class="toggle-row">
						<input type="checkbox" bind:checked={settings.bulkCanaryProtected} />
						<span
							><strong>{$LL.admin_agent_access_setting_bulk_canary_protected()}</strong><small
								>{$LL.admin_agent_access_setting_bulk_canary_protected_help()}</small
							></span
						>
					</label>
					<label class="field">
						<span>{$LL.admin_agent_access_setting_token_ttl()}</span>
						<input
							type="number"
							min="60"
							max="900"
							step="1"
							bind:value={settings.maxTokenTtlSeconds}
						/>
					</label>
					<label class="field">
						<span>{$LL.admin_agent_access_setting_elevation_mode()}</span>
						<select bind:value={settings.elevationMode}>
							<option value="self_reauth">{$LL.admin_agent_access_elevation_self_reauth()}</option>
							<option value="approval">{$LL.admin_agent_access_elevation_approval()}</option>
							<option value="both">{$LL.admin_agent_access_elevation_both()}</option>
						</select>
					</label>
					<label class="field">
						<span>{$LL.admin_agent_access_setting_elevation_ttl()}</span>
						<input
							type="number"
							min="60"
							max="300"
							step="1"
							bind:value={settings.elevationTtlSeconds}
						/>
					</label>
					<label class="field">
						<span>{$LL.admin_agent_access_setting_rate_limit()}</span>
						<input
							type="number"
							min="1"
							max="1000"
							step="1"
							bind:value={settings.rateLimitPerMinute}
						/>
					</label>
					<label class="field">
						<span>{$LL.admin_agent_access_setting_public_standard_rate_limit()}</span>
						<input
							type="number"
							min="1"
							max="60"
							step="1"
							bind:value={settings.publicClientStandardRateLimitPerMinute}
						/>
						<small>{$LL.admin_agent_access_setting_public_standard_rate_limit_help()}</small>
					</label>
					<label class="field">
						<span>{$LL.admin_agent_access_setting_high_risk()}</span>
						<textarea bind:value={highRiskPermissions} spellcheck="false"></textarea>
						<small>{$LL.admin_agent_access_setting_high_risk_help()}</small>
					</label>
					<div class="field">
						<span>{$LL.admin_agent_access_setting_public_standard_tools()}</span>
						<small>{$LL.admin_agent_access_setting_public_standard_tools_help()}</small>
						<div class="tool-options">
							{#each eligibleStandardTools as tool (tool.tool_id)}
								<label class="tool-option">
									<input
										type="checkbox"
										checked={settings.publicClientStandardToolIds.includes(tool.tool_id)}
										onchange={(event) =>
											setPublicStandardTool(tool.tool_id, event.currentTarget.checked)}
									/>
									<span>
										<strong>{tool.name}</strong>
										<small>{tool.permissions.join(', ')}</small>
									</span>
								</label>
							{/each}
						</div>
					</div>
				</fieldset>
			</AdminSection>
			{#if canWrite}
				<div class="actions">
					<button class="btn btn-primary" type="submit" disabled={saving}
						>{saving ? $LL.admin_agent_access_saving() : $LL.admin_agent_access_save()}</button
					>
				</div>
			{/if}
		</form>
	{/if}
</AdminPageShell>

<style>
	form {
		display: grid;
		gap: 16px;
	}
	fieldset {
		display: grid;
		gap: 18px;
		padding: 0;
		border: 0;
	}
	.toggle-row {
		display: grid;
		grid-template-columns: 20px 1fr;
		align-items: start;
		gap: 10px;
		padding-bottom: 18px;
		border-bottom: 1px solid var(--color-border);
	}
	.toggle-row input {
		width: 17px;
		height: 17px;
		margin-top: 2px;
	}
	.toggle-row span {
		display: grid;
		gap: 4px;
	}
	.toggle-row small,
	.field small {
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 400;
		line-height: 1.5;
	}
	.field {
		display: grid;
		gap: 6px;
		color: var(--color-text);
		font-size: 0.82rem;
		font-weight: 700;
	}
	.tool-options {
		display: grid;
		gap: 8px;
	}
	.tool-option {
		display: grid;
		grid-template-columns: 20px 1fr;
		gap: 10px;
		padding: 10px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface);
		font-weight: 400;
	}
	.tool-option span {
		display: grid;
		gap: 3px;
	}
	input[type='number'],
	select,
	textarea {
		width: 100%;
		min-height: 42px;
		padding: 9px 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		background: var(--color-surface);
		color: var(--color-text);
	}
	textarea {
		min-height: 105px;
		resize: vertical;
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.loading-state {
		padding: 32px;
		color: var(--color-text-muted);
		text-align: center;
	}
</style>
