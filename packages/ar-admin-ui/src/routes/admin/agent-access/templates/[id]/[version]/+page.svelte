<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentConfigurationTemplateRecord,
		type AgentTemplateCopyRecord
	} from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let item: AgentConfigurationTemplateRecord | null = $state(null);
	let copies: AgentTemplateCopyRecord[] = $state([]);
	let tenants = $state('');
	let bulkId = $state('');
	let bulkVersion = $state(1);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	const id = $derived($page.params.id ?? '');
	const version = $derived(Number($page.params.version));
	const lines = (value: string) => [
		...new Set(
			value
				.split(/\r?\n|,/)
				.map((entry) => entry.trim())
				.filter(Boolean)
		)
	];
	async function load() {
		const [templates, loadedCopies] = await Promise.all([
			adminAgentAccessAPI.listTemplates(),
			adminAgentAccessAPI.listTemplateCopies(id, version)
		]);
		item =
			templates.find((candidate) => candidate.id === id && candidate.version === version) ?? null;
		copies = loadedCopies;
	}
	onMount(async () => {
		try {
			await load();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
	async function copy(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		error = '';
		try {
			await adminAgentAccessAPI.copyTemplate(id, version, {
				target_tenant_ids: lines(tenants),
				bulk_plan_id: bulkId.trim(),
				bulk_plan_version: bulkVersion
			});
			tenants = '';
			await load();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_template_detail()}</title></svelte:head>
<AdminPageShell
	><AdminPageHeader
		title={$LL.admin_agent_access_template_detail()}
		description={$LL.admin_agent_access_templates_description()}
	/><AgentAccessNav />{#if loading}<div class="state">
			{$LL.admin_agent_access_loading()}
		</div>{:else if error && !item}<div class="alert alert-error">
			{error}
		</div>{:else if item}{#if error}<div class="alert alert-error">{error}</div>{/if}<AdminSection
			><dl>
				<div>
					<dt>{$LL.admin_agent_access_template_source_type()}</dt>
					<dd>{item.templateType}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_template_source_id()}</dt>
					<dd>{item.sourceObjectId} · v{item.sourceObjectVersion}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_digest()}</dt>
					<dd class="mono">{item.definitionDigest}</dd>
				</div>
			</dl>
			<pre>{JSON.stringify(item.definition, null, 2)}</pre></AdminSection
		><AdminSection title={$LL.admin_agent_access_template_copy()}
			><form onsubmit={copy}>
				<label
					><span>{$LL.admin_agent_access_bulk_targets()}</span><textarea
						required
						bind:value={tenants}
					></textarea></label
				><label><span>Bulk Plan ID</span><input required bind:value={bulkId} /></label><label
					><span>Bulk Plan version</span><input
						type="number"
						min="1"
						required
						bind:value={bulkVersion}
					/></label
				><button class="btn btn-primary" disabled={saving}
					>{$LL.admin_agent_access_template_copy()}</button
				>
			</form></AdminSection
		><AdminSection title={$LL.admin_agent_access_template_copies()}
			><AdminDataTable
				><thead
					><tr
						><th>Tenant</th><th>Object</th><th>Bulk Plan</th><th
							>{$LL.admin_agent_access_plan_status()}</th
						></tr
					></thead
				><tbody
					>{#each copies as copyItem (copyItem.id)}<tr
							><td>{copyItem.targetTenantId}</td><td
								>{copyItem.targetObjectId} · v{copyItem.targetObjectVersion}</td
							><td>{copyItem.bulkPlanId} · v{copyItem.bulkPlanVersion}</td><td
								>{copyItem.targetObjectStatus}</td
							></tr
						>{:else}<tr><td colspan="4" class="state">—</td></tr>{/each}</tbody
				></AdminDataTable
			></AdminSection
		>{/if}</AdminPageShell
>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	dl,
	form,
	label {
		display: grid;
		gap: 12px;
	}
	dl div {
		display: grid;
		grid-template-columns: 160px 1fr;
		gap: 12px;
	}
	dt {
		color: var(--color-text-muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	label {
		gap: 6px;
		font-weight: 600;
	}
	textarea {
		min-height: 90px;
	}
	.mono,
	pre {
		font-family: var(--font-mono);
		font-size: 0.76rem;
	}
	pre {
		overflow: auto;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-surface-subtle);
	}
	button {
		justify-self: end;
	}
</style>
