/**
 * Lets controls inside a SaveScope find the saved value of the field they edit, so each can
 * show that it has been changed without the page wiring it up.
 */
import { getContext, onDestroy, setContext } from 'svelte';
import { sameValue } from './draft.svelte';

const SAVE_SCOPE = Symbol('save-scope');

export interface SaveScopeContext {
	original(field: string): unknown;
	/** A field says whether it currently holds a value that must not be saved. */
	report?(field: symbol, invalid: boolean): void;
}

/**
 * Thrown by a page's `onsave` when it has already told the admin why nothing (more) was saved
 * (they chose in a dialog, a field shows the problem): the values stay unsaved, and no error
 * toast repeats it.
 */
export class SaveStopped extends Error {
	constructor() {
		super('');
		this.name = 'SaveStopped';
	}
}

export function provideSaveScope(context: SaveScopeContext): void {
	setContext(SAVE_SCOPE, context);
}

/**
 * For a control: `changed(field, value)` is true when `value` (what the control shows now)
 * differs from the saved value of `field`. Outside a SaveScope, or without a field, it is
 * never changed. Call during component init; call the result in markup or `$derived`.
 */
export function useChangeMark() {
	const scope = getContext<SaveScopeContext | undefined>(SAVE_SCOPE);
	return {
		changed(field: string | undefined, value: unknown): boolean {
			if (!scope || field === undefined) return false;
			return !sameValue(scope.original(field), value);
		},
		original(field: string | undefined): unknown {
			return scope && field !== undefined ? scope.original(field) : undefined;
		}
	};
}

/**
 * For a field that can hold something that must not be saved (text that is not a number, a
 * value out of range, a repeated entry): call the result with the field's `invalid` state,
 * usually from an effect. While any field reports true, Save moves focus to the first field
 * with an error instead of saving. Leaving the page clears the report.
 */
export function useInvalidReport(): (invalid: boolean) => void {
	const scope = getContext<SaveScopeContext | undefined>(SAVE_SCOPE);
	const self = Symbol('field');
	onDestroy(() => scope?.report?.(self, false));
	return (invalid) => scope?.report?.(self, invalid);
}
