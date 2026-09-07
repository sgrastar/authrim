<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let tools: Awaited<ReturnType<typeof adminAgentAccessAPI.getToolCatalog>>['tools'] = $state([]);
	let selected: string[] = $state([]);
	let name = $state('');
	let description = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	onMount(async () => {
		try {
			tools = (await adminAgentAccessAPI.getToolCatalog()).tools;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
	function toggle(id: string, checked: boolean) {
		selected = checked ? [...new Set([...selected, id])] : selected.filter((item) => item !== id);
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim() || selected.length === 0) return;
		saving = true;
		error = '';
		try {
			const created = await adminAgentAccessAPI.createTaskSet({
				name: name.trim(),
				description: description.trim() || undefined,
				tool_ids: selected
			});
			await goto(`/admin/agent-access/task-sets/${encodeURIComponent(created.id)}`);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_task_set_new()}</title></svelte:head>
<AdminPageShell width="narrow"
	><AdminPageHeader
		title={$LL.admin_agent_access_task_set_new()}
		description={$LL.admin_agent_access_task_sets_description()}
	/><AgentAccessNav />
	{#if error}<div class="alert alert-error">{error}</div>{/if}
	{#if loading}<div class="state">{$LL.admin_agent_access_loading()}</div>{:else}<form
			onsubmit={submit}
		>
			<AdminSection>
				<label
					>{$LL.admin_agent_access_task_set_name()}<input
						bind:value={name}
						maxlength="120"
						required
					/></label
				>
				<label
					>{$LL.admin_agent_access_task_set_description()}<textarea
						bind:value={description}
						maxlength="1000"
					></textarea></label
				>
			</AdminSection><AdminSection
				><fieldset>
					<legend>{$LL.admin_agent_access_task_set_tools()}</legend
					>{#each tools as tool (tool.tool_id)}<label class="tool"
							><input
								type="checkbox"
								checked={selected.includes(tool.tool_id)}
								onchange={(event) => toggle(tool.tool_id, event.currentTarget.checked)}
							/><span
								><strong>{tool.name}</strong><small>{tool.tool_id} · {tool.risk_level}</small></span
							></label
						>{/each}
				</fieldset></AdminSection
			>
			<div class="actions">
				<a class="btn btn-secondary" href="/admin/agent-access/task-sets"
					>{$LL.admin_agent_access_cancel()}</a
				><button class="btn btn-primary" disabled={saving || selected.length === 0}
					>{$LL.admin_agent_access_task_set_create()}</button
				>
			</div>
		</form>{/if}
</AdminPageShell>

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
	textarea {
		width: 100%;
		padding: 9px 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text);
	}
	textarea {
		min-height: 90px;
	}
	.tool {
		grid-template-columns: auto 1fr;
		align-items: start;
		padding: 10px 0;
		border-bottom: 1px solid var(--color-border);
	}
	.tool input {
		width: auto;
	}
	.tool small {
		display: block;
		color: var(--color-text-muted);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.state {
		padding: 32px;
		text-align: center;
	}
</style>
