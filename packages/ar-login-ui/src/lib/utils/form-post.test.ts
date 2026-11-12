// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFormPost, submitFormPost } from './form-post';

describe('form post as data', () => {
	afterEach(() => {
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('reads the action and the fields of an answer', () => {
		expect(
			readFormPost({
				form_post: { action: 'https://app.example/cb', fields: [['error', 'access_denied']] }
			})
		).toEqual({ action: 'https://app.example/cb', fields: [['error', 'access_denied']] });
	});

	it('refuses an action the redirect rule refuses, and malformed or empty fields', () => {
		const fields = [['a', 'b']];
		expect(readFormPost({ form_post: { action: 'http://app.example/cb', fields } })).toBeNull();
		expect(readFormPost({ form_post: { action: '//evil.example/cb', fields } })).toBeNull();
		expect(
			readFormPost({ form_post: { action: 'https://app.example/cb', fields: [] } })
		).toBeNull();
		expect(
			readFormPost({ form_post: { action: 'https://app.example/cb', fields: [['a', 1]] } })
		).toBeNull();
		expect(readFormPost({ redirect_url: 'https://app.example' })).toBeNull();
		expect(readFormPost(null)).toBeNull();
	});

	it('submits a real post form with the fields as hidden inputs', () => {
		const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
		submitFormPost({
			action: 'https://app.example/cb',
			fields: [
				['error', 'access_denied'],
				['state', 's']
			]
		});
		const form = document.querySelector('form') as HTMLFormElement;
		expect(form.method).toBe('post');
		expect(form.action).toBe('https://app.example/cb');
		expect([...form.querySelectorAll('input')].map((i) => [i.type, i.name, i.value])).toEqual([
			['hidden', 'error', 'access_denied'],
			['hidden', 'state', 's']
		]);
		expect(submit).toHaveBeenCalledOnce();
	});
});
