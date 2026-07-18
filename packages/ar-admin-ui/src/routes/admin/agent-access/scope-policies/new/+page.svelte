<script lang="ts">
	import { goto } from '$app/navigation';
	import { adminAgentAccessAPI } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';
	let name = $state('');
	let description = $state('');
	let domains = $state('clients\nusers');
	let resources = $state('');
	let fields = $state('');
	let piiMode: 'masked' | 'explicit_unmasked' = $state('masked');
	let maxPerCall = $state(20);
	let maxPlanOperations = $state(25);
	let maxBulkTenants = $state(1);
	let saving = $state(false);
	let error = $state('');
	const lines = (value: string) => [
		...new Set(
			value
				.split('\n')
				.map((item) => item.trim())
				.filter(Boolean)
		)
	];
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const tenantId = adminAuth.user?.tenantId;
		if (!tenantId || !name.trim()) return;
		saving = true;
		error = '';
		try {
			const created = await adminAgentAccessAPI.createScopePolicy({
				name: name.trim(),
				description: description.trim() || undefined,
				definition: {
					tenantIds: [tenantId],
					environmentIds: [],
					domains: lines(domains),
					resourceIds: lines(resources),
					selectors: [],
					allowedFields: lines(fields),
					piiMode,
					maxPerCall,
					maxPlanOperations,
					maxBulkTenants
				}
			});
			await goto(`/admin/agent-access/scope-policies/${encodeURIComponent(created.id)}`);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_scope_policy_new()}</title></svelte:head>
<AdminPageShell width="narrow"
	><AdminPageHeader
		title={$LL.admin_agent_access_scope_policy_new()}
		description={$LL.admin_agent_access_scope_policies_description()}
	/><AgentAccessNav />{#if error}<div class="alert alert-error">{error}</div>{/if}
	<form onsubmit={submit}>
		<AdminSection
			><label
				>{$LL.admin_agent_access_task_set_name()}<input
					bind:value={name}
					required
					maxlength="120"
				/></label
			><label
				>{$LL.admin_agent_access_task_set_description()}<textarea
					bind:value={description}
					maxlength="1000"
				></textarea></label
			><label
				>{$LL.admin_agent_access_scope_policy_tenant()}<input
					value={adminAuth.user?.tenantId || ''}
					disabled
				/></label
			></AdminSection
		><AdminSection
			><label
				>{$LL.admin_agent_access_scope_policy_domains()}<textarea bind:value={domains}
				></textarea></label
			><label
				>{$LL.admin_agent_access_scope_policy_resources()}<textarea bind:value={resources}
				></textarea></label
			><label
				>{$LL.admin_agent_access_scope_policy_fields()}<textarea bind:value={fields}
				></textarea></label
			><label
				>{$LL.admin_agent_access_scope_policy_pii()}<select bind:value={piiMode}
					><option value="masked">{$LL.admin_agent_access_scope_policy_masked()}</option><option
						value="explicit_unmasked">{$LL.admin_agent_access_scope_policy_unmasked()}</option
					></select
				></label
			></AdminSection
		><AdminSection
			><fieldset>
				<legend>{$LL.admin_agent_access_scope_policy_limits()}</legend>
				<div class="limits">
					<label
						>{$LL.admin_agent_access_scope_policy_per_call()}<input
							type="number"
							bind:value={maxPerCall}
							min="1"
							max="100"
						/></label
					><label
						>{$LL.admin_agent_access_scope_policy_per_plan()}<input
							type="number"
							bind:value={maxPlanOperations}
							min="1"
							max="100"
						/></label
					><label
						>{$LL.admin_agent_access_scope_policy_bulk_tenants()}<input
							type="number"
							bind:value={maxBulkTenants}
							min="1"
							max="1000"
						/></label
					>
				</div>
			</fieldset></AdminSection
		>
		<div class="actions">
			<a class="btn btn-secondary" href="/admin/agent-access/scope-policies"
				>{$LL.admin_agent_access_cancel()}</a
			><button class="btn btn-primary" disabled={saving}
				>{$LL.admin_agent_access_scope_policy_create()}</button
			>
		</div>
	</form></AdminPageShell
>

<style>
	form,
	label {
		display: grid;
		gap: 7px;
	}
	form {
		gap: 18px;
	}
	label + label {
		margin-top: 16px;
	}
	input,
	textarea,
	select {
		width: 100%;
		padding: 9px 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text);
	}
	textarea {
		min-height: 72px;
	}
	.limits {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 12px;
	}
	.limits label {
		margin: 0;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	@media (max-width: 700px) {
		.limits {
			grid-template-columns: 1fr;
		}
	}
</style>
