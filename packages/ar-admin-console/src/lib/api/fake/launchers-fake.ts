import { ApiError, ConflictError } from '../api-error';
import type {
	ApplicationLauncher,
	LauncherInput,
	LauncherOptions,
	LaunchersClient,
	LauncherUser
} from '../launchers';

/** The icons the Admin API allows (ar-management `PHOSPHOR_ICON_NAMES`). */
export const FAKE_LAUNCHER_ICONS = [
	'airplane-tilt',
	'bank',
	'book-open',
	'books',
	'briefcase',
	'browser',
	'buildings',
	'calendar',
	'chart-line-up',
	'chat-circle-text',
	'cloud',
	'code',
	'compass',
	'database',
	'envelope-simple',
	'folder-open',
	'gear',
	'github-logo',
	'globe',
	'graduation-cap',
	'house',
	'identification-card',
	'key',
	'link',
	'monitor',
	'notebook',
	'presentation-chart',
	'rocket-launch',
	'shield-check',
	'shopping-cart',
	'student',
	'terminal-window',
	'users-three',
	'wrench'
];

export const FAKE_LAUNCHER_OPTIONS: LauncherOptions = {
	oidc_clients: [
		{
			client_id: 'client-portal',
			client_name: 'Student portal',
			initiate_login_uri: 'https://portal.example.edu/login/start',
			logo_uri: null
		},
		{
			client_id: 'client-reports',
			client_name: 'Reports',
			initiate_login_uri: null,
			logo_uri: null
		}
	],
	groups: [
		{ id: 'grp-staff', group_key: 'staff', display_name: 'Staff' },
		{ id: 'grp-students', group_key: 'students', display_name: 'Students' },
		{ id: 'grp-research', group_key: 'research', display_name: 'Research office' }
	],
	attribute_keys: ['email', 'email_verified', 'name', 'locale', 'user_id', 'department'],
	phosphor_icons: FAKE_LAUNCHER_ICONS
};

export const FAKE_LAUNCHER_USERS: readonly LauncherUser[] = [
	{ id: 'user-aiko', name: 'Aiko Tanaka', email: 'aiko@example.edu' },
	{ id: 'user-ben', name: 'Ben Carter', email: 'ben@example.edu' },
	{ id: 'user-chen', name: 'Chen Wei', email: 'chen@example.edu' }
];

const visibility = (
	overrides: Partial<ApplicationLauncher['visibility']> = {}
): ApplicationLauncher['visibility'] => ({
	mode: 'everyone',
	attribute_match: 'all',
	user_ids: [],
	group_ids: [],
	attribute_rules: [],
	...overrides
});

/** Sample launchers: a link, an OIDC client and a SAML service provider shown to some. */
export const FAKE_LAUNCHERS: readonly ApplicationLauncher[] = [
	{
		id: 'ln-docs',
		application_type: 'standalone',
		application_id: null,
		name: 'Documentation',
		description: 'Guides and how-tos for everyday tasks.',
		category: 'Knowledge',
		launch_type: 'bookmark',
		launch_url: 'https://docs.example.edu/',
		deep_link_url: null,
		open_in_new_tab: true,
		icon_type: 'phosphor',
		icon_value: 'book-open',
		icon_color: '#ffffff',
		background_color: '#2563eb',
		tile_background_color: null,
		grid_width: 2,
		sort_order: 0,
		enabled: true,
		allow_favorite: true,
		visibility: visibility(),
		created_at: Date.UTC(2026, 9, 2, 9),
		updated_at: Date.UTC(2026, 10, 4, 14)
	},
	{
		id: 'ln-portal',
		application_type: 'oidc_client',
		application_id: 'client-portal',
		name: 'Student portal',
		description: null,
		category: 'Campus',
		launch_type: 'oidc_third_party_initiated',
		launch_url: 'https://portal.example.edu/login/start',
		deep_link_url: null,
		open_in_new_tab: false,
		icon_type: 'phosphor',
		icon_value: 'graduation-cap',
		icon_color: '#ffffff',
		background_color: '#0f766e',
		tile_background_color: '#ccfbf1',
		grid_width: 3,
		sort_order: 10,
		enabled: true,
		allow_favorite: true,
		visibility: visibility({ mode: 'groups', group_ids: ['grp-students', 'grp-staff'] }),
		created_at: Date.UTC(2026, 9, 5, 9),
		updated_at: Date.UTC(2026, 9, 5, 9)
	},
	{
		id: 'ln-lms',
		application_type: 'saml_sp',
		application_id: 'saml-sp-lms',
		name: 'Learning portal',
		description: 'Courses, assignments and grades.',
		category: 'Campus',
		launch_type: 'saml_idp_initiated',
		launch_url: null,
		deep_link_url: null,
		open_in_new_tab: true,
		icon_type: 'phosphor',
		icon_value: 'student',
		icon_color: '#ffffff',
		background_color: '#7c3aed',
		tile_background_color: null,
		grid_width: 2,
		sort_order: 20,
		enabled: false,
		allow_favorite: false,
		visibility: visibility({
			mode: 'attributes',
			attribute_match: 'any',
			attribute_rules: [
				{ id: 'r1', attribute_key: 'custom.department', operator: 'equals', attribute_value: 'Law' }
			]
		}),
		created_at: Date.UTC(2026, 9, 8, 9),
		updated_at: Date.UTC(2026, 9, 9, 11)
	}
];

