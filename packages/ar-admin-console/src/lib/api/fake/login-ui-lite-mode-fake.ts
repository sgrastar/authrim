/**
 * In-memory lite Login UI switch for Storybook and tests. Answers as the Admin API does:
 * switching on is refused with the issues while the tenant is not ready, a switch under way
 * refuses another, and the mode is recorded in the settings when a settings fake is given.
 */
import type { SettingsClient } from '../settings';
import {
	LiteChangeInProgressError,
	LiteUnsupportedError,
	type LiteIssue,
	type LiteMode,
	type LiteModeClient,
	type LiteModeStatus
} from '../login-ui-lite-mode';

export interface FakeLiteModeOptions {
	mode?: LiteMode;
	/** Why the tenant cannot switch on; none means ready. */
	issues?: LiteIssue[];
	changeInProgress?: boolean;
	/** Milliseconds each call takes. */
	delay?: number;
	/** Where the mode is recorded (`login-ui.lite_mode`), when given. */
	settings?: { client: SettingsClient; tenantId: string };
}

export function createFakeLiteMode(options: FakeLiteModeOptions = {}): LiteModeClient {
	let mode: LiteMode = options.mode ?? 'off';
	let generation = 1;
	let updatedAt: string | null = mode === 'always' ? new Date().toISOString() : null;
	const issues = options.issues ?? [];
	const wait = () =>
		options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : null;

	const status = (): LiteModeStatus => ({
		mode,
		policy_revision: mode === 'always' ? `rev-${generation}` : null,
		generation,
		updated_at: updatedAt,
		human_verification_required: { login: false, signup: mode === 'always', reauth: false },
		change_in_progress: options.changeInProgress ?? false,
		recorded_mode: mode,
		readiness: { ready: issues.length === 0, issues: [...issues] }
	});

	return {
		async get() {
			await wait();
			return status();
		},
		async set(next) {
			await wait();
			if (options.changeInProgress) {
				throw new LiteChangeInProgressError('A switch is under way', {
					error: 'lite_mode_change_in_progress'
				});
			}
			if (next === 'always' && issues.length > 0) {
				throw new LiteUnsupportedError('The lite Login UI cannot serve this tenant yet', {
					error: 'lite_mode_unsupported',
					issues: [...issues]
				});
			}
			mode = next;
			generation += 1;
			updatedAt = new Date().toISOString();
			let recorded = true;
			if (options.settings) {
				const { client, tenantId } = options.settings;
				const target = { level: 'tenant', tenantId } as const;
				const current = await client.get(target, 'login-ui');
				await client
					.patch(target, 'login-ui', {
						ifMatch: current.version,
						set: { 'login-ui.lite_mode': mode }
					})
					.catch(() => (recorded = false));
			}
			return {
				mode,
				policy_revision: `rev-${generation}`,
				generation,
				updated_at: updatedAt,
				human_verification_required: { login: false, signup: mode === 'always', reauth: false },
				recorded
			};
		}
	};
}
