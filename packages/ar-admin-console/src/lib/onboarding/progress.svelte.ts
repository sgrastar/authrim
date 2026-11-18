/**
 * Which first-steps items the signed-in admin has finished for the selected tenant. Read from
 * and written to the Admin API, so it is the same in every browser.
 *
 * Two things are kept apart: what the server last confirmed, and the changes not answered yet.
 * What is shown is the first with the second laid over it, so a change shows at once, a change
 * the server refuses disappears alone, and an answer never undoes a later change. Requests go
 * one after another, each to the tenant that was selected when it was made; when another tenant
 * is selected, what was read and what still waits belong to the old one and are dropped.
 */
import { ReleasePausedError } from '#lib/api/api-error.js';
import { httpOnboarding, type OnboardingClient } from '#lib/api/onboarding.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';

export type ProgressPhase = 'idle' | 'loading' | 'ready' | 'failed';

interface Change {
	itemId: string;
	done: boolean;
}

let client: OnboardingClient = httpOnboarding;
const selectedTenant = () => tenantScope.tenantId;
/** Which tenant is selected (tests name their own). */
let tenantOf: () => string | null = selectedTenant;
let confirmed = $state.raw<readonly string[]>([]);
let waiting = $state.raw<readonly Change[]>([]);
let phase = $state<ProgressPhase>('idle');
/** The tenant the state belongs to. */
let tenant: string | null = null;
/** Changes with the tenant (and the client): what an older one started is dropped. */
let generation = 0;
let queue: Promise<unknown> = Promise.resolve();
/** The last change answered was refused because the environment is being updated. */
let paused = $state(false);

const completed = $derived(
	waiting.reduce<readonly string[]>((ids, change) => {
		const others = ids.filter((id) => id !== change.itemId);
		return change.done ? [...others, change.itemId] : others;
	}, confirmed)
);

function forget(): void {
	generation += 1;
	confirmed = [];
	waiting = [];
	phase = 'idle';
	// The queue stays: a request already sent for a tenant must be answered before a later one
	// for the same tenant is sent (the person may come back to it).
}

/** Makes the state the selected tenant's, dropping another tenant's. */
function follow(): { mine: number; tenantId: string | undefined } {
	const selected = tenantOf();
	if (selected !== tenant) {
		tenant = selected;
		forget();
	}
	return { mine: generation, tenantId: selected ?? undefined };
}

/** Runs after everything asked before it, whether that worked or not. */
function inTurn<T>(run: () => Promise<T>): Promise<T> {
	const result = queue.then(run, run);
	queue = result.catch(() => undefined);
	return result;
}

function change(itemId: string, done: boolean): Promise<boolean> {
	const { mine, tenantId } = follow();
	const using = client;
	const asked: Change = { itemId, done };
	waiting = [...waiting, asked];
	return inTurn(async () => {
		if (mine !== generation) return false;
		let answer: string[] | null = null;
		try {
			answer = await (done ? using.complete(itemId, tenantId) : using.reopen(itemId, tenantId));
			paused = false;
		} catch (error) {
			answer = null;
			paused = error instanceof ReleasePausedError;
		}
		if (mine !== generation) return false;
		waiting = waiting.filter((entry) => entry !== asked);
		if (!answer) return false;
		confirmed = answer;
		if (phase !== 'loading') phase = 'ready';
		return true;
	});
}

export const onboardingProgress = {
	get phase(): ProgressPhase {
		return phase;
	},
	get completed(): readonly string[] {
		return completed;
	},
	/**
	 * Why the change just answered was not kept: true when the environment is being updated
	 * (it works a little later), false for any other reason.
	 */
	get pausedForRelease(): boolean {
		return paused;
	},
	has(itemId: string): boolean {
		return completed.includes(itemId);
	},
	/** Storybook and tests: an in-memory API instead of the Admin API. */
	use(next: OnboardingClient, tenantSource: () => string | null = selectedTenant): void {
		client = next;
		tenantOf = tenantSource;
		this.reset();
	},
	/** Forgets what was read and what still waits. */
	reset(): void {
		tenant = tenantOf();
		forget();
	},
	/** Reads the progress of the selected tenant, after the changes already under way. */
	load(): Promise<void> {
		const { mine, tenantId } = follow();
		const using = client;
		phase = 'loading';
		return inTurn(async () => {
			if (mine !== generation) return;
			try {
				const answer = await using.list(tenantId);
				if (mine !== generation) return;
				confirmed = answer;
				phase = 'ready';
			} catch {
				if (mine === generation) phase = 'failed';
			}
		});
	},
	/** Marks an item finished. False when the server could not keep it. */
	complete: (itemId: string) => change(itemId, true),
	/** Marks an item not finished. */
	reopen: (itemId: string) => change(itemId, false)
};

/** What to tell the admin when a change to the progress was not kept. */
export function saveFailedKey(): MessageKey {
	return paused ? 'common.releasePaused' : 'ob.saveFailed';
}
