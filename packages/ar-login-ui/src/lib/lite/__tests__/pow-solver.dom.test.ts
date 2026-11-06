import { describe, expect, it, vi } from 'vitest';
import { LITE_POW_SOLVER_SCRIPT } from '../pow-solver';

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('the lite proof-of-work solver', () => {
	it('fills the proof before the form is sent, keeping the button pressed', async () => {
		const salt = 'abc?expires=1&';
		const challenge = await sha256Hex(`${salt}42`);
		document.body.innerHTML = `
			<form method="post" data-lite-pow='${JSON.stringify({
				algorithm: 'SHA-256',
				challenge,
				maxnumber: 100,
				salt,
				signature: 'sig'
			})}'>
				<input type="hidden" name="human_verification_response" value="" />
				<button type="submit" name="intent" value="send">Send</button>
			</form>`;
		const form = document.querySelector('form') as HTMLFormElement;
		const sent = vi.fn();
		// jsdom has no navigation: record what requestSubmit sends instead.
		form.requestSubmit = (submitter?: HTMLElement | null) => {
			sent((submitter as HTMLButtonElement | null)?.value ?? null);
		};
		new Function(LITE_POW_SOLVER_SCRIPT)();
		const button = form.querySelector('button') as HTMLButtonElement;
		const event = new SubmitEvent('submit', { cancelable: true, submitter: button });
		form.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(button.disabled).toBe(true);
		await vi.waitFor(() => expect(sent).toHaveBeenCalledWith('send'));
		const proof = JSON.parse(
			atob((form.querySelector('input') as HTMLInputElement).value)
		) as Record<string, unknown>;
		expect(proof).toEqual({ algorithm: 'SHA-256', challenge, number: 42, salt, signature: 'sig' });
		expect(Object.keys(proof)).toEqual(['algorithm', 'challenge', 'number', 'salt', 'signature']);
		expect(button.disabled).toBe(false);
	});

	it('lets a form with its proof already filled in go as it is', () => {
		document.body.innerHTML = `
			<form data-lite-pow='{}'><input type="hidden" name="human_verification_response" value="x" /></form>`;
		new Function(LITE_POW_SOLVER_SCRIPT)();
		const event = new SubmitEvent('submit', { cancelable: true });
		document.querySelector('form')?.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('keeps the button pressed in a browser without requestSubmit', async () => {
		const salt = 's';
		const challenge = await sha256Hex(`${salt}3`);
		document.body.innerHTML = `
			<form method="post" action="?/send_code" data-lite-pow='${JSON.stringify({
				algorithm: 'SHA-256',
				challenge,
				maxnumber: 10,
				salt,
				signature: 'g'
			})}'>
				<input type="hidden" name="human_verification_response" value="" />
				<button type="submit" name="intent" value="guest" formaction="?/guest">Guest</button>
			</form>`;
		const form = document.querySelector('form') as HTMLFormElement;
		(form as unknown as { requestSubmit: undefined }).requestSubmit = undefined;
		const submitted = vi.fn();
		form.submit = () => submitted(form.getAttribute('action'), new FormData(form).get('intent'));
		new Function(LITE_POW_SOLVER_SCRIPT)();
		const button = form.querySelector('button') as HTMLButtonElement;
		form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, submitter: button }));
		await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith('?/guest', 'guest'));
	});

	it('gives the buttons back and says why when the browser cannot solve it', async () => {
		for (const breakIt of [
			() => {
				const saved = globalThis.TextEncoder;
				(globalThis as { TextEncoder?: unknown }).TextEncoder = undefined;
				return () => {
					globalThis.TextEncoder = saved;
				};
			},
			() => {
				const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('no crypto'));
				return () => spy.mockRestore();
			}
		]) {
			document.body.innerHTML = `
				<form method="post" data-lite-pow-error="Turn on JavaScript" data-lite-pow='${JSON.stringify({
					algorithm: 'SHA-256',
					challenge: 'a'.repeat(64),
					maxnumber: 5,
					salt: 's',
					signature: 'g'
				})}'>
					<input type="hidden" name="human_verification_response" value="" />
					<button type="submit">Send</button>
				</form>`;
			const restore = breakIt();
			try {
				new Function(LITE_POW_SOLVER_SCRIPT)();
				const form = document.querySelector('form') as HTMLFormElement;
				const button = form.querySelector('button') as HTMLButtonElement;
				form.dispatchEvent(new SubmitEvent('submit', { cancelable: true, submitter: button }));
				await vi.waitFor(() => expect(button.disabled).toBe(false));
				expect(form.querySelector('[role="alert"]')?.textContent).toBe('Turn on JavaScript');
				expect((form.querySelector('input') as HTMLInputElement).value).toBe('');
			} finally {
				restore();
			}
		}
	});
});
