/**
 * How a profile's platform layer (api/profile-layer.ts) shows in the console: its badges in a
 * list, the note on its page, and whether the page can change it.
 */
import { keepsCopy, type ProfileLayer } from '#lib/api/profile-layer.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

export interface LayerBadge {
	label: MessageKey;
	tone: 'neutral' | 'info' | 'warning' | 'changed';
}

/** The badges of a profile in a list, in reading order (none for one of the tenant's own). */
export function layerBadges(layer: ProfileLayer | null): LayerBadge[] {
	if (!layer) return [];
	const badges: LayerBadge[] = [];
	if (layer.scope === 'platform') badges.push({ label: 'pl.platform', tone: 'info' });
	if (layer.locked) badges.push({ label: 'pl.locked', tone: 'neutral' });
	if (layer.overridden) badges.push({ label: 'pl.overridden', tone: 'changed' });
	if (layer.overrideInactive) badges.push({ label: 'pl.inactive', tone: 'warning' });
	if (layer.platformUpdated) badges.push({ label: 'pl.updated', tone: 'info' });
	return badges;
}

export interface LayerNote {
	tone: 'info' | 'warning';
	/** The paragraphs of the note, in order. */
	lines: MessageKey[];
	/** The page offers "use the platform's values". */
	canRevert: boolean;
}

/** The note a profile's page shows about its platform layer (null: nothing to say). */
export function layerNote(layer: ProfileLayer | null): LayerNote | null {
	if (!layer) return null;
	const copy = keepsCopy(layer);
	if (!layer.editable) {
		const lines: MessageKey[] = [];
		if (layer.overrideInactive) {
			// The tenant's copy is set aside: what is shown is the platform's.
			lines.push(
				layer.overrideInactiveReason === 'locked' || layer.locked
					? 'pl.readOnlyLocked'
					: 'pl.readOnlyNotAllowed',
				'pl.copyKept'
			);
		} else if (layer.locked && !layer.overridden) {
			lines.push('pl.readOnlyLocked');
		} else {
			// Not changeable now for a reason the answer does not give (the platform is deleting
			// it, say): what holds is not asserted.
			lines.push('pl.readOnly');
		}
		return { tone: 'warning', lines, canRevert: copy };
	}
	const lines: MessageKey[] = [];
	if (layer.scope === 'platform') lines.push(copy ? 'pl.copyActive' : 'pl.copyNote');
	else lines.push('pl.defaultNote');
	if (layer.platformUpdated) lines.push('pl.updatedNote');
	return { tone: 'info', lines, canRevert: copy };
}

/** Whether the page may change the profile (a layer the platform sets aside cannot be). */
export const layerEditable = (layer: ProfileLayer | null): boolean => layer?.editable !== false;
