/**
 * In-memory account pages for Storybook and tests. Follows the settings API's rules the pages
 * react to: a save names the version it was read at (a stale one answers 409), a failure can be
 * made to happen on a call, and nothing is stored until the first save (the preset is shown).
 */
import {
	buildPublication,
	movePlacement,
	newPage,
	parsePagesDocument,
	publishedPage
} from '#lib/pages/customization/account-pages/account-page-model.js';
import { ApiError, ConflictError } from '../api-error';
import type { AccountPagesClient, AccountPagesState, PagesDocument } from '../account-pages';
import type { Screen } from '../screens';

/** Three pages: one live and shown to users, one live with changes since, one never published. */
export function sampleDocument(): PagesDocument {
	const screens = sampleAccountScreens();
	const now = 1_760_000_000_000;
	const base = newPage([], 'Employee portal', now);
	const built = buildPublication(base.draft, screens, '2026-11-01T00:00:00.000Z');
	if (!built.ok) throw new Error('the sample page cannot be published');
	const live = { ...publishedPage(base, base.draft, built.published, now + 1000), id: 'employees' };
	const edited = {
		...live,
		id: 'partners',
		name: 'Partner portal',
		draft: movePlacement(live.draft, live.draft.screens[0].id, 1)
	};
	return {
		schema_version: 'authrim.account_pages.v1',
		default_page_id: 'employees',
		pages: [live, edited, { ...newPage([], 'Trial page', now + 2000), id: 'trial' }]
	};
}

/** A deep copy that reads through the page's reactive state (a structured clone cannot). */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export type FakeAccountPagesCall = keyof AccountPagesClient;

export interface FakeAccountPagesOptions {
	/** What is stored (default: nothing, so the preset is shown). */
	document?: PagesDocument;
	screens?: Screen[];
	presetName?: string;
	delay?: number;
	failOn?: Partial<Record<FakeAccountPagesCall, 403 | 409 | 500>>;
}

const SCREENS: ReadonlyArray<[string, string, string[]]> = [
	['account_overview', 'Overview', ['heading', 'account_upgrade_widget']],
	['account_launchers', 'Applications', ['account_launcher_widget']],
	['account_profile', 'Profile', ['account_profile_widget']],
	['account_devices', 'Devices', ['account_device_list_widget']],
	['account_sessions', 'Sessions', ['account_session_widget']],
	['account_passkeys', 'Passkeys', ['account_passkey_widget']],
	['account_totp', 'Authenticator app', ['account_totp_widget']],
	['account_consents', 'Consents', ['account_consent_widget']],
	['account_activity', 'Activity', ['account_activity_widget']],
	['account_social_accounts', 'Linked accounts', ['account_social_account_widget']],
	['account_custom', 'Custom', ['heading', 'text', 'link']]
];

export function sampleAccountScreens(): Screen[] {
	return SCREENS.map(([key, name, blocks], index) => ({
		id: `scr-${key}`,
		screen_key: key,
		display_name: name,
		description: null,
		screen_kind: 'account',
		fields: blocks.map((block, at) => ({
			id: `${key}-${at}`,
			block_type: block,
			label: block === 'heading' ? name : undefined
		})) as unknown as Screen['fields'],
		localizations: {},
		settings: {},
		is_active: true,
		is_system: false,
		version: 1,
		created_at: 1_760_000_000_000 + index,
		updated_at: 1_760_000_000_000 + index
	}));
}

export type FakeAccountPages = AccountPagesClient & {
	/** What is stored now (null before the first save). */
	stored(): PagesDocument | null;
};

export function fakeAccountPages(options: FakeAccountPagesOptions = {}): FakeAccountPages {
	let stored: PagesDocument | null = options.document ? copy(options.document) : null;
	let version = 1;
	const screens = options.screens ?? sampleAccountScreens();

	async function enter(call: FakeAccountPagesCall) {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		const status = options.failOn?.[call];
		if (status === 409) throw new ConflictError('Changed', {});
		if (status) throw new ApiError(status, status === 403 ? 'forbidden' : 'error', `${status}`);
	}

	return {
		stored: () => (stored ? copy(stored) : null),
		async load(): Promise<AccountPagesState> {
			await enter('load');
			const { document } = parsePagesDocument(
				{ pages: stored ? JSON.stringify(stored) : undefined, legacy: undefined },
				options.presetName ?? 'Authrim standard',
				1_760_000_000_000
			);
			return {
				document: copy(document),
				stored: stored !== null,
				version: String(version),
				screens: copy(screens)
			};
		},
		async save(document, atVersion) {
			await enter('save');
			if (atVersion !== String(version)) throw new ConflictError('Changed', {});
			stored = copy(document);
			version += 1;
			return String(version);
		}
	};
}
