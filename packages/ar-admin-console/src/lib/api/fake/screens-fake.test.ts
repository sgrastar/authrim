import { describe, expect, it } from 'vitest';
import { ApiError } from '../api-error';
import type { Screen, ScreenInput } from '../screens';
import { createFakeScreens } from './screens-fake';

const screen = (patch: Partial<Screen>): Screen => ({
	id: 'screen_a',
	screen_key: 'survey',
	display_name: 'Survey',
	description: null,
	screen_kind: 'custom',
	fields: [{ field: 'title', label: 'Title', required: false, block_type: 'heading' }],
	localizations: {},
	settings: {},
	is_active: true,
	is_system: false,
	version: 1,
	created_at: 1,
	updated_at: 1,
	...patch
});

const input = (patch: Partial<ScreenInput> = {}): ScreenInput => ({
	display_name: 'Survey',
	description: null,
	screen_key: 'survey_copy',
	screen_kind: 'custom',
	fields: [{ field: 'title', label: 'Title', required: false, block_type: 'heading' }],
	localizations: {},
	settings: {},
	is_active: true,
	...patch
});

const failure = async (run: () => Promise<unknown>) => {
	try {
		await run();
	} catch (error) {
		return error as ApiError;
	}
	throw new Error('expected a failure');
};

describe('the fake screens', () => {
	it('counts where each screen is used', async () => {
		const client = createFakeScreens({
			screens: [screen({})],
			usages: {
				screen_a: [
					{
						kind: 'flow',
						flow_id: 'f',
						flow_name: 'F',
						node_id: null,
						node_title: null,
						stage: 'draft'
					},
					{ kind: 'account_page', page_id: null, page_name: 'Account' }
				]
			}
		});

		const { screens } = await client.list();
		expect(screens[0].usage).toEqual({ flows: 1, account_pages: 1 });
	});

	it('refuses a taken key, a stale version, a system screen and one in use', async () => {
		const client = createFakeScreens({
			screens: [screen({}), screen({ id: 'screen_sys', screen_key: 'login', is_system: true })],
			usages: {
				screen_a: [{ kind: 'account_page', page_id: null, page_name: 'Account' }]
			}
		});

		expect((await failure(() => client.create(input({ screen_key: 'survey' })))).body.error).toBe(
			'screen_key_taken'
		);
		expect((await failure(() => client.update('screen_a', 7, input()))).body.current_version).toBe(
			1
		);
		expect((await failure(() => client.update('screen_sys', 1, input()))).status).toBe(400);
		expect((await failure(() => client.remove('screen_a', 1))).body.error).toBe('screen_in_use');
	});

	it('raises the version on a save and deletes a screen not in use', async () => {
		const client = createFakeScreens({ screens: [screen({})], now: () => 42 });

		const saved = await client.update('screen_a', 1, input({ display_name: 'Renamed' }));
		expect(saved).toMatchObject({ version: 2, display_name: 'Renamed', updated_at: 42 });
		await client.remove('screen_a', 2);
		expect((await client.list()).screens).toEqual([]);
	});

	it('pages the response records newest first', async () => {
		const record = (id: string, at: number) => ({
			id,
			user_id: 'u',
			screen_key: 'survey',
			flow_id: null,
			flow_version_id: null,
			interaction_id: null,
			step_id: null,
			answers: { plan: 'pro' },
			created_at: at,
			updated_at: at
		});
		const client = createFakeScreens({
			screens: [screen({})],
			responses: { screen_a: [record('r1', 1), record('r3', 3), record('r2', 2)] }
		});

		const first = await client.responses('screen_a', { limit: 2 });
		expect(first.responses.map((row) => row.id)).toEqual(['r3', 'r2']);
		const second = await client.responses('screen_a', { limit: 2, cursor: first.next_cursor });
		expect(second).toMatchObject({ next_cursor: null });
		expect(second.responses.map((row) => row.id)).toEqual(['r1']);
	});
});
