/**
 * Where the persistent identifier step gets the names it can choose from (salts, identifier
 * sources, stores, exception lists) and imports into them. The live console provides the Admin
 * API client (`provideIdentifierMaterials`); the mock pages and Storybook, which have none, fall
 * back to an in-memory one, so an import there lives only as long as the page.
 */
import { getContext, setContext } from 'svelte';
import {
	createFakeIdentifierMaterials,
	MOCK_IDENTIFIER_MATERIALS
} from '#lib/api/fake/identifier-materials-fake.js';
import type { IdentifierMaterialsClient } from '#lib/api/identifier-materials.js';

const IDENTIFIER_MATERIALS = Symbol('identifier-materials');

export function provideIdentifierMaterials(client: IdentifierMaterialsClient): void {
	setContext(IDENTIFIER_MATERIALS, client);
}

let fallback: IdentifierMaterialsClient | undefined;

/** Call during component init. */
export function useIdentifierMaterials(): IdentifierMaterialsClient {
	const provided = getContext<IdentifierMaterialsClient | undefined>(IDENTIFIER_MATERIALS);
	if (provided) return provided;
	fallback ??= createFakeIdentifierMaterials(MOCK_IDENTIFIER_MATERIALS);
	return fallback;
}
