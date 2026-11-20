import type {
	FederationCertificate,
	FederationEntity,
	FederationRefreshHistoryItem
} from '#lib/api/federation-sources.js';
import type { FederationEntityState } from '#lib/api/federation-sources.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import type { FederationForm } from '../federation-model';

/**
 * What the federation's own page does with the form it edits: whether it changed, setting an
 * entity aside, adding a certificate, and the numbers it reads out (days left, entities gained).
 * Pure, so the cards stay thin and the rules are tested without a page.
 */

/** The server accepts at most this many entities on the exception list. */
export const MAX_EXCLUDED = 500;

/** A comparable form of the form: two forms with the same snapshot have nothing to save between them. */
export function snapshotForm(form: FederationForm): string {
	return JSON.stringify({
		...form,
		// The order of the list is not a setting, and neither is the order certificates were added in.
		excludedEntityIds: [...new Set(form.excludedEntityIds)].sort(),
		certificates: form.certificates.map((certificate) => certificate.fingerprintSha256).sort()
	});
}

export function formChanged(form: FederationForm, original: string): boolean {
	return snapshotForm(form) !== original;
}

/**
 * The exception list with an entity set aside, or taken back: `{ list }` or, when the list is
 * full, the same list and `full`. Setting aside an entity already on the list leaves it as is.
 */
export function toggleExcluded(
	excluded: readonly string[],
	entityId: string
): { list: string[]; full: boolean } {
	if (excluded.includes(entityId))
		return { list: excluded.filter((id) => id !== entityId), full: false };
	if (excluded.length >= MAX_EXCLUDED) return { list: [...excluded], full: true };
	return { list: [...excluded, entityId], full: false };
}

/** A certificate added to the list, unless one with the same fingerprint is there already. */
export function addCertificate(
	certificates: readonly FederationCertificate[],
	certificate: FederationCertificate
): FederationCertificate[] {
	return certificates.some(
		(existing) => existing.fingerprintSha256 === certificate.fingerprintSha256
	)
		? [...certificates]
		: [...certificates, certificate];
}

/** Whole days until an ISO date-time (negative once it has passed); null when there is none. */
export function remainingDays(validUntil: string | null, now = Date.now()): number | null {
	if (!validUntil) return null;
	const end = Date.parse(validUntil);
	if (!Number.isFinite(end)) return null;
	return Math.floor((end - now) / 86_400_000);
}

/** How many entities a refresh added or took away, as it is read ("+4", "−2", "±0"); empty when unknown. */
export function refreshDelta(item: Pick<FederationRefreshHistoryItem, 'entityCountDelta'>): string {
	const delta = item.entityCountDelta;
	if (delta === null) return '';
	return delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0';
}

/** Where an entity stands once the unsaved exception list is counted (an explicit connection first). */
export function entityStateIn(
	entity: Pick<FederationEntity, 'entityId' | 'explicitProviderId'>,
	excluded: readonly string[]
): FederationEntityState {
	if (entity.explicitProviderId) return 'explicit';
	return excluded.includes(entity.entityId) ? 'excluded' : 'participating';
}

/** The words for a refresh's outcome in the history. */
export function refreshOutcome(item: FederationRefreshHistoryItem): string {
	if (item.status === 'running') return t('sf.fed.history.running');
	if (item.status === 'failed')
		return item.errorCode
			? `${t('sf.fed.history.failed')} (${item.errorCode})`
			: t('sf.fed.history.failed');
	return item.changed === false ? t('sf.fed.history.unchanged') : t('sf.fed.history.updated');
}
