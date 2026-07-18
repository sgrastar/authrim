<script lang="ts">
	import { goto } from '$app/navigation';
	import { adminAgentAccessAPI, type AgentBaselineDefinition } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let name = $state('');
	let mode: 'one_time' | 'managed' = $state('managed');
	let enforcement: 'report_only' | 'standard_auto_remediation' = $state('report_only');
	let definitionJson = $state(
		JSON.stringify(
			{
				schemaVersion: 'authrim-agent-baseline-v1',
				taskSet: { id: '', version: 1, digest: '' },
				configurationProfile: { schemaVersion: 'authrim-agent-plan-v1', steps: [] }
			},
			null,
			2
		)
	);
	let saving = $state(false);
	let error = $state('');
	$effect(() => {
		if (mode === 'one_time') enforcement = 'report_only';
	});
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		error = '';
		try {
			const definition = JSON.parse(definitionJson) as AgentBaselineDefinition;
			const result = await adminAgentAccessAPI.createBaseline({
				name: name.trim(),
				mode,
				enforcement,
				definition
			});
			await goto(
				`/admin/agent-access/baselines/${encodeURIComponent(result.id)}/${result.version}`
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_baseline_new()}</title></svelte:head>
<AdminPageShell width="narrow"
	><AdminPageHeader
		title={$LL.admin_agent_access_baseline_new()}
		description={$LL.admin_agent_access_baselines_description()}
	/><AgentAccessNav />{#if error}<div class="alert alert-error">{error}</div>{/if}
	<form onsubmit={submit}>
		<AdminSection
			><label
				><span>{$LL.admin_agent_access_baseline_name()}</span><input
					required
					bind:value={name}
				/></label
			><label
				><span>{$LL.admin_agent_access_baseline_mode()}</span><select bind:value={mode}
					><option value="managed">managed</option><option value="one_time">one_time</option
					></select
				></label
			>{#if enforcement === 'standard_auto_remediation'}<p class="help">
					{$LL.admin_agent_access_baseline_auto_remediation_help()}
				</p>{/if}<label
				><span>{$LL.admin_agent_access_baseline_enforcement()}</span><select
					bind:value={enforcement}
					disabled={mode === 'one_time'}
					><option value="report_only">report_only</option><option value="standard_auto_remediation"
						>standard_auto_remediation</option
					></select
				></label
			><label
				><span>{$LL.admin_agent_access_baseline_definition()}</span><textarea
					required
					bind:value={definitionJson}
				></textarea></label
			></AdminSection
		>
		<div class="actions">
			<a class="btn" href="/admin/agent-access/baselines">{$LL.admin_agent_access_cancel()}</a
			><button class="btn btn-primary" disabled={saving}
				>{$LL.admin_agent_access_baseline_create()}</button
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
	textarea {
		min-height: 360px;
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}
	.help {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
