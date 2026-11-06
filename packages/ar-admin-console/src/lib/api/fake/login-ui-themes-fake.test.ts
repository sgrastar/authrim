import { describe, expect, it } from 'vitest';
import { ApiError } from '../api-error';
import { createFakeLoginUiThemes } from './login-ui-themes-fake';

const values = { 'login-ui.template': 'split', 'login-ui.palette': 'glass' };

describe('createFakeLoginUiThemes', () => {
	it('starts empty, creates, lists by update and applies', async () => {
		const client = createFakeLoginUiThemes();
		expect(await client.list()).toEqual({ themes: [], active: null });
		const first = await client.create({ name: ' First ', values });
		expect(first).toMatchObject({ name: 'First', version: 1 });
		const second = await client.create({ name: 'Second', values: {} });
		await client.update(first.id, 1, { name: 'First', values });
		const { themes } = await client.list();
		expect(themes.map((theme) => theme.id)).toEqual([first.id, second.id]);
		expect(themes[0]).toMatchObject({ template: 'split', palette: 'glass', version: 2 });
		expect(await client.apply(first.id)).toEqual({ theme_id: first.id, version: 2 });
		expect((await client.get(first.id)).active).toBe(true);
	});

	it('answers as the API does', async () => {
		const client = createFakeLoginUiThemes({ limit: 2 });
		const theme = await client.create({ name: 'One', values });
		const refusal = (promise: Promise<unknown>) =>
			promise.then(
				() => null,
				(error: unknown) => (error instanceof ApiError ? error.code : String(error))
			);
		expect(await refusal(client.create({ name: 'one', values }))).toBe('theme_name_taken');
		expect(await refusal(client.create({ name: ' ', values }))).toBe('invalid_request');
		await client.create({ name: 'Two', values });
		expect(await refusal(client.create({ name: 'Three', values }))).toBe('theme_limit_reached');
		expect(await refusal(client.update(theme.id, 9, { name: 'One', values }))).toBe(
			'ADMIN_CONFLICT'
		);
		expect(await refusal(client.apply(theme.id, 9))).toBe('ADMIN_CONFLICT');
		await client.apply(theme.id);
		expect(await refusal(client.remove(theme.id))).toBe('theme_active');
		expect(await refusal(client.get('missing'))).toBe('not_found');
	});
});
