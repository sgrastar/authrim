/**
 * Busy scopes: while an action runs (signing in, saving), every control inside the scope stops
 * taking input — buttons, links, text fields, choices — so nothing can be started twice or
 * changed half-way. Controls read the nearest scope themselves; pages only say when it is busy.
 *
 * Scopes nest: a control is busy when any scope around it is.
 */
import { getContext, setContext } from 'svelte';

const BUSY = Symbol('busy');

type ReadBusy = () => boolean;

const IDLE: ReadBusy = () => false;

/** Makes everything rendered below busy while `read()` is true. Call during component init. */
export function provideBusy(read: ReadBusy): void {
	const outer = getContext<ReadBusy | undefined>(BUSY);
	setContext<ReadBusy>(BUSY, outer ? () => read() || outer() : read);
}

/**
 * Reader for the nearest busy scope. Call during component init; call the returned function
 * where the value is used (markup or `$derived`) so it stays reactive.
 */
export function useBusy(): ReadBusy {
	return getContext<ReadBusy | undefined>(BUSY) ?? IDLE;
}
