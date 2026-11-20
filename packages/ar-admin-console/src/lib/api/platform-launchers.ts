/**
 * The platform's application launchers (`/api/admin/platform/launchers`), which it shares with
 * every tenant or with the tenants chosen. Read and written with the launchers' client shape
 * (launchers.ts), so the same list and editor serve both; each launcher's sharing is in
 * `sharing`. A change and a delete are made from the version of the launcher the page shows (sent
 * with them): a change made meanwhile answers a conflict.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { ConflictError } from './api-error';
import { launcherFromRow, launchersOf, responseBody, type LaunchersClient } from './launchers';

const BASE = `${API_BASE_URL}/api/admin/platform/launchers`;
const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const send = (method: string, body: unknown) => ({
	method,
	includeJsonContentType: true,
	body: JSON.stringify(body)
});

/** The version a change or delete is made from: it comes with the launcher the page shows. */
function versionOf(version: number | undefined): number {
	if (version === undefined) throw new ConflictError('Reload the launcher first', {});
	return version;
}

export function httpPlatformLaunchers(): LaunchersClient {
	return {
		scope: 'platform',
		async list(signal) {
			return launchersOf(await responseBody(await adminFetch(BASE, { signal })));
		},
		async get(id, signal) {
			const body = await responseBody(await adminFetch(path(id), { signal }));
			return launcherFromRow(body.launcher);
		},
		async options(signal) {
			const body = await responseBody(await adminFetch(`${BASE}/options`, { signal }));
			return {
				oidc_clients: [],
				groups: [],
				attribute_keys: [],
				phosphor_icons: Array.isArray(body.phosphor_icons)
					? body.phosphor_icons.filter((icon): icon is string => typeof icon === 'string')
					: []
			};
		},
		async create(input) {
			const body = await responseBody(await adminFetch(BASE, send('POST', input)));
			return launcherFromRow(body.launcher);
		},
		async update(id, input) {
			const body = await responseBody(
				await adminFetch(path(id), send('PUT', { ...input, version: versionOf(input.version) }))
			);
			return launcherFromRow(body.launcher);
		},
		async reorder(ids) {
			return launchersOf(
				await responseBody(await adminFetch(`${BASE}/order`, send('PUT', { launcher_ids: ids })))
			);
		},
		async remove(id, version) {
			const query = new URLSearchParams({ version: String(versionOf(version)) });
			await responseBody(await adminFetch(`${path(id)}?${query}`, { method: 'DELETE' }));
		},
		async revert() {
			throw new Error('A platform launcher has no tenant copy to revert');
		},
		async uploadBackground(file) {
			const form = new FormData();
			form.set('file', file);
			const body = await responseBody(
				await adminFetch(`${BASE}/assets`, { method: 'POST', body: form })
			);
			if (typeof body.url !== 'string' || !body.url) throw new Error('The upload answered no URL');
			return body.url;
		},
		// A platform launcher is shown to everyone: there are no users to pick.
		async searchUsers() {
			return [];
		},
		async usersById() {
			return [];
		}
	};
}
