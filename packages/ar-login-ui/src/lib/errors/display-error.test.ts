import { describe, expect, it } from 'vitest';
import {
	appendApiSupportReference,
	loginUiDisplayError,
	LoginUiDisplayError,
	messageForCaughtError
} from './display-error';

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

	it('adds a safe support code and occurrence id to a localized message', () => {
		expect(
			appendApiSupportReference('一時的に処理できません', 'エラーコード', {
				error_code: 'AR030007',
				error_id: '123e4567-e89b-42d3-a456-426614174000'
			})
		).toBe(
			'一時的に処理できません (エラーコード: AR030007 / 123e4567-e89b-42d3-a456-426614174000)'
		);
	});

	it('does not display malformed support metadata', () => {
		expect(
			appendApiSupportReference('localized fallback', 'Error code', {
				error_code: '<script>alert(1)</script>',
				error_id: 'raw-provider-secret'
			})
		).toBe('localized fallback');
	});
});
