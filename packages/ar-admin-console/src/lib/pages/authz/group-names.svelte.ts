/**
 * Names of groups a page mentions by id (a role's group scope, the group a role comes through),
 * read one by one as they are needed and kept. A group not readable shows its id: a name that
 * could not be read is never guessed from a partial list.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';

export class GroupNames {
	#client: Pick<EndUserGroupsClient, 'get'>;
	#names = new SvelteMap<string, string>();
	/** Ids asked for already (not reactive: only the names are). */
	#asked: Record<string, true> = {};

	constructor(client: Pick<EndUserGroupsClient, 'get'>) {
		this.#client = client;
	}

	/** What is known already (a page's own data), so it is not read again. */
	know(id: string, name: string | null | undefined): void {
		if (!id || !name) return;
		this.#asked[id] = true;
		if (this.#names.get(id) !== name) this.#names.set(id, name);
	}

	/** The name if known; asks for it once otherwise (undefined until it arrives). */
	name(id: string): string | undefined {
		const known = this.#names.get(id);
		if (known !== undefined || !id || this.#asked[id]) return known;
		this.#asked[id] = true;
		this.#client
			.get(id)
			.then((group) => this.#names.set(id, group.display_name))
			.catch(() => undefined);
		return undefined;
	}
}
