import type { FlowRuntimeConsentPolicyContent } from '$lib/api/flow-runtime';

export interface RuntimeConsentDecisionPayload {
	consent_item_decisions: Record<string, 'selected' | 'denied' | 'granted'>;
	consent_item_selected_values: Record<string, string>;
}

export function initializeRuntimeConsentDecisions(
	policy: FlowRuntimeConsentPolicyContent | null
): Record<string, boolean> {
	if (!policy) return {};
	return Object.fromEntries(
		policy.items.map((item) => [
			item.statement_id,
			item.acceptance_status === 'accepted' ||
				item.checkbox_mode === 'none' ||
				item.checkbox_default_checked
		])
	);
}

export function buildRuntimeConsentDecisionPayload(
	policy: FlowRuntimeConsentPolicyContent | null,
	decisions: Record<string, boolean>,
	selectedValues: Record<string, string>
): RuntimeConsentDecisionPayload {
	if (!policy) {
		return { consent_item_decisions: {}, consent_item_selected_values: {} };
	}
	const pendingItems = policy.items.filter((item) => item.acceptance_status !== 'accepted');
	return {
		consent_item_decisions: Object.fromEntries(
			pendingItems.map((item) => [
				item.statement_id,
				item.content_mode === 'radio'
					? selectedValues[item.statement_id]
						? 'selected'
						: 'denied'
					: item.checkbox_mode === 'none' || decisions[item.statement_id]
						? 'granted'
						: 'denied'
			])
		),
		consent_item_selected_values: Object.fromEntries(
			pendingItems
				.filter((item) => item.content_mode === 'radio')
				.map((item) => [item.statement_id, selectedValues[item.statement_id] || ''])
		)
	};
}

export function canSubmitRuntimeConsentPolicy(
	policy: FlowRuntimeConsentPolicyContent | null,
	decisions: Record<string, boolean>,
	selectedValues: Record<string, string>
): boolean {
	if (!policy) return true;
	return policy.items.every(
		(item) =>
			item.acceptance_status === 'accepted' ||
			!item.is_required ||
			(item.content_mode === 'radio' && Boolean(selectedValues[item.statement_id])) ||
			item.checkbox_mode === 'none' ||
			decisions[item.statement_id] === true
	);
}

export function formatRuntimeConsentAcceptedLabel(
	acceptedAt: number | null | undefined,
	locale: string
): string {
	const isJapanese = locale === 'ja';
	const prefix = isJapanese ? '同意済み' : 'Accepted';
	if (!acceptedAt) return prefix;
	const date = new Intl.DateTimeFormat(isJapanese ? 'ja-JP' : 'en', {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	}).format(new Date(acceptedAt * 1000));
	return `${prefix} · ${date}`;
}
