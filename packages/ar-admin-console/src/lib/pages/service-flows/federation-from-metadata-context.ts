/**
 * "Add as a federation" for a metadata address that turned out to be an aggregate (many entities
 * in one document). The wizard provides it; the metadata import, which may sit several
 * components below a step, asks for it, so no prop is threaded through each of them. Absent
 * where a federation cannot be added (a connection's own page, the prototype pages).
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('add-as-federation');

export type AddAsFederation = (metadataUrl: string) => void;

export function provideAddAsFederation(handler: AddAsFederation | undefined): void {
	setContext(KEY, handler);
}

/** Call during component init. */
export function useAddAsFederation(): AddAsFederation | undefined {
	return getContext<AddAsFederation | undefined>(KEY);
}
