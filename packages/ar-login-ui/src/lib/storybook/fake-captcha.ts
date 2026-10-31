/**
 * A stand-in for `window.turnstile` so TurnstileWidget renders without loading a script from
 * Cloudflare: stories stay offline and identical from run to run. Set
 * `window.__storybookCaptchaFails = true` before the widget mounts to see its failed state.
 */
declare global {
	interface Window {
		__storybookCaptchaFails?: boolean;
	}
}

type RenderOptions = {
	callback?: (token: string) => void;
	'error-callback'?: () => void;
	theme?: string;
};

let counter = 0;

export function installFakeCaptcha(): void {
	if (typeof window === 'undefined') return;
	const fake = {
		ready: (callback: () => void) => callback(),
		render: (container: HTMLElement, options: RenderOptions) => {
			if (window.__storybookCaptchaFails) {
				options['error-callback']?.();
				return undefined;
			}
			const id = `storybook-captcha-${++counter}`;
			container.innerHTML = '';
			const box = document.createElement('label');
			box.setAttribute('data-storybook-captcha', '');
			box.style.cssText =
				'display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid currentColor;' +
				'border-radius:4px;font:14px sans-serif;opacity:.85;width:100%;box-sizing:border-box';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.addEventListener('change', () =>
				options.callback?.(input.checked ? 'storybook-token' : '')
			);
			box.append(input, document.createTextNode('Verify you are human (sample widget)'));
			container.append(box);
			return id;
		},
		remove: () => undefined,
		reset: () => undefined,
		execute: () => undefined
	};
	(window as unknown as { turnstile: typeof fake }).turnstile = fake;
}
