import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { createFakeOnboarding } from '#lib/api/fake/onboarding-fake.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
import OnboardingChecklist from './OnboardingChecklist.svelte';
import { onboardingProgress } from './progress.svelte';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => import('./tenant-scope.test-double.svelte'));

const noop = () => {};

const selectTenant = (id: string) => {
	(tenantScope as unknown as { select(id: string): void }).select(id);
};

/** A probe that answers when the test says so. */
function slowProbe() {
	let answer: (satisfied: boolean) => void = () => {};
	const probe = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
	return { probe, answer: (satisfied: boolean) => answer(satisfied) };
}

async function show(
	probes: Record<string, () => Promise<boolean>>,
	completed: readonly string[] = []
) {
	onboardingProgress.use(createFakeOnboarding(completed), () => tenantScope.tenantId);
	await onboardingProgress.load();
	return render(OnboardingChecklist, { props: { probes, onstart: noop, onstop: noop } });
}

beforeEach(() => {
	selectTenant('tenant-a');
	vi.stubGlobal(
		'matchMedia',
		vi.fn((media: string) => ({
			matches: false,
			media,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(() => true)
		}))
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('an item the admin has already done', () => {
	it('is checked for them, and kept', async () => {
		const probe = vi.fn(async () => true);
		await show({ 'second-factor': probe });

		await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(true));
		expect(probe).toHaveBeenCalledTimes(1);
		// Kept like any finished item: what the server answers holds it.
		await onboardingProgress.load();
		expect(onboardingProgress.has('second-factor')).toBe(true);
	});

	it.each([
		['is not in place', async () => false],
		[
			'cannot be read',
			async () => {
				throw new Error('offline');
			}
		]
	])('is left alone when what it needs %s', async (_name, probe) => {
		const asked = vi.fn(probe);
		await show({ 'second-factor': asked });

		await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onboardingProgress.has('second-factor')).toBe(false);
	});

	it('is not asked about when it is checked already, nor for the items without a probe', async () => {
		const probe = vi.fn(async () => true);
		await show({ 'second-factor': probe, 'no-such-item': probe }, ['second-factor']);

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(probe).not.toHaveBeenCalled();
		expect(onboardingProgress.has('sign-in')).toBe(false);
	});

	it('is not checked again once the admin unchecked it, in the same visit', async () => {
		const probe = vi.fn(async () => true);
		const view = await show({ 'second-factor': probe });
		await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(true));

		await fireEvent.click(
			view.getByRole('button', {
				name: t('ob.markTodoNamed', { name: t('ob.secondFactor.title') })
			})
		);

		await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(false));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onboardingProgress.has('second-factor')).toBe(false);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('is not asked about again when it was checked at the start and the admin unchecks it', async () => {
		const probe = vi.fn(async () => true);
		const view = await show({ 'second-factor': probe }, ['second-factor']);

		await fireEvent.click(
			view.getByRole('button', {
				name: t('ob.markTodoNamed', { name: t('ob.secondFactor.title') })
			})
		);

		await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(false));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(probe).not.toHaveBeenCalled();
		expect(onboardingProgress.has('second-factor')).toBe(false);
	});

	describe('whose answer comes late', () => {
		it('is dropped when the admin changed an item meanwhile', async () => {
			const { probe, answer } = slowProbe();
			const view = await show({ 'second-factor': probe });
			await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

			// Checked by hand, then unchecked again, before the probe answered.
			const secondFactor = { name: t('ob.secondFactor.title') };
			await fireEvent.click(
				view.getByRole('button', { name: t('ob.markDoneNamed', secondFactor) })
			);
			await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(true));
			await fireEvent.click(
				view.getByRole('button', { name: t('ob.markTodoNamed', secondFactor) })
			);
			await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(false));

			answer(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(onboardingProgress.has('second-factor')).toBe(false);
		});

		it('is dropped when another tenant is selected', async () => {
			const { probe, answer } = slowProbe();
			await show({ 'second-factor': probe });
			await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

			selectTenant('tenant-b');
			answer(true);

			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(onboardingProgress.has('second-factor')).toBe(false);
		});

		it('is dropped when the page is gone', async () => {
			const { probe, answer } = slowProbe();
			const view = await show({ 'second-factor': probe });
			await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

			view.unmount();
			answer(true);

			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(onboardingProgress.has('second-factor')).toBe(false);
		});

		it('still checks the item when nothing changed meanwhile', async () => {
			const { probe, answer } = slowProbe();
			await show({ 'second-factor': probe });
			await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

			answer(true);

			await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(true));
		});
	});

	it('asks about the tenant that was switched to, once its own progress has been read', async () => {
		// Tenant A has it checked; B does not. While B's progress is still being read, what is held
		// is A's: B must not be marked as dealt with on that.
		const probe = vi.fn(async () => true);
		await show({ 'second-factor': probe }, ['second-factor']);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(probe).not.toHaveBeenCalled();

		selectTenant('tenant-b');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(probe).not.toHaveBeenCalled();

		onboardingProgress.use(createFakeOnboarding([]), () => tenantScope.tenantId);
		await onboardingProgress.load();

		await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(onboardingProgress.has('second-factor')).toBe(true));
	});
});
