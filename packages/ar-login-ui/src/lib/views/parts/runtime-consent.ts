/**
 * Consent text for the plain runtime step panel. Both helpers return HTML that has been through
 * `sanitizeRuntimeConsentHtml`, so the panel can hand it to SanitizedHtml as is.
 */
import type { FlowRuntimeConsentPolicyContent } from '$lib/api/flow-runtime';
import { sanitizeRuntimeConsentHtml } from '$lib/consent/runtime-consent-html';

type ConsentItem = FlowRuntimeConsentPolicyContent['items'][number];
type ConsentOption = NonNullable<ConsentItem['options']>[number];

export function getRuntimeConsentItemHtml(item: ConsentItem): string {
	if (item.inline_content) return sanitizeRuntimeConsentHtml(item.inline_content);
	const fallback = item.description
		? `<strong>${item.title}</strong><br>${item.description}`
		: item.title;
	return sanitizeRuntimeConsentHtml(fallback);
}

export function getRuntimeConsentOptionHtml(option: ConsentOption): string {
	const body = option.description || option.label || option.value;
	return sanitizeRuntimeConsentHtml(body);
}
