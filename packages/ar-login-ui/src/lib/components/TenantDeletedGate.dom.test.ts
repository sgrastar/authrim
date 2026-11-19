// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TenantDeletedGate from './TenantDeletedGate.svelte';

const HOST = window.location.hostname;
const GONE = /no longer available/i;
const children = createRawSnippet(() => ({ render: () => '<p>ordinary page</p>' }));

/** Answers the tenant status with each body in turn (the last one repeats); an Error rejects. */
function tenantStatus(...bodies: unknown[]) {
	let call = 0;
	const fetcher = vi.fn(async () => {
		const body = bodies[Math.min(call++, bodies.length - 1)];
		if (body instanceof Error) throw body;
		return { ok: true, json: async () => body } as Response;
	});
	vi.stubGlobal('fetch', fetcher);
	return fetcher;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('TenantDeletedGate', () => {
	it('shows the page and asks nothing while the tenant loads', async () => {
		const fetcher = tenantStatus({ status: 'deleted', host: HOST });
		const view = render(TenantDeletedGate, { props: { failures: 0, children } });

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(view.getByText('ordinary page')).toBeTruthy();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('asks once per failure, and again after a later failure', async () => {
		const fetcher = tenantStatus(
			new Error('offline'),
			{ status: 'unavailable' },
			{
				status: 'deleted',
				host: HOST
			}
		);
		const view = render(TenantDeletedGate, { props: { failures: 1, children } });

		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(view.getByText('ordinary page')).toBeTruthy();

		await view.rerender({ failures: 2 });
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		expect(view.getByText('ordinary page')).toBeTruthy();

		await view.rerender({ failures: 3 });
		await waitFor(() => expect(view.getByText(GONE)).toBeTruthy());
		expect(view.queryByText('ordinary page')).toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it('asks about a failure that arrived while an earlier one was being asked about', async () => {
		const answers: Array<(body: unknown) => void> = [];
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					answers.push((body) => resolve({ ok: true, json: async () => body } as Response));
				})
		);
		vi.stubGlobal('fetch', fetcher);
		const view = render(TenantDeletedGate, { props: { failures: 1, children } });
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

		await view.rerender({ failures: 2 });
		expect(fetcher).toHaveBeenCalledTimes(1);
		answers[0]({ status: 'unavailable' });

		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		answers[1]({ status: 'deleted', host: HOST });
		await waitFor(() => expect(view.getByText(GONE)).toBeTruthy());
	});

	it('reports nothing when the page was left before the answer came', async () => {
		const signal = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(window, 'PublicKeyCredential', {
			value: { signalAllAcceptedCredentials: signal, signalUnknownCredential: vi.fn() },
			configurable: true,
			writable: true
		});
		window.localStorage.setItem('authrim:passkey-user-handles', JSON.stringify(['dXNlci0x']));
		let answerNow: (body: unknown) => void = () => {};
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						answerNow = (body) => resolve({ ok: true, json: async () => body } as Response);
					})
			)
		);
		const view = render(TenantDeletedGate, { props: { failures: 1, children } });
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

		view.unmount();
		answerNow({ status: 'deleted', host: HOST });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(signal).not.toHaveBeenCalled();
		window.localStorage.clear();
		Object.defineProperty(window, 'PublicKeyCredential', {
			value: undefined,
			configurable: true,
			writable: true
		});
	});

	it('stops asking once the tenant is known to be deleted', async () => {
		const fetcher = tenantStatus({ status: 'deleted', host: HOST });
		const view = render(TenantDeletedGate, { props: { failures: 1, children } });

		await waitFor(() => expect(view.getByText(GONE)).toBeTruthy());
		await view.rerender({ failures: 2 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
