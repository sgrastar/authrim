/**
 * Finding a user or a group in a picker.
 *
 * Users: the users API finds them by exact email address or user ID (sharded storage searches no
 * further), so what was typed is also offered as a user ID when nothing matches. An admin who may
 * not read users (no `admin:users:read`) is not searched for: what they type is offered as a user
 * ID. A search the API refuses (403) does the same and says why; any other failure is the
 * picker's own "could not search" (the error is passed on).
 *
 * Groups: found by key or name, the first page of matches (typing more narrows them).
 */
import type { AdminUsersClient } from '#lib/api/admin-users.js';
import { ApiError } from '#lib/api/api-error.js';
import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';
import type { PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';

export type PickerSearch = (query: string, signal: AbortSignal) => Promise<PickerItem[]>;

export interface UserSearchOptions {
	/** Under a typed value offered as a user ID ("Use this user ID"). */
	typedAsId: string;
	/** Under it when the search was refused. */
	searchRefused: string;
	/** The admin may read users (`admin:users:read`); otherwise nothing is searched. */
	canSearch: boolean;
	/** Users to leave out (already members). */
	exclude?: () => ReadonlySet<string>;
}

/** A typed value that can be a user ID (not an address, no spaces). */
const asId = (typed: string) => typed !== '' && !/[\s@]/.test(typed);

export function userSearch(
	users: Pick<AdminUsersClient, 'list'>,
	options: UserSearchOptions
): PickerSearch {
	const typedItem = (typed: string, description: string): PickerItem[] =>
		asId(typed) && !(options.exclude?.() ?? new Set<string>()).has(typed)
			? [{ value: typed, label: typed, description, icon: 'userCircleDashed' }]
			: [];
	return async (query, signal) => {
		const typed = query.trim();
		if (!typed) return [];
		if (!options.canSearch) return typedItem(typed, options.typedAsId);
		let found: PickerItem[];
		try {
			const page = await users.list({ search: typed, limit: 10 }, signal);
			const skip = options.exclude?.() ?? new Set<string>();
			found = page.users
				.filter((user) => !skip.has(user.id))
				.map((user) => ({
					value: user.id,
					label: user.name?.trim() || user.email || user.id,
					description: user.email ?? user.id,
					icon: 'userCircle' as const
				}));
		} catch (error) {
			if (error instanceof ApiError && error.status === 403)
				return typedItem(typed, options.searchRefused);
			throw error;
		}
		if (!found.some((item) => item.value === typed))
			found.push(...typedItem(typed, options.typedAsId));
		return found;
	};
}

export interface GroupSearchOptions {
	/** Groups to leave out (the group itself, as its own parent). */
	exclude?: () => ReadonlySet<string>;
	/**
	 * Under a typed value offered as a group ID when no group matches it ("Use this group ID").
	 * Left out, nothing typed is offered while the search works (a parent is picked from results).
	 */
	typedAsId?: string;
	/** Under the typed value when the search was refused (403): it is used as a group ID. */
	searchRefused?: string;
}

/**
 * Groups whose key or name holds what was typed (the first page), minus `exclude`. An admin who
 * may give roles but not read groups (no `admin:groups:read`) is refused the search (403): what
 * they type is then offered as a group ID, as the user picker does for users. Other failures are
 * the picker's own.
 */
export function groupSearch(
	groups: Pick<EndUserGroupsClient, 'list'>,
	options: GroupSearchOptions = {}
): PickerSearch {
	const exclude = options.exclude ?? (() => new Set<string>());
	const typedItem = (typed: string, description: string | undefined): PickerItem[] =>
		typed && !/\s/.test(typed) && !exclude().has(typed)
			? [{ value: typed, label: typed, description, icon: 'userCircleDashed' }]
			: [];
	return async (query, signal) => {
		const typed = query.trim();
		let page;
		try {
			page = await groups.list({ q: typed || undefined, page: 1, limit: 20 }, signal);
		} catch (error) {
			if (error instanceof ApiError && error.status === 403)
				return typedItem(typed, options.searchRefused);
			throw error;
		}
		const skip = exclude();
		const found: PickerItem[] = page.items
			.filter((group) => !skip.has(group.id))
			.map((group) => ({
				value: group.id,
				label: group.display_name,
				description: group.group_key,
				icon: 'users' as const
			}));
		if (options.typedAsId && !found.some((item) => item.value === typed))
			found.push(...typedItem(typed, options.typedAsId));
		return found;
	};
}
