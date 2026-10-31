/**
 * Settings being edited: the values last saved and the values on screen. `dirty` says whether
 * anything differs; `original(field)` gives the saved value of one field so a control can mark
 * itself changed. Fields are dotted paths into the value ("mfa.mode").
 */
export class Draft<T extends object> {
	saved = $state() as T;
	value = $state() as T;

	constructor(initial: T) {
		this.saved = copyValue(initial);
		this.value = copyValue(initial);
	}

	get dirty(): boolean {
		return !sameValue(this.saved, this.value);
	}

	/** The saved value at a dotted path. */
	original(field: string): unknown {
		return valueAt(this.saved, field);
	}

	/** Whether the value on screen at `field` differs from the saved one. */
	changed(field: string): boolean {
		return !sameValue(valueAt(this.saved, field), valueAt(this.value, field));
	}

	/** Back to what was saved. */
	discard(): void {
		this.value = copyValue(this.saved);
	}

	/** What is on screen is now what is saved. */
	commit(): void {
		this.saved = copyValue(this.value);
	}

	/** Fresh values from the server (after loading, or someone else's change). */
	reset(next: T): void {
		this.saved = copyValue(next);
		this.value = copyValue(next);
	}
}

/**
 * Deep copy of plain objects and arrays (reads through $state proxies, so no snapshot is
 * needed — $state.snapshot would clone files). Files, dates and other objects are kept as they are:
 * a chosen file never changes, and keeping the same one lets the saved and the edited value
 * be compared exactly.
 */
export function copyValue<V>(value: V): V {
	if (Array.isArray(value)) return value.map(copyValue) as V;
	if (
		value !== null &&
		typeof value === 'object' &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, copyValue(inner)])
		) as V;
	}
	return value;
}

export function valueAt(source: unknown, field: string): unknown {
	return field
		.split('.')
		.reduce<unknown>(
			(current, key) =>
				current !== null && typeof current === 'object'
					? (current as Record<string, unknown>)[key]
					: undefined,
			source
		);
}

/**
 * Equality for settings values: plain objects and arrays by structure, files by what they are
 * (a saved copy of a chosen file is still the same file), dates by time, anything else by
 * identity.
 */
export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (typeof Blob !== 'undefined' && (a instanceof Blob || b instanceof Blob)) {
		if (!(a instanceof Blob && b instanceof Blob)) return false;
		const fileA = a instanceof File ? a : null;
		const fileB = b instanceof File ? b : null;
		return (
			a.size === b.size &&
			a.type === b.type &&
			fileA?.name === fileB?.name &&
			fileA?.lastModified === fileB?.lastModified
		);
	}
	if (a instanceof Date || b instanceof Date) {
		return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	}
	const plain = (value: object) =>
		Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
	if (!plain(a) || !plain(b)) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	return keysA.every((key) =>
		sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
	);
}
