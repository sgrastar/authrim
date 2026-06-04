<script lang="ts">
	import type { ApprovalRequestPreviewResult } from '$lib/api/admin-approvals';
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		preview: ApprovalRequestPreviewResult | null;
		loading?: boolean;
		error?: string;
		canApplyResolvedSteps?: boolean;
		onApplyResolvedSteps?: (() => void) | null;
	}

	let {
		preview,
		loading = false,
		error = '',
		canApplyResolvedSteps = false,
		onApplyResolvedSteps = null
	}: Props = $props();

	function formatDateTime(timestamp?: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString();
	}

	function formatMethods(methods: string[]): string {
		return methods.length ? methods.join(', ') : '-';
	}
</script>

<div class="preview-panel">
	<div class="preview-header">
		<div>
			<h3 class="preview-title">{$LL.admin_approvals_resolution_preview()}</h3>
			<p class="preview-note">{$LL.admin_approvals_preview_note()}</p>
		</div>
		{#if preview && onApplyResolvedSteps}
			<button
				class="apply-button"
				type="button"
				onclick={() => onApplyResolvedSteps?.()}
				disabled={!canApplyResolvedSteps}
			>
				{$LL.admin_approvals_apply_resolved_steps()}
			</button>
		{/if}
	</div>

	{#if loading}
		<div class="preview-empty">{$LL.admin_approvals_resolving_steps()}</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if !preview}
		<div class="preview-empty">
			{$LL.admin_approvals_no_preview()}
		</div>
	{:else}
		<div class="preview-grid">
			<div class="preview-card">
				<h4>{$LL.admin_approvals_request()}</h4>
				<dl class="preview-list">
					<div>
						<dt>{$LL.admin_approvals_investigation()}</dt>
						<dd>{preview.request.investigation_id}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_target()}</dt>
						<dd>{preview.request.target_subject_type}:{preview.request.target_subject_id}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_preset()}</dt>
						<dd>{preview.request.policy_preset}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_redaction()}</dt>
						<dd>{preview.request.redaction_level}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_expires()}</dt>
						<dd>{formatDateTime(preview.request.expires_at)}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_remind_cooldown()}</dt>
						<dd>{preview.request.resolved_policy.notification_cooldown_seconds?.remind ?? '-'}s</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_resend_cooldown()}</dt>
						<dd>{preview.request.resolved_policy.notification_cooldown_seconds?.resend ?? '-'}s</dd>
					</div>
				</dl>
			</div>
			<div class="preview-card">
				<h4>{$LL.admin_approvals_scope()}</h4>
				<dl class="preview-list">
					<div>
						<dt>{$LL.admin_approvals_surface()}</dt>
						<dd>{preview.request.request_surface}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_action()}</dt>
						<dd>{preview.request.requested_action}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_reason()}</dt>
						<dd>{preview.request.reason_code}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_reuse_scope()}</dt>
						<dd>{preview.request.reuse_scope}</dd>
					</div>
					<div>
						<dt>{$LL.admin_approvals_partial_access()}</dt>
						<dd>
							{preview.request.partial_access_allowed
								? $LL.admin_approvals_allowed()
								: $LL.admin_approvals_blocked()}
						</dd>
					</div>
				</dl>
			</div>
		</div>

		<div class="preview-steps">
			{#each preview.steps as step (`${step.step_key}-${step.subject_id ?? 'none'}`)}
				<div class="preview-step {step.transport_resolution_error ? 'preview-step-error' : ''}">
					<div class="preview-step-header">
						<div>
							<div class="preview-step-key">{step.step_key}</div>
							<div class="preview-step-meta">
								{step.side} · {step.subject_type}
								{#if step.subject_id}
									· {step.subject_id}
								{/if}
							</div>
						</div>
						{#if step.transport_resolution_error}
							<span class="preview-badge preview-badge-error"
								>{$LL.admin_approvals_needs_attention()}</span
							>
						{:else}
							<span class="preview-badge">{$LL.admin_approvals_ready()}</span>
						{/if}
					</div>

					<div class="preview-step-grid">
						<div>
							<strong>{$LL.admin_approvals_resolved_method()}</strong><span
								>{step.method ?? '-'}</span
							>
						</div>
						<div>
							<strong>{$LL.admin_approvals_transport_channel()}</strong><span
								>{step.transport_channel ?? '-'}</span
							>
						</div>
						<div>
							<strong>{$LL.admin_approvals_acceptable_methods()}</strong><span
								>{formatMethods(step.acceptable_methods)}</span
							>
						</div>
						<div>
							<strong>{$LL.admin_approvals_selection_source()}</strong><span
								>{step.selection_source}</span
							>
						</div>
						<div>
							<strong>{$LL.admin_approvals_relation_type()}</strong><span
								>{step.relation_type ?? '-'}</span
							>
						</div>
						<div>
							<strong>{$LL.admin_approvals_relation_source()}</strong><span
								>{step.relation_source ?? '-'}</span
							>
						</div>
					</div>

					{#if step.guidance_title || step.guidance_body || step.fallback_note}
						<div class="preview-guidance">
							{#if step.guidance_title}
								<div class="preview-guidance-title">{step.guidance_title}</div>
							{/if}
							{#if step.guidance_body}
								<div class="preview-guidance-body">{step.guidance_body}</div>
							{/if}
							{#if step.fallback_note}
								<div class="preview-guidance-note">{step.fallback_note}</div>
							{/if}
						</div>
					{/if}

					{#if step.transport_resolution_error}
						<div class="preview-error-text">{step.transport_resolution_error}</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.preview-panel {
		border: 1px solid var(--color-border-default);
		border-radius: 16px;
		padding: 1rem;
		background: var(--color-surface-elevated);
	}

	.preview-header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: flex-start;
		margin-bottom: 0.75rem;
	}

	.preview-title {
		margin: 0;
		font-size: 1rem;
	}

	.preview-note {
		margin: 0.25rem 0 0;
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	.apply-button {
		border: 1px solid var(--color-border-default);
		background: var(--color-surface-default);
		color: var(--color-text-primary);
		border-radius: 999px;
		padding: 0.55rem 0.9rem;
		font-weight: 700;
		cursor: pointer;
	}

	.apply-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.preview-empty {
		color: var(--color-text-secondary);
		padding: 0.25rem 0;
	}

	.preview-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.preview-card {
		border: 1px solid var(--color-border-subtle);
		border-radius: 12px;
		padding: 0.75rem;
		background: var(--color-surface-default);
	}

	.preview-card h4 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
	}

	.preview-list {
		display: grid;
		gap: 0.5rem;
		margin: 0;
	}

	.preview-list div {
		display: grid;
		gap: 0.15rem;
	}

	.preview-list dt {
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-secondary);
	}

	.preview-list dd {
		margin: 0;
	}

	.preview-steps {
		display: grid;
		gap: 0.75rem;
	}

	.preview-step {
		border: 1px solid var(--color-border-subtle);
		border-radius: 12px;
		padding: 0.75rem;
		background: var(--color-surface-default);
	}

	.preview-step-error {
		border-color: var(--color-danger-400);
		background: color-mix(in srgb, var(--color-danger-50) 55%, white);
	}

	.preview-step-header {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		align-items: flex-start;
		margin-bottom: 0.5rem;
	}

	.preview-step-key {
		font-weight: 700;
	}

	.preview-step-meta {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.preview-step-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.5rem 0.75rem;
	}

	.preview-step-grid div {
		display: grid;
		gap: 0.15rem;
	}

	.preview-step-grid strong {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-secondary);
	}

	.preview-guidance {
		margin-top: 0.75rem;
		padding: 0.7rem 0.75rem;
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-info-50) 55%, white);
		display: grid;
		gap: 0.25rem;
	}

	.preview-guidance-title {
		font-weight: 700;
	}

	.preview-guidance-body {
		font-size: 0.88rem;
		color: var(--color-text-secondary);
	}

	.preview-guidance-note {
		font-size: 0.84rem;
		color: var(--color-warning-800);
	}

	.preview-badge {
		padding: 0.25rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
		background: var(--color-success-100);
		color: var(--color-success-700);
	}

	.preview-badge-error {
		background: var(--color-danger-100);
		color: var(--color-danger-700);
	}

	.preview-error-text {
		margin-top: 0.5rem;
		color: var(--color-danger-700);
		font-size: 0.875rem;
	}
</style>
