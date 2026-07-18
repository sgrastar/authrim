<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentBaselineRecord,
		type AgentBaselineAssignmentRecord
	} from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';
	let item: AgentBaselineRecord | null = $state(null);
	let assignments: AgentBaselineAssignmentRecord[] = $state([]);
	let tenantId = $state('');
	let bulkId = $state('');
	let bulkVersion = $state(1);
	let working = $state(false);
	let loading = $state(true);
	let error = $state('');
	let exceptionAssignment = $state('');
	let exceptionFields = $state('');
	let exceptionReason = $state('');
	let exceptionHours = $state(24);
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
		const value = await adminAgentAccessAPI.getBaseline(id, version);
		item = value.baseline;
		assignments = value.assignments;
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
	async function assign(event: SubmitEvent) {
		event.preventDefault();
		working = true;
		error = '';
		try {
			await adminAgentAccessAPI.assignBaseline(id, version, {
				tenant_id: tenantId.trim(),
				source_bulk_plan_id: bulkId.trim(),
				source_bulk_plan_version: bulkVersion
			});
			tenantId = '';
			await load();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			working = false;
		}
	}
	async function evaluate(assignmentId: string) {
		working = true;
		error = '';
		try {
			await adminAgentAccessAPI.evaluateBaselineAssignment(assignmentId);
			await load();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			working = false;
		}
	}
	async function createException(event: SubmitEvent) {
		event.preventDefault();
		working = true;
		error = '';
		try {
			await adminAgentAccessAPI.createBaselineException(exceptionAssignment, {
				fields: lines(exceptionFields),
				reason: exceptionReason.trim(),
				expires_at: Date.now() + exceptionHours * 60 * 60_000
			});
			exceptionFields = '';
			exceptionReason = '';
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			working = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_baseline_detail()}</title></svelte:head>
<AdminPageShell
	><AdminPageHeader
		title={$LL.admin_agent_access_baseline_detail()}
		description={$LL.admin_agent_access_baselines_description()}
	/><AgentAccessNav />{#if loading}<div class="state">
			{$LL.admin_agent_access_loading()}
		</div>{:else if error && !item}<div class="alert alert-error">
			{error}
		</div>{:else if item}{#if error}<div class="alert alert-error">{error}</div>{/if}<AdminSection
			><div class="summary">
				<div><span>{$LL.admin_agent_access_baseline_name()}</span><strong>{item.name}</strong></div>
				<div><span>{$LL.admin_agent_access_baseline_mode()}</span><strong>{item.mode}</strong></div>
				<div>
					<span>{$LL.admin_agent_access_baseline_enforcement()}</span><strong
						>{item.enforcement}</strong
					>
				</div>
				<div>
					<span>{$LL.admin_agent_access_digest()}</span><strong class="mono"
						>{item.definitionDigest}</strong
					>
				</div>
			</div>
			<pre>{JSON.stringify(item.definition, null, 2)}</pre></AdminSection
		><AdminSection title={$LL.admin_agent_access_baseline_assign()}
			><form class="compact" onsubmit={assign}>
				<label><span>Tenant ID</span><input required bind:value={tenantId} /></label><label
					><span>Bulk Plan ID</span><input required bind:value={bulkId} /></label
				><label
					><span>Bulk Plan version</span><input
						type="number"
						min="1"
						required
						bind:value={bulkVersion}
					/></label
				><button class="btn btn-primary" disabled={working}
					>{$LL.admin_agent_access_baseline_assign()}</button
				>
			</form></AdminSection
		><AdminSection title={$LL.admin_agent_access_baseline_assignments()}
			><AdminDataTable
				><thead
					><tr
						><th>Tenant</th><th>Source Bulk Plan</th><th>Drift</th><th>Remediation</th><th></th></tr
					></thead
				><tbody
					>{#each assignments as assignment (assignment.id)}<tr
							><td>{assignment.tenantId}</td><td
								>{assignment.sourceBulkPlanId} · v{assignment.sourceBulkPlanVersion}</td
							><td>{assignment.driftStatus ?? 'unknown'}</td><td
								>{#if assignment.remediationBulkPlanId}<a
										href={`/admin/agent-access/bulk-plans/${encodeURIComponent(assignment.remediationBulkPlanId)}/${assignment.remediationBulkPlanVersion ?? 1}`}
										>{assignment.remediationBulkPlanId}</a
									>{:else}—{/if}</td
							><td
								><button class="btn" disabled={working} onclick={() => evaluate(assignment.id)}
									>{$LL.admin_agent_access_baseline_evaluate()}</button
								></td
							></tr
						>{:else}<tr><td colspan="5" class="state">—</td></tr>{/each}</tbody
				></AdminDataTable
			></AdminSection
		>{#if assignments.length > 0}<AdminSection title="Baseline exception"
				><form class="compact" onsubmit={createException}>
					<label
						><span>Assignment</span><select required bind:value={exceptionAssignment}
							><option value="" disabled>Select…</option
							>{#each assignments as assignment (assignment.id)}<option value={assignment.id}
									>{assignment.tenantId}</option
								>{/each}</select
						></label
					><label
						><span>Exact step_id.field paths</span><textarea required bind:value={exceptionFields}
						></textarea></label
					><label><span>Reason</span><input required bind:value={exceptionReason} /></label><label
						><span>Hours</span><input
							type="number"
							min="1"
							max="8760"
							required
							bind:value={exceptionHours}
						/></label
					><button class="btn" disabled={working}>Create exception</button>
				</form></AdminSection
			>{/if}{/if}</AdminPageShell
>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	.summary {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
	}
	.summary div {
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
	}
	.summary span {
		display: block;
		color: var(--color-text-muted);
		font-size: 0.76rem;
	}
	.summary strong {
		display: block;
		margin-top: 5px;
		overflow-wrap: anywhere;
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
	form.compact,
	label {
		display: grid;
		gap: 10px;
	}
	label {
		gap: 5px;
		font-weight: 600;
	}
	form.compact {
		grid-template-columns: repeat(4, minmax(0, 1fr));
		align-items: end;
	}
	textarea {
		min-height: 75px;
	}
	button {
		justify-self: end;
	}
	@media (max-width: 800px) {
		.summary,
		form.compact {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
