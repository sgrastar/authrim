<script lang="ts">
	import type { ApprovalTransportEvidence } from '$lib/api/admin-approvals';
	import {
		getApprovalEvidenceArtifactSwitch,
		getApprovalEvidenceCompletionArtifact,
		getApprovalEvidenceDecisionReceipt,
		getApprovalEvidenceGrantSubjectTokenIssue,
		getApprovalEvidenceEventDescriptor
	} from '$lib/admin/approval-evidence-timeline';
	import { LL } from '$i18n/i18n-svelte';

	type Props = {
		evidence: ApprovalTransportEvidence;
		formatDateTime: (timestamp?: number | null) => string;
		formatJson: (value: unknown) => string;
	};

	let { evidence, formatDateTime, formatJson }: Props = $props();

	function getToneClass(tone: 'info' | 'success' | 'warning' | 'danger'): string {
		return `timeline-card tone-${tone}`;
	}

	function getLocalizedDescriptor(event: ApprovalTransportEvidence['events'][number]) {
		const descriptor = getApprovalEvidenceEventDescriptor(event);
		switch (event.kind) {
			case 'request_created':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_request_created_title(),
					summary: $LL.admin_approvals_event_request_created_summary()
				};
			case 'step_initial':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_step_initial_title(),
					summary: $LL.admin_approvals_event_step_initial_summary()
				};
			case 'step_artifact_issued':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_step_artifact_issued_title(),
					summary: $LL.admin_approvals_event_step_artifact_issued_summary()
				};
			case 'step_receipt_issued':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_step_receipt_issued_title(),
					summary: $LL.admin_approvals_event_step_receipt_issued_summary()
				};
			case 'grant_subject_token_issued':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_subject_token_issued_title(),
					summary: $LL.admin_approvals_event_subject_token_issued_summary()
				};
			case 'grant_revoked':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_grant_revoked_title(),
					summary: $LL.admin_approvals_event_grant_revoked_summary()
				};
			case 'step_remind':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_step_remind_title(),
					summary: $LL.admin_approvals_event_step_remind_summary()
				};
			case 'step_resend':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_step_resend_title(),
					summary: $LL.admin_approvals_event_step_resend_summary()
				};
			case 'step_approved':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_step_approved_title(),
					summary: $LL.admin_approvals_event_step_approved_summary()
				};
			case 'step_denied':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_step_denied_title(),
					summary: $LL.admin_approvals_event_step_denied_summary()
				};
			case 'request_cancelled':
				return {
					...descriptor,
					title: $LL.admin_approvals_event_request_cancelled_title(),
					summary: $LL.admin_approvals_event_request_cancelled_summary()
				};
			default:
				return {
					...descriptor,
					summary: $LL.admin_approvals_event_default_summary()
				};
		}
	}

	function getLocalizedEventMeta(event: ApprovalTransportEvidence['events'][number]): string[] {
		const meta: string[] = [];

		if (event.method) {
			meta.push($LL.admin_approvals_method_label({ value: event.method }));
		}
		if (event.transport_channel) {
			meta.push(`${$LL.admin_approvals_channel()}: ${event.transport_channel}`);
		}
		if (event.notification_action) {
			meta.push(`${$LL.admin_approvals_last_action()}: ${event.notification_action}`);
		}
		if (typeof event.notification_count === 'number') {
			meta.push($LL.admin_approvals_notifications_label({ count: event.notification_count }));
		}
		if (event.reason_code) {
			meta.push($LL.admin_approvals_reason_label({ value: event.reason_code }));
		}

		return meta;
	}
</script>

<div class="detail-grid compact-grid">
	<div>
		<strong>{$LL.admin_approvals_investigation()}</strong>
		<div>{evidence.request.investigation_id}</div>
	</div>
	<div>
		<strong>{$LL.admin_approvals_requested_at()}</strong>
		<div>{formatDateTime(evidence.request.requested_at)}</div>
	</div>
	<div>
		<strong>{$LL.admin_approvals_events()}</strong>
		<div>{evidence.events.length}</div>
	</div>
</div>

