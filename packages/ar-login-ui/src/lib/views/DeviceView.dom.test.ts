// @vitest-environment jsdom
import { get } from 'svelte/store';
import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LL, setLocale } from '$i18n/i18n-svelte';
import {
	applyUserCodeInput,
	createDeviceFlow,
	type DeviceDecisionApi,
	type DeviceFlowState
} from '../../routes/device/device-decision';
import { handleCodeEnterKey } from '$lib/utils/code-enter-key';
import DeviceView from './DeviceView.svelte';

// The real DeviceView in a DOM, wired to the real device flow the way the route wires it, with
// real typing: codes of the lengths a tenant can issue (4 to 16 characters), grouped by 4.

function mount(api: Partial<DeviceDecisionApi> = {}) {
	const client: DeviceDecisionApi = {
		lookup: vi.fn().mockResolvedValue({
			data: { client_id: 'c', client_name: 'Acme TV', scopes: ['openid'], expires_at: 1 }
		}),
		approve: vi.fn().mockResolvedValue({ data: { success: true } }),
		deny: vi.fn().mockResolvedValue({ data: { success: true } }),
		...api
	};
	let view!: DeviceFlowState;
	const host: { rerender?: (props: Record<string, unknown>) => Promise<void> } = {};
	const flow = createDeviceFlow({
		api: client,
		translations: () => get(LL),
		onChange: (next) => {
			view = next;
			void host.rerender?.({
				step: next.step,
				userCode: next.userCode,
				error: next.error,
				success: next.success,
				verifying: next.verifying,
				loading: next.loading,
				deviceInfo: next.deviceInfo
			});
		},
		onDenied: vi.fn()
	});
	view = flow.state;
	const result = render(DeviceView, {
		props: {
			step: view.step,
			userCode: view.userCode,
			onCodeInput: (event: Event) => applyUserCodeInput(event, flow),
			onCompositionStart: () => flow.interrupt(),
			onKeyDown: (event: KeyboardEvent) => handleCodeEnterKey(event, () => void flow.verify()),
			onVerify: () => void flow.verify(),
			onApprove: () => void flow.decide('approve'),
			onDeny: () => void flow.decide('deny'),
			onDismissError: () => flow.dismissError()
		}
	});
	host.rerender = result.rerender as unknown as NonNullable<typeof host.rerender>;
	const input = () => result.container.querySelector('#user-code') as HTMLInputElement;
	const button = () =>
		result.getByRole('button', { name: get(LL).device_verifyButton() }) as HTMLButtonElement;
	return { ...result, client, flow, input, button, state: () => view };
}

