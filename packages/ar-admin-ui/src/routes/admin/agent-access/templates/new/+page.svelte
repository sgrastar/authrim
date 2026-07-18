<script lang="ts">
	import { goto } from '$app/navigation';
	import { adminAgentAccessAPI } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let type: 'task_set' | 'scope_policy' = $state('task_set');
	let sourceId = $state('');
	let sourceVersion = $state(1);
	let saving = $state(false);
	let error = $state('');
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		error = '';
		try {
			const result = await adminAgentAccessAPI.publishTemplate({
				template_type: type,
				source_object_id: sourceId.trim(),
				source_object_version: sourceVersion
			});
			await goto(
				`/admin/agent-access/templates/${encodeURIComponent(result.id)}/${result.version}`
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_template_new()}</title></svelte:head>
<AdminPageShell width="narrow"
	><AdminPageHeader
		title={$LL.admin_agent_access_template_new()}
		description={$LL.admin_agent_access_templates_description()}
	/><AgentAccessNav />{#if error}<div class="alert alert-error">{error}</div>{/if}
	<form onsubmit={submit}>
		<AdminSection
			><label
				><span>{$LL.admin_agent_access_template_source_type()}</span><select bind:value={type}
					><option value="task_set">Task Set</option><option value="scope_policy"
						>Scope Policy</option
					></select
				></label
			><label
				><span>{$LL.admin_agent_access_template_source_id()}</span><input
					required
					bind:value={sourceId}
				/></label
			><label
				><span>{$LL.admin_agent_access_template_source_version()}</span><input
					type="number"
					min="1"
					required
					bind:value={sourceVersion}
				/></label
			></AdminSection
		>
		<div class="actions">
			<a class="btn" href="/admin/agent-access/templates">{$LL.admin_agent_access_cancel()}</a
			><button class="btn btn-primary" disabled={saving}
				>{$LL.admin_agent_access_template_publish()}</button
			>
		</div>
	</form></AdminPageShell
>

<style>
	form,
	label {
		display: grid;
		gap: 14px;
	}
	label {
		gap: 6px;
		font-weight: 600;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
