/**
 * The keys under which the page keeps what a user has ticked on a consent step. The input is set
 * again whenever the key changes, so a key has to change with anything that makes a tick mean
 * something else: another version of a statement, other terms of agreeing, what it applies to,
 * other choices, other fields or another consent version of a destination.
 *
 * What counts is exactly what the Flow runtime judges when it takes consent: both use the same
 * functions (`@authrim/ar-lib-core`'s consent-presentation-key), so a term added on one side is
 * judged on the other.
 */
import {
	consentPresentationKey,
	destinationPresentationKey,
	type ConsentPresentationDestination,
	type ConsentPresentationItem
} from '@authrim/ar-lib-core/utils/consent-presentation-key';

export function consentInputKey(
	stepId: string,
	policy: { items: ReadonlyArray<ConsentPresentationItem> }
): string {
	return `${stepId}:${consentPresentationKey(policy)}`;
}

export function destinationInputKey(
	stepId: string,
	consent: ConsentPresentationDestination
): string {
	return `${stepId}:${destinationPresentationKey(consent)}`;
}
