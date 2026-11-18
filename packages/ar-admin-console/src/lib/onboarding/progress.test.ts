import { afterEach, describe, expect, it } from 'vitest';
import { createFakeOnboarding } from '#lib/api/fake/onboarding-fake.js';
import { completedFromBody, httpOnboarding, type OnboardingClient } from '#lib/api/onboarding.js';
import { onboardingProgress } from './progress.svelte';

afterEach(() => onboardingProgress.use(httpOnboarding));

describe('completedFromBody', () => {
	it('reads the finished item ids and drops anything else', () => {
		expect(
			completedFromBody({
				completed: [{ item_id: 'theme', completed_at: 1 }, { item_id: 7 }, null, 'x']
			})
		).toEqual(['theme']);
		expect(completedFromBody(null)).toEqual([]);
		expect(completedFromBody({ completed: 'theme' })).toEqual([]);
	});
});

describe('onboardingProgress', () => {
	it('reads the progress, then marks and reopens items', async () => {
		onboardingProgress.use(createFakeOnboarding(['sign-in']));
		expect(onboardingProgress.phase).toBe('idle');
		await onboardingProgress.load();
		expect(onboardingProgress.phase).toBe('ready');
		expect(onboardingProgress.has('sign-in')).toBe(true);

		expect(await onboardingProgress.complete('theme')).toBe(true);
		expect([...onboardingProgress.completed].sort()).toEqual(['sign-in', 'theme']);
		expect(await onboardingProgress.reopen('sign-in')).toBe(true);
		expect([...onboardingProgress.completed]).toEqual(['theme']);
	});

	it('says so when the progress cannot be read', async () => {
		onboardingProgress.use(createFakeOnboarding([], { fail: true }));
		await onboardingProgress.load();
		expect(onboardingProgress.phase).toBe('failed');
	});

	it('takes a change back when the server refuses it', async () => {
		const client = createFakeOnboarding(['theme']);
		const refusing: OnboardingClient = {
			...client,
			complete: () => Promise.reject(new Error('refused')),
			reopen: () => Promise.reject(new Error('refused'))
		};
		onboardingProgress.use(refusing);
		await onboardingProgress.load();
		expect(await onboardingProgress.complete('schema')).toBe(false);
		expect(await onboardingProgress.reopen('theme')).toBe(false);
		expect([...onboardingProgress.completed]).toEqual(['theme']);
	});

	it('drops an answer that arrives after the tenant changed', async () => {
		let answer: (ids: string[]) => void = () => {};
		const slow: OnboardingClient = {
			list: () => new Promise((resolve) => (answer = resolve)),
			complete: async () => [],
			reopen: async () => []
		};
		onboardingProgress.use(slow);
		const first = onboardingProgress.load();
		onboardingProgress.reset();
		answer(['theme']);
		await first;
		expect(onboardingProgress.phase).toBe('idle');
		expect(onboardingProgress.has('theme')).toBe(false);
	});

	it('keeps a later change when an earlier answer arrives', async () => {
		const sent: string[] = [];
		let releaseFirst: () => void = () => {};
		const kept = new Set<string>();
		const ordered: OnboardingClient = {
			list: async () => [],
			complete: async (id) => {
				sent.push(id);
				if (id === 'theme') await new Promise<void>((resolve) => (releaseFirst = resolve));
				kept.add(id);
				return [...kept];
			},
			reopen: async () => [...kept]
		};
		onboardingProgress.use(ordered);
		await onboardingProgress.load();
		const first = onboardingProgress.complete('theme');
		const second = onboardingProgress.complete('schema');
		// Both show at once; the second is sent only after the first was answered.
		expect([...onboardingProgress.completed]).toEqual(['theme', 'schema']);
		await Promise.resolve();
		expect(sent).toEqual(['theme']);
		releaseFirst();
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect([...onboardingProgress.completed].sort()).toEqual(['schema', 'theme']);
	});

	it('takes back only the change that failed', async () => {
		const client = createFakeOnboarding([]);
		const partly: OnboardingClient = {
			...client,
			complete: (id) =>
				id === 'theme' ? Promise.reject(new Error('refused')) : client.complete(id)
		};
		onboardingProgress.use(partly);
		await onboardingProgress.load();
		const first = onboardingProgress.complete('theme');
		const second = onboardingProgress.complete('schema');
		expect(await first).toBe(false);
		expect(await second).toBe(true);
		expect([...onboardingProgress.completed]).toEqual(['schema']);
	});

	it('ends as the server has it when quick changes both fail', async () => {
		const refusing: OnboardingClient = {
			list: async () => [],
			complete: () => Promise.reject(new Error('refused')),
			reopen: () => Promise.reject(new Error('refused'))
		};
		onboardingProgress.use(refusing);
		await onboardingProgress.load();
		const on = onboardingProgress.complete('theme');
		const off = onboardingProgress.reopen('theme');
		expect(await on).toBe(false);
		expect(await off).toBe(false);
		expect(onboardingProgress.has('theme')).toBe(false);
	});

	it('keeps a finished item checked when finishing it again fails', async () => {
		const refusing: OnboardingClient = {
			list: async () => ['theme'],
			complete: () => Promise.reject(new Error('refused')),
			reopen: async () => []
		};
		onboardingProgress.use(refusing);
		await onboardingProgress.load();
		expect(await onboardingProgress.complete('theme')).toBe(false);
		expect(onboardingProgress.has('theme')).toBe(true);
	});

	it('reads again without losing changes under way', async () => {
		const client = createFakeOnboarding([]);
		onboardingProgress.use(client);
		await onboardingProgress.load();
		const first = onboardingProgress.complete('theme');
		const second = onboardingProgress.complete('schema');
		const reread = onboardingProgress.load();
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		await reread;
		expect(onboardingProgress.phase).toBe('ready');
		expect([...onboardingProgress.completed].sort()).toEqual(['schema', 'theme']);
		expect((await client.list()).sort()).toEqual(['schema', 'theme']);
	});

	it('sends each change to the tenant it was made in, and drops what waits when the tenant changes', async () => {
		const calls: Array<[string, string | undefined]> = [];
		let releaseFirst: () => void = () => {};
		const recording: OnboardingClient = {
			list: async () => [],
			complete: async (id, tenantId) => {
				calls.push([id, tenantId]);
				if (id === 'theme') await new Promise<void>((resolve) => (releaseFirst = resolve));
				return [id];
			},
			reopen: async () => []
		};
		let selected = 'tenant-a';
		onboardingProgress.use(recording, () => selected);
		const first = onboardingProgress.complete('theme');
		const second = onboardingProgress.complete('schema');
		await Promise.resolve();
		selected = 'tenant-b';
		const third = onboardingProgress.complete('screens');
		releaseFirst();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
		expect(await third).toBe(true);
		// The change that waited for tenant A was never sent to tenant B.
		expect(calls).toEqual([
			['theme', 'tenant-a'],
			['screens', 'tenant-b']
		]);
		expect([...onboardingProgress.completed]).toEqual(['screens']);
	});

	it('answers a request already sent before a later one for the tenant the person came back to', async () => {
		const calls: string[] = [];
		let releaseFirst: () => void = () => {};
		const kept = new Set<string>();
		const slow: OnboardingClient = {
			list: async () => [...kept],
			complete: async (id, tenantId) => {
				calls.push(`complete ${tenantId}`);
				await new Promise<void>((resolve) => (releaseFirst = resolve));
				kept.add(id);
				return [...kept];
			},
			reopen: async (id, tenantId) => {
				calls.push(`reopen ${tenantId}`);
				kept.delete(id);
				return [...kept];
			}
		};
		let selected = 'tenant-a';
		onboardingProgress.use(slow, () => selected);
		const first = onboardingProgress.complete('theme');
		await Promise.resolve();
		selected = 'tenant-b';
		void onboardingProgress.load();
		selected = 'tenant-a';
		const later = onboardingProgress.reopen('theme');
		await Promise.resolve();
		// The later change waits for the one already sent.
		expect(calls).toEqual(['complete tenant-a']);
		releaseFirst();
		await first;
		expect(await later).toBe(true);
		expect(calls).toEqual(['complete tenant-a', 'reopen tenant-a']);
		expect([...kept]).toEqual([]);
		expect(onboardingProgress.has('theme')).toBe(false);
	});
});
