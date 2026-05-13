<script lang="ts">
	import type { ApprovalTransportEvidence } from '$lib/api/admin-approvals'
	import {
		getApprovalEvidenceArtifactSwitch,
		getApprovalEvidenceCompletionArtifact,
		getApprovalEvidenceDecisionReceipt,
		getApprovalEvidenceGrantSubjectTokenIssue,
		getApprovalEvidenceEventDescriptor,
		getApprovalEvidenceEventMeta
	} from '$lib/admin/approval-evidence-timeline'

	type Props = {
		evidence: ApprovalTransportEvidence
		formatDateTime: (timestamp?: number | null) => string
		formatJson: (value: unknown) => string
	}

	let { evidence, formatDateTime, formatJson }: Props = $props()

	function getToneClass(tone: 'info' | 'success' | 'warning' | 'danger'): string {
		return `timeline-card tone-${tone}`
	}
</script>

<div class="detail-grid compact-grid">
	<div><strong>Investigation</strong><div>{evidence.request.investigation_id}</div></div>
	<div><strong>Requested At</strong><div>{formatDateTime(evidence.request.requested_at)}</div></div>
	<div><strong>Events</strong><div>{evidence.events.length}</div></div>
</div>

<div class="steps-list">
	{#each evidence.events as event (event.id)}
		{@const descriptor = getApprovalEvidenceEventDescriptor(event)}
		{@const meta = getApprovalEvidenceEventMeta(event)}
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
					<span>{event.actor_subject_type}{event.actor_subject_id ? ` · ${event.actor_subject_id}` : ''}</span>
				{/if}
					{#each meta as item (item)}
					<span>{item}</span>
				{/each}
			</div>

			{#if artifactSwitch}
				<div class="timeline-summary">
					<strong>Method Switch</strong>
					<div class="cell-secondary">
						{artifactSwitch.previousMethod ?? '-'} → {artifactSwitch.requestedMethod ?? '-'}
						{#if artifactSwitch.previousArtifactId}
							· replaced {artifactSwitch.previousArtifactId}
						{/if}
					</div>
					{#if artifactSwitch.allowedMethods.length > 0}
						<div class="cell-secondary">Allowed methods: {artifactSwitch.allowedMethods.join(', ')}</div>
					{/if}
				</div>
			{/if}

			{#if completionArtifact}
				<div class="timeline-summary">
					<strong>Completion Artifact</strong>
					<div class="cell-secondary">{completionArtifact.artifactId ?? '-'} · expires {formatDateTime(completionArtifact.expiresAt)}</div>
					{#if completionArtifact.path}
						<div class="cell-secondary">{completionArtifact.path}</div>
					{/if}
				</div>
			{/if}

			{#if decisionReceipt}
				<div class="timeline-summary">
					<strong>Decision Receipt</strong>
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
						<div class="cell-secondary">expires {formatDateTime(decisionReceipt.expiresAt)}</div>
					{/if}
					{#if decisionReceipt.grantIds.length > 0}
						<div class="cell-secondary">grants: {decisionReceipt.grantIds.join(', ')}</div>
					{/if}
				</div>
			{/if}

			{#if subjectTokenIssue}
				<div class="timeline-summary">
					<strong>Downstream Subject Token</strong>
					<div class="cell-secondary">
						{subjectTokenIssue.clientId ?? '-'}
						{#if subjectTokenIssue.grantId}
							· grant {subjectTokenIssue.grantId}
						{/if}
						{#if subjectTokenIssue.expiresIn}
							· ttl {subjectTokenIssue.expiresIn}s
						{/if}
					</div>
					{#if subjectTokenIssue.targetAudience}
						<div class="cell-secondary">aud {subjectTokenIssue.targetAudience}</div>
					{/if}
					<div class="cell-secondary">
						{subjectTokenIssue.resourceClass ?? '-'}
						{#if subjectTokenIssue.redactionLevel}
							· {subjectTokenIssue.redactionLevel}
						{/if}
						{#if subjectTokenIssue.requiresOnlineCheck !== null}
							· online {subjectTokenIssue.requiresOnlineCheck ? 'required' : 'optional'}
						{/if}
						{#if subjectTokenIssue.failClosed !== null}
							· {subjectTokenIssue.failClosed ? 'fail-closed' : 'policy-controlled'}
						{/if}
					</div>
					{#if subjectTokenIssue.resourceIds.length > 0}
						<div class="cell-secondary">resources: {subjectTokenIssue.resourceIds.join(', ')}</div>
					{/if}
					{#if subjectTokenIssue.detailClasses.length > 0}
						<div class="cell-secondary">details: {subjectTokenIssue.detailClasses.join(', ')}</div>
					{/if}
					{#if subjectTokenIssue.jti}
						<div class="cell-secondary">jti: {subjectTokenIssue.jti}</div>
					{/if}
				</div>
			{/if}

			{#if event.transport_summary}
				<details class="grant-details">
					<summary>Transport Summary</summary>
					<pre class="json-block">{formatJson(event.transport_summary)}</pre>
				</details>
			{/if}
			{#if event.transport_detail}
				<details class="grant-details">
					<summary>Transport Detail</summary>
					<pre class="json-block">{formatJson(event.transport_detail)}</pre>
				</details>
			{/if}
			{#if event.approval_step}
				<details class="grant-details">
					<summary>Approval Step</summary>
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
