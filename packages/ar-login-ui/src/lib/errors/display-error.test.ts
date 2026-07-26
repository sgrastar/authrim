import { describe, expect, it } from 'vitest';
import { loginUiDisplayError, LoginUiDisplayError, messageForCaughtError } from './display-error';

describe('LoginUI display error boundary', () => {
	it('shows explicitly localized messages', () => {
		const error = loginUiDisplayError('翻訳済みのメッセージ');

		expect(error).toBeInstanceOf(LoginUiDisplayError);
		expect(messageForCaughtError(error, 'fallback')).toBe('翻訳済みのメッセージ');
	});

	it('does not expose API, SDK, browser, or network error messages', () => {
		expect(messageForCaughtError(new Error('Network error occurred'), 'localized fallback')).toBe(
			'localized fallback'
		);
		expect(
			messageForCaughtError(
				new DOMException('The operation either timed out or was not allowed', 'NotAllowedError'),
				'localized fallback'
			)
		).toBe('localized fallback');
	});
});
