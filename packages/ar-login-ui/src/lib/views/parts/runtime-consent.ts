/**
 * Consent choice text for the plain runtime step panel: HTML that has been through
 * `sanitizeRuntimeConsentHtml`, so the panel can hand it to SanitizedHtml as is. (A statement's
 * own text is drawn by StatementConsentItem.)
 */
import type { FlowRuntimeConsentPolicyContent } from '#lib/api/flow-runtime.js';
import { sanitizeRuntimeConsentHtml } from '#lib/consent/runtime-consent-html.js';

type ConsentItem = FlowRuntimeConsentPolicyContent['items'][number];
type ConsentOption = NonNullable<ConsentItem['options']>[number];

export function getRuntimeConsentOptionHtml(option: ConsentOption): string {
	const body = option.description || option.label || option.value;
	return sanitizeRuntimeConsentHtml(body);
}
