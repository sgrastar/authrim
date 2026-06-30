<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminFlowsAPI,
		type AdminFlow,
		type AdminFlowAssignmentTargetType,
		type AdminFlowKind,
		type FlowAssignment
	} from '$lib/api/admin-flows';
	import { onMount } from 'svelte';

	type AssignableFlowKind = Extract<AdminFlowKind, 'login' | 'registration'>;

	interface Props {
		targetType: AdminFlowAssignmentTargetType;
		targetId?: string | null;
		title?: string;
		description?: string;
	}

	let { targetType, targetId = null, title = '', description = '' }: Props = $props();

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let message = $state('');
	let flows = $state<AdminFlow[]>([]);
	let assignments = $state<FlowAssignment[]>([]);
	let selectedLoginFlowId = $state('');
	let selectedRegistrationFlowId = $state('');
	let loginEnabled = $state(true);
	let registrationEnabled = $state(true);

	const normalizedTargetId = $derived(targetType === 'tenant' ? null : (targetId ?? '').trim());
	const loginFlows = $derived(flows.filter((flow) => flow.kind === 'login'));
	const registrationFlows = $derived(flows.filter((flow) => flow.kind === 'registration'));

	function targetReady(): boolean {
		return targetType === 'tenant' || Boolean(normalizedTargetId);
	}

	function localTargetMatches(assignment: FlowAssignment): boolean {
		if (assignment.target_type !== targetType) return false;
		if (targetType === 'tenant') return assignment.target_id === null;
		return assignment.target_id === normalizedTargetId;
	}

	function getScopedAssignment(kind: AssignableFlowKind): FlowAssignment | undefined {
		return assignments
			.filter(localTargetMatches)
			.find((assignment) => assignment.flow_kind === kind);
	}

	function applyAssignments(nextAssignments: FlowAssignment[]) {
		assignments = nextAssignments;
		const login = getScopedAssignment('login');
		const registration = getScopedAssignment('registration');
		selectedLoginFlowId = login?.flow_id ?? '';
		selectedRegistrationFlowId = registration?.flow_id ?? '';
		loginEnabled = login ? login.enabled : true;
		registrationEnabled = registration ? registration.enabled : true;
	}

	async function loadSettings() {
		if (!targetReady()) return;
		loading = true;
		error = '';
		message = '';
		try {
			const [flowResponse, assignmentResponse] = await Promise.all([
				adminFlowsAPI.list({ status: 'published', limit: 100 }),
				adminFlowsAPI.listAssignments({
					target_type: targetType,
					...(targetType === 'tenant' ? {} : { target_id: normalizedTargetId ?? undefined })
				})
			]);
			flows = flowResponse.flows;
			assignments = assignmentResponse.assignments;
			applyAssignments(assignmentResponse.assignments);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_flows_load_error();
		} finally {
			loading = false;
		}
	}

	async function saveOne(kind: AssignableFlowKind, flowId: string, enabled: boolean) {
		if (!flowId) {
			if (getScopedAssignment(kind)) {
				await adminFlowsAPI.deleteAssignment({
					target_type: targetType,
					target_id: normalizedTargetId,
					flow_kind: kind
				});
			}
			return;
		}
		await adminFlowsAPI.upsertAssignment({
			target_type: targetType,
			target_id: normalizedTargetId,
			flow_kind: kind,
			flow_id: flowId,
			enabled
		});
	}

	async function saveSettings() {
		if (!targetReady()) return;
		saving = true;
		error = '';
		message = '';
		try {
			await Promise.all([
				saveOne('login', selectedLoginFlowId, loginEnabled),
				saveOne('registration', selectedRegistrationFlowId, registrationEnabled)
			]);
			message = $LL.admin_flows_assignment_saved();
			await loadSettings();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_flows_assignment_save_failed();
		} finally {
			saving = false;
		}
	}

	function flowLabel(flow: AdminFlow): string {
		return flow.display_name || flow.name || flow.slug;
	}

	function emptyOptionLabel(kind: AssignableFlowKind): string {
		return kind === 'login'
			? $LL.admin_flows_assignment_no_login_flow()
			: $LL.admin_flows_assignment_no_registration_flow();
	}

	function defaultDescription(): string {
		return $LL.admin_flows_assignment_default_description();
	}

	function refreshLabel(): string {
		return $LL.admin_flows_refresh();
	}

	function saveTargetFirstLabel(): string {
		return $LL.admin_flows_assignment_save_target_first();
	}

	onMount(() => {
		void loadSettings();
	});
