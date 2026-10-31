/**
 * Reading numbers typed by people, and choosing how to show a duration. Kept apart from the
 * components so the rules are unit-tested.
 */

export type NumberProblem =
	| { kind: 'invalid' }
	| { kind: 'whole' }
	| { kind: 'range'; min: number; max: number }
	| { kind: 'min'; min: number }
	| { kind: 'max'; max: number };

export interface NumberRules {
	min?: number;
	max?: number;
	/** Only whole numbers (the default: counts, seconds, days). */
	whole?: boolean;
}

/**
 * Reads what was typed. Full-width digits (１２３) and group separators (1,234 · 1 234) are
 * accepted, since people paste and type them; an empty field is `null`, not a problem.
 */
export function parseNumberInput(
	text: string,
	rules: NumberRules = {}
): { value: number | null; problem: NumberProblem | null } {
	const normalized = text
		.normalize('NFKC')
		.trim()
		.replace(/[\s,_]/g, '')
		.replace(/^[−–]/, '-');
	if (normalized === '') return { value: null, problem: null };
	if (!/^-?\d+(\.\d+)?$/.test(normalized)) return { value: null, problem: { kind: 'invalid' } };
	const value = Number(normalized);
	const whole = rules.whole ?? true;
	if (whole && !Number.isInteger(value)) return { value, problem: { kind: 'whole' } };
	const { min, max } = rules;
	if (min !== undefined && max !== undefined && (value < min || value > max)) {
		return { value, problem: { kind: 'range', min, max } };
	}
	if (min !== undefined && value < min) return { value, problem: { kind: 'min', min } };
	if (max !== undefined && value > max) return { value, problem: { kind: 'max', max } };
	return { value, problem: null };
}

export const DURATION_UNITS = [
	{ id: 'seconds', seconds: 1 },
	{ id: 'minutes', seconds: 60 },
	{ id: 'hours', seconds: 3600 },
	{ id: 'days', seconds: 86400 }
] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number]['id'];

export const unitSeconds = (unit: DurationUnit) =>
	DURATION_UNITS.find((entry) => entry.id === unit)?.seconds ?? 1;

/**
 * The largest allowed unit that shows `seconds` as a whole number: 86400 reads as 1 day,
 * 5400 as 90 minutes, 45 as 45 seconds. Nothing chosen yet: the smallest allowed unit.
 */
export function pickDurationUnit(
	seconds: number | null,
	allowed: readonly DurationUnit[]
): DurationUnit {
	const units = DURATION_UNITS.filter((entry) => allowed.includes(entry.id));
	if (units.length === 0) return 'seconds';
	if (seconds === null || seconds === 0) return units[0].id;
	for (let i = units.length - 1; i >= 0; i--) {
		if (seconds % units[i].seconds === 0) return units[i].id;
	}
	return units[0].id;
}
