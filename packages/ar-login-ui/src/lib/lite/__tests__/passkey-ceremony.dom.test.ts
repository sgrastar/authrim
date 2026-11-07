import { afterEach, describe, expect, it, vi } from 'vitest';
import { LITE_PASSKEY_SCRIPT } from '../passkey-ceremony';

const OPTIONS = {
	challenge: 'AQID',
	rpId: 'id.example',
	timeout: 60000,
	userVerification: 'required',
	allowCredentials: [{ id: 'BAU', transports: ['internal'] }]
};

function draw() {
	document.body.innerHTML = `
		<form method="post" data-lite-passkey='${JSON.stringify(OPTIONS)}'
			data-lite-passkey-unsupported="No passkeys" data-lite-passkey-error="Did not finish">
			<input type="hidden" name="credential" value="" />
			<button type="submit">Use passkey</button>
		</form>`;
	const form = document.querySelector('form') as HTMLFormElement;
	const sent = vi.fn();
	// jsdom has no navigation: record what submit sends instead.
	form.submit = () => sent((form.querySelector('input') as HTMLInputElement).value);
	new Function(LITE_PASSKEY_SCRIPT)();
	return { form, sent };
}

function press(form: HTMLFormElement) {
	const event = new SubmitEvent('submit', { cancelable: true });
	form.dispatchEvent(event);
	return event;
}

const buffer = (...bytes: number[]) => new Uint8Array(bytes).buffer;

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, 'credentials');
});

describe('the lite passkey ceremony', () => {
	it('signs the challenge on the press and sends the assertion as base64url JSON', async () => {
		const get = vi.fn(async () => ({
			id: 'cred',
			rawId: buffer(0xfb, 0xff),
			type: 'public-key',
			authenticatorAttachment: 'platform',
			response: {
				authenticatorData: buffer(1),
				clientDataJSON: buffer(2),
				signature: buffer(3),
				userHandle: buffer(4)
			}
		}));
		vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
		Object.defineProperty(navigator, 'credentials', { value: { get }, configurable: true });
		const { form, sent } = draw();
		expect(press(form).defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(sent).toHaveBeenCalled());
		const request = (get.mock.calls[0] as unknown as [{ publicKey: Record<string, unknown> }])[0]
			.publicKey;
		expect([...(request.challenge as Uint8Array)]).toEqual([1, 2, 3]);
		expect(request.rpId).toBe('id.example');
		const [allowed] = request.allowCredentials as Array<{ id: Uint8Array; transports: string[] }>;
		expect([...allowed.id]).toEqual([4, 5]);
		expect(allowed.transports).toEqual(['internal']);
		expect(JSON.parse(sent.mock.calls[0][0] as string)).toEqual({
			id: 'cred',
			rawId: '-_8',
			type: 'public-key',
			authenticatorAttachment: 'platform',
			response: { authenticatorData: 'AQ', clientDataJSON: 'Ag', signature: 'Aw', userHandle: 'BA' }
		});
	});

	it('says so in a browser without passkeys, and sends nothing', () => {
		const { form, sent } = draw();
		expect(press(form).defaultPrevented).toBe(true);
		expect(form.querySelector('[data-lite-passkey-message]')?.textContent).toBe('No passkeys');
		expect(sent).not.toHaveBeenCalled();
	});

	it('says so when the ceremony is cancelled, and can be pressed again', async () => {
		vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
		Object.defineProperty(navigator, 'credentials', {
			value: { get: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) },
			configurable: true
		});
		const { form, sent } = draw();
		press(form);
		await vi.waitFor(() =>
			expect(form.querySelector('[data-lite-passkey-message]')?.textContent).toBe('Did not finish')
		);
		expect((form.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
		expect(sent).not.toHaveBeenCalled();
	});
});
