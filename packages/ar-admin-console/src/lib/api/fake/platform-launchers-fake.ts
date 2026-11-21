import { ApiError, ConflictError } from '../api-error';
import type { ConsoleLauncher, LauncherInput, LaunchersClient } from '../launchers';
import { FAKE_BANNER_IMAGE, FAKE_LAUNCHERS, FAKE_LAUNCHER_ICONS } from './launchers-fake';

/** The platform's sample launchers: one for every tenant, one for two, one not shared yet. */
export const FAKE_PLATFORM_LAUNCHERS: readonly ConsoleLauncher[] = [
	{
		...FAKE_LAUNCHERS[0],
		id: 'plc_00000000-0000-4000-8000-000000000001',
		name: 'Library',
		description: 'Search the catalogue and borrow books.',
		category: 'Campus',
		launch_url: 'https://library.example.edu/',
		icon_value: 'books',
		background_image_url: FAKE_BANNER_IMAGE,
		hide_icon: true,
		hide_name: true,
		sort_order: 0,
		sharing: { share_mode: 'all', tenant_ids: [], tenant_change_allowed: true, version: 3 }
	},
	{
		...FAKE_LAUNCHERS[0],
		id: 'plc_00000000-0000-4000-8000-000000000002',
		name: 'Security notices',
		description: null,
		category: 'Support',
		launch_url: 'https://security.example.edu/',
		icon_value: 'shield-check',
		background_color: '#dc2626',
		sort_order: 10,
		sharing: {
			share_mode: 'selected',
			tenant_ids: ['acme', 'globex'],
			tenant_change_allowed: false,
			version: 1
		}
	},
	{
		...FAKE_LAUNCHERS[0],
		id: 'plc_00000000-0000-4000-8000-000000000003',
		name: 'Staff survey',
		description: 'Tell us how we are doing.',
		category: null,
		launch_url: 'https://survey.example.edu/',
		icon_value: 'chat-circle-text',
		background_color: '#7c3aed',
		sort_order: 20,
		enabled: false,
		sharing: { share_mode: 'none', tenant_ids: [], tenant_change_allowed: true, version: 2 }
	}
];

const sorted = (items: Iterable<ConsoleLauncher>) =>
	[...items].sort(
		(left, right) => left.sort_order - right.sort_order || left.created_at - right.created_at
	);

/**
 * An in-memory store of the platform's launchers with the Admin API's rules the pages depend on:
 * a missing launcher is 404, a reorder names every launcher once (else 409), each change bumps
 * the version, and a launcher is a link shown to everyone. `forbidden` answers 403 to
 * everything.
 */
export function createFakePlatformLaunchers(
	initial: readonly ConsoleLauncher[] = FAKE_PLATFORM_LAUNCHERS,
	behaviour: { forbidden?: boolean; delay?: number } = {}
): LaunchersClient {
	const store = new Map(initial.map((launcher) => [launcher.id, structuredClone(launcher)]));
	let next = 1;
	const wait = () =>
		new Promise<void>((resolve) => setTimeout(resolve, behaviour.delay ?? 0)).then(() => {
			if (behaviour.forbidden) throw new ApiError(403, 'forbidden', 'Forbidden');
		});
	const found = (id: string) => {
		const launcher = store.get(id);
		if (!launcher) throw new ApiError(404, 'not_found', 'Platform launcher not found');
		return launcher;
	};
	const save = (id: string, input: LauncherInput, before?: ConsoleLauncher) => {
		const { share_mode, tenant_ids, tenant_change_allowed, ...fields } = structuredClone(input);
		const mode = share_mode ?? before?.sharing?.share_mode ?? 'none';
		const launcher: ConsoleLauncher = {
			...fields,
			application_type: 'standalone',
			application_id: null,
			visibility: { ...fields.visibility, mode: 'everyone' },
			id,
			sort_order: input.sort_order ?? before?.sort_order ?? store.size * 10,
			created_at: before?.created_at ?? Date.now(),
			updated_at: Date.now(),
			shared: null,
			sharing: {
				share_mode: mode,
				tenant_ids: mode === 'selected' ? [...(tenant_ids ?? [])].sort() : [],
				tenant_change_allowed: tenant_change_allowed ?? true,
				version: (before?.sharing?.version ?? 0) + 1
			}
		};
		store.set(id, launcher);
		return structuredClone(launcher);
	};
	return {
		scope: 'platform',
		async list() {
			await wait();
			return sorted(store.values()).map((launcher) => structuredClone(launcher));
		},
		async get(id) {
			await wait();
			return structuredClone(found(id));
		},
		async options() {
			await wait();
			return {
				oidc_clients: [],
				groups: [],
				attribute_keys: [],
				phosphor_icons: FAKE_LAUNCHER_ICONS
			};
		},
		async create(input) {
			await wait();
			return save(`plc_fake-${next++}`, input);
		},
		async update(id, input) {
			await wait();
			const before = found(id);
			if (input.version !== before.sharing?.version)
				throw new ConflictError('The launcher changed; reload and try again', {});
			const { version: _version, ...fields } = input;
			return save(id, fields, before);
		},
		async reorder(ids) {
			await wait();
			if (ids.length !== store.size || ids.some((id) => !store.has(id)))
				throw new ConflictError('Launcher collection changed. Refresh and try again.', {});
			ids.forEach((id, index) => store.set(id, { ...found(id), sort_order: index * 10 }));
			return sorted(store.values()).map((launcher) => structuredClone(launcher));
		},
		async remove(id, version) {
			await wait();
			if (version !== found(id).sharing?.version)
				throw new ConflictError('The launcher changed; reload and try again', {});
			store.delete(id);
		},
		async revert() {
			throw new Error('A platform launcher has no tenant copy to revert');
		},
		async uploadBackground(file) {
			await wait();
			return await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(file);
			});
		},
		async searchUsers() {
			return [];
		},
		async usersById() {
			return [];
		}
	};
}