</script>

<div class="flow-assignment-settings">
	<div class="flow-assignment-settings__header">
		<div>
			<h3>{title || $LL.admin_flows_assignments_title()}</h3>
			<p>{description || defaultDescription()}</p>
		</div>
		<button type="button" class="btn btn-secondary btn-sm" onclick={() => void loadSettings()}>
			{refreshLabel()}
		</button>
	</div>

	{#if !targetReady()}
		<p class="field-hint">{saveTargetFirstLabel()}</p>
	{:else if loading}
		<p class="field-hint">{$LL.admin_flows_loading()}</p>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if message}
			<div class="alert alert-success">{message}</div>
		{/if}

		<div class="flow-assignment-settings__grid">
			<label>
				<span>{$LL.admin_flows_kind_login()}</span>
				<select bind:value={selectedLoginFlowId}>
					<option value="">{emptyOptionLabel('login')}</option>
					{#each loginFlows as flow (flow.id)}
						<option value={flow.id}>{flowLabel(flow)}</option>
					{/each}
				</select>
			</label>
			<label class="flow-assignment-settings__toggle">
				<input type="checkbox" bind:checked={loginEnabled} disabled={!selectedLoginFlowId} />
				<span>{$LL.admin_flows_assignment_enabled()}</span>
			</label>
			<label>
				<span>{$LL.admin_flows_kind_registration()}</span>
				<select bind:value={selectedRegistrationFlowId}>
					<option value="">{emptyOptionLabel('registration')}</option>
					{#each registrationFlows as flow (flow.id)}
						<option value={flow.id}>{flowLabel(flow)}</option>
					{/each}
				</select>
			</label>
			<label class="flow-assignment-settings__toggle">
				<input
					type="checkbox"
					bind:checked={registrationEnabled}
					disabled={!selectedRegistrationFlowId}
				/>
				<span>{$LL.admin_flows_assignment_enabled()}</span>
			</label>
		</div>

		<div class="flow-assignment-settings__actions">
			<button type="button" class="btn btn-primary" onclick={saveSettings} disabled={saving}>
				{saving ? $LL.admin_flows_assignment_saving() : $LL.admin_flows_assignment_save()}
			</button>
			<a class="btn btn-secondary" href="/admin/flows">{$LL.admin_flows_title()}</a>
		</div>

		{#if assignments.filter(localTargetMatches).length === 0}
			<p class="field-hint">{$LL.admin_flows_assignments_empty()}</p>
		{/if}
	{/if}
</div>

<style>
	.flow-assignment-settings {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.flow-assignment-settings__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.flow-assignment-settings__header h3 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
		font-weight: 650;
		color: var(--text-primary, var(--color-text));
	}

	.flow-assignment-settings__header p {
		margin: 0;
		color: var(--text-secondary, var(--color-text-muted));
		font-size: 0.875rem;
	}

	.flow-assignment-settings__grid {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) auto;
		gap: 0.875rem;
		align-items: end;
	}

	.flow-assignment-settings__grid label {
		display: grid;
		gap: 0.35rem;
	}

	.flow-assignment-settings__grid label > span {
		font-weight: 600;
		font-size: 0.875rem;
		color: var(--text-primary, var(--color-text));
	}

	.flow-assignment-settings__grid select {
		min-height: 2.5rem;
		border: 1px solid var(--color-border, var(--border-color));
		border-radius: var(--radius-md, 0.5rem);
		background: var(--color-surface, var(--surface-color));
		color: var(--color-text, var(--text-primary));
		padding: 0.5rem 0.75rem;
	}

	.flow-assignment-settings__toggle {
		min-height: 2.5rem;
		grid-template-columns: auto 1fr;
		align-items: center;
		padding-bottom: 0.15rem;
	}

	.flow-assignment-settings__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	@media (max-width: 720px) {
		.flow-assignment-settings__grid {
			grid-template-columns: 1fr;
		}
	}
</style>