<div class="steps-list">
	{#each evidence.events as event (event.id)}
		{@const descriptor = getLocalizedDescriptor(event)}
		{@const meta = getLocalizedEventMeta(event)}
		{@const artifactSwitch = getApprovalEvidenceArtifactSwitch(event)}
		{@const completionArtifact = getApprovalEvidenceCompletionArtifact(event)}
		{@const decisionReceipt = getApprovalEvidenceDecisionReceipt(event)}
		{@const subjectTokenIssue = getApprovalEvidenceGrantSubjectTokenIssue(event)}
		<div class={getToneClass(descriptor.tone)}>
			<div class="step-header">
				<div>
					<div class="cell-primary">{descriptor.title}</div>
					<div class="cell-secondary">{descriptor.summary}</div>
				</div>
				<span class="timeline-timestamp">{formatDateTime(event.at)}</span>
			</div>

			<div class="timeline-badges">
				<span class="timeline-status">{event.request_status}</span>
				{#if event.actor_subject_type}
					<span
						>{event.actor_subject_type}{event.actor_subject_id
							? ` · ${event.actor_subject_id}`
							: ''}</span
					>
				{/if}
				{#each meta as item (item)}
					<span>{item}</span>
				{/each}
			</div>

			{#if artifactSwitch}
				<div class="timeline-summary">
					<strong>{$LL.admin_approvals_method_switch()}</strong>
					<div class="cell-secondary">
						{artifactSwitch.previousMethod ?? '-'} → {artifactSwitch.requestedMethod ?? '-'}
						{#if artifactSwitch.previousArtifactId}
							· {$LL.admin_approvals_replaced_artifact({
								artifactId: artifactSwitch.previousArtifactId
							})}
						{/if}
					</div>
					{#if artifactSwitch.allowedMethods.length > 0}
						<div class="cell-secondary">
							{$LL.admin_approvals_allowed_methods({
								methods: artifactSwitch.allowedMethods.join(', ')
							})}
						</div>
					{/if}
				</div>
			{/if}

			{#if completionArtifact}
				<div class="timeline-summary">
					<strong>{$LL.admin_approvals_completion_artifact()}</strong>
					<div class="cell-secondary">
						{completionArtifact.artifactId ?? '-'} · {$LL.admin_approvals_expires_at({
							value: formatDateTime(completionArtifact.expiresAt)
						})}
					</div>
					{#if completionArtifact.path}
						<div class="cell-secondary">{completionArtifact.path}</div>
					{/if}
				</div>
			{/if}

			{#if decisionReceipt}
				<div class="timeline-summary">
					<strong>{$LL.admin_approvals_decision_receipt()}</strong>
					<div class="cell-secondary">
						{decisionReceipt.receiptId ?? '-'}
						{#if decisionReceipt.decision}
							· {decisionReceipt.decision}
						{/if}
						{#if decisionReceipt.requestStatus}
							· {decisionReceipt.requestStatus}
						{/if}
					</div>
					{#if decisionReceipt.path}
						<div class="cell-secondary">{decisionReceipt.path}</div>
					{/if}
					{#if decisionReceipt.portalPath}
						<div class="cell-secondary">{decisionReceipt.portalPath}</div>
					{/if}
					{#if decisionReceipt.expiresAt}
						<div class="cell-secondary">
							{$LL.admin_approvals_expires_at({
								value: formatDateTime(decisionReceipt.expiresAt)
							})}
						</div>
					{/if}
					{#if decisionReceipt.grantIds.length > 0}
						<div class="cell-secondary">
							{$LL.admin_approvals_grants_count({ count: decisionReceipt.grantIds.length })}:
							{decisionReceipt.grantIds.join(', ')}
						</div>
					{/if}
				</div>
			{/if}

			{#if subjectTokenIssue}
				<div class="timeline-summary">
					<strong>{$LL.admin_approvals_downstream_subject_token()}</strong>
					<div class="cell-secondary">
						{subjectTokenIssue.clientId ?? '-'}
						{#if subjectTokenIssue.grantId}
							· {$LL.admin_approvals_grant_label({ grantId: subjectTokenIssue.grantId })}
						{/if}
						{#if subjectTokenIssue.expiresIn}
							· {$LL.admin_approvals_ttl_label({ seconds: subjectTokenIssue.expiresIn })}
						{/if}
					</div>
					{#if subjectTokenIssue.targetAudience}
						<div class="cell-secondary">
							{$LL.admin_approvals_aud_label({ audience: subjectTokenIssue.targetAudience })}
						</div>
					{/if}
					<div class="cell-secondary">
						{subjectTokenIssue.resourceClass ?? '-'}
						{#if subjectTokenIssue.redactionLevel}
							· {subjectTokenIssue.redactionLevel}
						{/if}
						{#if subjectTokenIssue.requiresOnlineCheck !== null}
							· {$LL.admin_approvals_online_label({
								mode: subjectTokenIssue.requiresOnlineCheck
									? $LL.admin_approvals_online_required()
									: $LL.admin_approvals_online_optional()
							})}
						{/if}
						{#if subjectTokenIssue.failClosed !== null}
							· {subjectTokenIssue.failClosed
								? $LL.admin_approvals_fail_closed()
								: $LL.admin_approvals_policy_controlled()}
						{/if}
					</div>
					{#if subjectTokenIssue.resourceIds.length > 0}
						<div class="cell-secondary">
							{$LL.admin_approvals_resources_label({
								values: subjectTokenIssue.resourceIds.join(', ')
							})}
						</div>
					{/if}
					{#if subjectTokenIssue.detailClasses.length > 0}
						<div class="cell-secondary">
							{$LL.admin_approvals_details_label({
								values: subjectTokenIssue.detailClasses.join(', ')
							})}
						</div>
					{/if}
					{#if subjectTokenIssue.jti}
						<div class="cell-secondary">jti: {subjectTokenIssue.jti}</div>
					{/if}
				</div>
			{/if}

			{#if event.transport_summary}
				<details class="grant-details">
					<summary>{$LL.admin_approvals_transport_summary()}</summary>
					<pre class="json-block">{formatJson(event.transport_summary)}</pre>
				</details>
			{/if}
			{#if event.transport_detail}
				<details class="grant-details">
					<summary>{$LL.admin_approvals_transport_detail()}</summary>
					<pre class="json-block">{formatJson(event.transport_detail)}</pre>
				</details>
			{/if}
			{#if event.approval_step}
				<details class="grant-details">
					<summary>{$LL.admin_approvals_approval_step()}</summary>
					<pre class="json-block">{formatJson(event.approval_step)}</pre>
				</details>
			{/if}
			{#if event.reason_note}
				<div class="step-note">{event.reason_note}</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.timeline-card {
		border: 1px solid var(--color-border-subtle);
		border-radius: 14px;
		padding: 0.9rem;
		background: var(--color-surface-elevated);
	}

	.timeline-card.tone-info {
		border-color: color-mix(in srgb, var(--color-info-500) 28%, var(--color-border-subtle));
	}

	.timeline-card.tone-success {
		border-color: color-mix(in srgb, var(--color-success-500) 35%, var(--color-border-subtle));
	}

	.timeline-card.tone-warning {
		border-color: color-mix(in srgb, var(--color-warning-500) 40%, var(--color-border-subtle));
	}

	.timeline-card.tone-danger {
		border-color: color-mix(in srgb, var(--color-danger-500) 38%, var(--color-border-subtle));
	}

	.timeline-timestamp {
		font-size: 0.82rem;
		color: var(--color-text-secondary);
	}

	.timeline-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.75rem;
	}

	.timeline-badges span {
		border-radius: 999px;
		padding: 0.24rem 0.6rem;
		background: color-mix(in srgb, var(--color-surface-default) 82%, white);
		font-size: 0.77rem;
		color: var(--color-text-secondary);
	}

	.timeline-status {
		font-weight: 700;
		color: var(--color-text-primary);
	}

	.timeline-summary {
		margin-top: 0.75rem;
		display: grid;
		gap: 0.2rem;
	}
</style>
