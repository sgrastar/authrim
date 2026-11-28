/** Personal display preference, stored per administrator in this browser. */
export const HIGHLIGHT_COLORS = [
	'default',
	'blue',
	'cyan',
	'green',
	'purple',
	'pink',
	'orange'
] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number] | 'custom';
const COLORS: Record<string, string> = {
	blue: '#5796e6',
	cyan: '#35b6bd',
	green: '#59aa78',
	purple: '#a786df',
	pink: '#d67fa6',
	orange: '#df9555'
};
const PREFIX = 'authrim-console-highlight:';
const DEFAULT = { enabled: false, color: 'default' as HighlightColor, custom: '#5796e6' };
let current = $state({ ...DEFAULT });
let owner = '';
const isColor = (value: unknown): value is HighlightColor =>
	value === 'custom' || HIGHLIGHT_COLORS.includes(value as (typeof HIGHLIGHT_COLORS)[number]);
const isHex = (value: unknown): value is string =>
	typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
function apply() {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	root.dataset.changeHighlight = current.enabled ? 'on' : 'off';
	const color = current.color === 'custom' ? current.custom : COLORS[current.color];
	if (color) root.style.setProperty('--changed', color);
	else root.style.removeProperty('--changed');
}
function save() {
	apply();
	if (!owner) return;
	try {
		localStorage.setItem(PREFIX + owner, JSON.stringify(current));
	} catch {
		/* Storage can be blocked. */
	}
}
export const highlightPreference = {
	get enabled() {
		return current.enabled;
	},
	get color() {
		return current.color;
	},
	get custom() {
		return current.custom;
	},
	loadFor(userId: string) {
		owner = userId;
		current = { ...DEFAULT };
		try {
			const value = JSON.parse(localStorage.getItem(PREFIX + userId) ?? 'null');
			if (value && typeof value === 'object')
				current = {
					enabled: value.enabled === true,
					color: isColor(value.color) ? value.color : 'default',
					custom: isHex(value.custom) ? value.custom : DEFAULT.custom
				};
		} catch {
			/* Invalid or unavailable storage uses the defaults. */
		}
		apply();
	},
	setEnabled(enabled: boolean) {
		current = { ...current, enabled };
		save();
	},
	setColor(color: HighlightColor) {
		if (isColor(color)) {
			current = { ...current, color };
			save();
		}
	},
	setCustom(custom: string) {
		if (isHex(custom)) {
			current = { ...current, custom };
			save();
		}
	}
};