describe('the device code input (real DOM)', () => {
	beforeEach(() => {
		setLocale('en');
	});

	it('takes no fixed length: no 8-character limit and no XXXX-XXXX pattern in the page', () => {
		const { input } = mount();

		expect(input().maxLength).toBeGreaterThanOrEqual(19 + 4);
		expect(input().getAttribute('pattern')).toBeNull();
		expect(document.body.textContent).not.toMatch(/8[- ]?(character|文字)/i);
	});

	it.each([
		['wdjbmjht', 'WDJB-MJHT'],
		['abcd', 'ABCD'],
		['abcde', 'ABCD-E'],
		['abcdefghjkm', 'ABCD-EFGH-JKM'],
		['123456789012', '1234-5678-9012'],
		['abcdefghjkmnpqrs', 'ABCD-EFGH-JKMN-PQRS']
	])('groups what is typed: %s -> %s', async (typed, shown) => {
		const user = userEvent.setup();
		const { input } = mount();

		await user.click(input());
		await user.keyboard(typed);

		expect(input().value).toBe(shown);
	});

	it('takes a pasted code with spaces, hyphens and lower case', async () => {
		const user = userEvent.setup();
		const { input } = mount();

		await user.click(input());
		await user.paste(' wdjb  - mjht ');

		expect(input().value).toBe('WDJB-MJHT');
	});

	it('stops growing at 16 characters', async () => {
		const user = userEvent.setup();
		const { input } = mount();

		await user.click(input());
		await user.keyboard('abcdefghjkmnpqrstuvwxyz');

		expect(input().value).toBe('ABCD-EFGH-JKMN-PQRS');
	});

	it('keeps Look up disabled below 4 characters and enables it from 4 to 16', async () => {
		const user = userEvent.setup();
		const { input, button } = mount();

		await user.click(input());
		await user.keyboard('abc');
		expect(button().disabled).toBe(true);
		await user.keyboard('d');
		expect(button().disabled).toBe(false);
		await user.keyboard('efghjkmnpqrs');
		expect(input().value).toBe('ABCD-EFGH-JKMN-PQRS');
		expect(button().disabled).toBe(false);
	});

	it.each([
		['abcd', 'ABCD'],
		['1234-5678-901', '12345678901'],
		['abcdefghjkmnpqrs', 'ABCDEFGHJKMNPQRS']
	])('looks %s up as %s when Enter is pressed', async (typed, sent) => {
		const user = userEvent.setup();
		const { input, client } = mount();

		await user.click(input());
		await user.keyboard(typed);
		await user.keyboard('{Enter}');

		expect(client.lookup).toHaveBeenCalledExactlyOnceWith(sent);
	});

	it('does not look a code up with Enter below 4 characters', async () => {
		const user = userEvent.setup();
		const { input, client, state } = mount();

		await user.click(input());
		await user.keyboard('abc{Enter}');

		expect(client.lookup).not.toHaveBeenCalled();
		expect(state().error).toBe(get(LL).device_errorInvalidCode());
	});

	describe('with an IME', () => {
		it('does not rewrite the text during a composition, and groups it when the composition ends', async () => {
			const { input, flow } = mount();
			const field = input();

			await fireEvent.compositionStart(field);
			field.value = 'ａｂｃｄｅ';
			await fireEvent.input(field, { isComposing: true });
			// still the browser's text: reformatting now would break the conversion
			expect(field.value).toBe('ａｂｃｄｅ');
			expect(flow.state.userCode).toBe('');

			await fireEvent.compositionEnd(field);
			expect(field.value).toBe('ABCD-E');
			expect(flow.state.userCode).toBe('ABCD-E');
		});

		it('does not look the code up with the Enter that confirms a conversion', async () => {
			const { input, client } = mount();
			const field = input();
			field.value = 'ABCD';
			await fireEvent.input(field);

			await fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
			await fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
			expect(client.lookup).not.toHaveBeenCalled();

			await fireEvent.keyDown(field, { key: 'Enter' });
			expect(client.lookup).toHaveBeenCalledExactlyOnceWith('ABCD');
		});

		it('ignores the answer for the old code when it is being replaced by an IME composition', async () => {
			let answer!: (value: unknown) => void;
			const lookup = vi
				.fn()
				.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
				.mockResolvedValue({
					data: { client_id: 'b', client_name: 'App B', scopes: ['openid'], expires_at: 1 }
				});
			const { input, client, flow, queryByText, state } = mount({ lookup });
			const field = input();
			const user = userEvent.setup();

			// code A is looked up and the answer is on its way
			await user.click(field);
			await user.keyboard('abcd{Enter}');
			expect(lookup).toHaveBeenCalledExactlyOnceWith('ABCD');
			expect(state().verifying).toBe(true);

			// the person selects all and starts to replace it with B through the IME
			await fireEvent.compositionStart(field);
			field.value = 'あ';
			await fireEvent.input(field, { isComposing: true });
			expect(state().verifying).toBe(false);
			expect(field.value).toBe('あ'); // the browser's text is not rewritten

			// A's answer arrives: it must not replace the screen
			answer({
				data: { client_id: 'a', client_name: 'App A', scopes: ['openid'], expires_at: 1 }
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(queryByText('App A')).toBeNull();
			expect(state().step).toBe('input');
			expect(state().deviceInfo).toBeNull();
			expect(field.isConnected).toBe(true);
			await flow.decide('approve');
			expect(client.approve).not.toHaveBeenCalled();

			// the composition ends with B: a new lookup for B proceeds and is the one decided
			field.value = 'ＥＦＧＨ';
			await fireEvent.compositionEnd(field);
			expect(field.value).toBe('EFGH');
			await user.keyboard('{Enter}');
			expect(lookup).toHaveBeenLastCalledWith('EFGH');
			await flow.decide('approve');
			expect(client.approve).toHaveBeenCalledExactlyOnceWith('EFGH');
		});

		it('ignores the answer for the old code as soon as the composition opens', async () => {
			let answer!: (value: unknown) => void;
			const lookup = vi
				.fn()
				.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
			const { input, state, queryByText } = mount({ lookup });
			const user = userEvent.setup();
			await user.click(input());
			await user.keyboard('abcd{Enter}');
			expect(state().verifying).toBe(true);

			// no input event yet: the opening of the composition alone invalidates the lookup
			await fireEvent.compositionStart(input());
			answer({ data: { client_id: 'a', client_name: 'App A', scopes: [], expires_at: 1 } });
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(queryByText('App A')).toBeNull();
			expect(state()).toMatchObject({ step: 'input', deviceInfo: null, verifying: false });
		});

		it('reads full-width letters and digits as the code', async () => {
			const { input, flow } = mount();
			const field = input();

			field.value = 'ＡＢＣＤ－１２３４－ＥＦＧ';
			await fireEvent.input(field);

			expect(field.value).toBe('ABCD-1234-EFG');
			expect(flow.state.userCode).toBe('ABCD-1234-EFG');
		});
	});

	it('shows the application after the lookup and approves exactly that code', async () => {
		const user = userEvent.setup();
		const { input, client, findByText, getByRole } = mount();

		await user.click(input());
		await user.keyboard('1234-5678-901{Enter}');
		await findByText('Acme TV');
		await user.click(getByRole('button', { name: get(LL).device_approveButton() }));

		expect(client.lookup).toHaveBeenCalledExactlyOnceWith('12345678901');
		expect(client.approve).toHaveBeenCalledExactlyOnceWith('12345678901');
	});
});