const sorted = (items: Iterable<ApplicationLauncher>) =>
	[...items].sort(
		(left, right) => left.sort_order - right.sort_order || left.created_at - right.created_at
	);

/**
 * An in-memory launcher store with the Admin API's rules where the pages depend on them: a
 * missing launcher is 404, a reorder must name every launcher exactly once (else 409), and
 * users are searched by name or email. `failLoad` makes reading the list fail; `forbidden`
 * answers 403 to everything.
 */
export function createFakeLaunchers(
	initial: readonly ApplicationLauncher[] = FAKE_LAUNCHERS,
	behaviour: { failLoad?: boolean; forbidden?: boolean; delay?: number } = {}
): LaunchersClient {
	const store = new Map(initial.map((launcher) => [launcher.id, structuredClone(launcher)]));
	let next = 1;
	const wait = () =>
		new Promise<void>((resolve) => setTimeout(resolve, behaviour.delay ?? 0)).then(() => {
			if (behaviour.forbidden) throw new ApiError(403, 'forbidden', 'Forbidden');
		});
	const found = (id: string) => {
		const launcher = store.get(id);
		if (!launcher) throw new ApiError(404, 'not_found', 'Launcher not found');
		return launcher;
	};
	const save = (id: string, input: LauncherInput, created: number, sortOrder: number) => {
		const launcher: ApplicationLauncher = {
			...structuredClone(input),
			sort_order: input.sort_order ?? sortOrder,
			id,
			created_at: created,
			updated_at: Date.now()
		};
		store.set(id, launcher);
		return structuredClone(launcher);
	};
	return {
		async list() {
			await wait();
			if (behaviour.failLoad) throw new ApiError(500, 'server_error', 'Failed to list launchers');
			return sorted(store.values()).map((launcher) => structuredClone(launcher));
		},
		async get(id) {
			await wait();
			if (behaviour.failLoad) throw new ApiError(500, 'server_error', 'Failed to read launcher');
			return structuredClone(found(id));
		},
		async options() {
			await wait();
			return structuredClone(FAKE_LAUNCHER_OPTIONS);
		},
		async create(input) {
			await wait();
			return save(`ln-new-${next++}`, input, Date.now(), 0);
		},
		async update(id, input) {
			await wait();
			const before = found(id);
			return save(id, input, before.created_at, before.sort_order);
		},
		async reorder(ids) {
			await wait();
			if (
				ids.length !== store.size ||
				ids.some((id) => !store.has(id)) ||
				new Set(ids).size !== ids.length
			)
				throw new ConflictError('Launcher collection changed. Refresh and try again.', {});
			const now = Date.now();
			ids.forEach((id, index) => {
				const launcher = found(id);
				store.set(id, { ...launcher, sort_order: index * 10, updated_at: now });
			});
			return sorted(store.values()).map((launcher) => structuredClone(launcher));
		},
		async remove(id) {
			await wait();
			found(id);
			store.delete(id);
		},
		async searchUsers(query) {
			await wait();
			const text = query.trim().toLowerCase();
			return FAKE_LAUNCHER_USERS.filter(
				(user) =>
					!text || user.name.toLowerCase().includes(text) || user.email.toLowerCase().includes(text)
			).map((user) => ({ ...user }));
		},
		async usersById(ids) {
			await wait();
			return FAKE_LAUNCHER_USERS.filter((user) => ids.includes(user.id)).map((user) => ({
				...user
			}));
		}
	};
}
