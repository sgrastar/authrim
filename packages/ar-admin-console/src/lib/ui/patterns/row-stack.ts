import { getContext, setContext } from 'svelte';

const ROW_STACK = Symbol('row-stack');

export interface RowStackContext {
	/** Rows are divided by a line and carry their own vertical space (a box of settings). */
	readonly ruled: boolean;
}

export function provideRowStack(context: RowStackContext): void {
	setContext(ROW_STACK, context);
}

/** For a row: the stack it sits in, if any. Call during component init. */
export function useRowStack(): RowStackContext | undefined {
	return getContext<RowStackContext | undefined>(ROW_STACK);
}
