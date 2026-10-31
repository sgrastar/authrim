/**
 * How this administrator wants timestamps shown: in UTC or in the local zone, optionally with
 * the other one alongside. Stored per admin user in this browser.
 * TODO: move to the Admin API once there is an admin preferences endpoint, so the choice
 * follows the admin across devices.
 */
import type { TimeZoneMode } from './format-time';

export interface TimePreference {
	zone: TimeZoneMode;
	showSecondary: boolean;
}

const DEFAULT: TimePreference = { zone: 'local', showSecondary: false };
const PREFIX = 'authrim-console-time:';

let current = $state<TimePreference>({ ...DEFAULT });
let owner = '';

function parse(raw: string | null): TimePreference {
	try {
		const value = JSON.parse(raw ?? '') as Partial<TimePreference>;
		return {
			zone: value.zone === 'utc' ? 'utc' : 'local',
			showSecondary: value.showSecondary === true
		};
	} catch {
		return { ...DEFAULT };
	}
}

function save(): void {
	if (!owner) return;
	try {
		localStorage.setItem(PREFIX + owner, JSON.stringify(current));
	} catch {
		// Storage blocked: the choice lasts for this page only.
	}
}

export const timePreference = {
	get zone(): TimeZoneMode {
		return current.zone;
	},
	get showSecondary(): boolean {
		return current.showSecondary;
	},
	/** Loads the stored choice of the signed-in administrator. */
	loadFor(userId: string): void {
		owner = userId;
		let raw: string | null = null;
		try {
			raw = localStorage.getItem(PREFIX + userId);
		} catch {
			raw = null;
		}
		current = parse(raw);
	},
	setZone(zone: TimeZoneMode): void {
		current = { ...current, zone };
		save();
	},
	setShowSecondary(show: boolean): void {
		current = { ...current, showSecondary: show };
		save();
	}
};
