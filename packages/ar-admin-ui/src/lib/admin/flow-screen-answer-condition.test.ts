import { describe, expect, it } from 'vitest';
import {
	screenAnswerDraftToValues,
	screenAnswerValuesToDraft
} from './flow-screen-answer-condition';

describe('screen answer condition values', () => {
	it('keeps a value with spaces or commas whole, one value per line', () => {
		expect(screenAnswerDraftToValues('business pro')).toEqual({ value: 'business pro' });
		expect(screenAnswerDraftToValues('a, b\n  c d  \n\n')).toEqual({ values: ['a, b', 'c d'] });
		expect(screenAnswerDraftToValues('')).toEqual({ value: '' });
	});

	it('saves a stored condition as it was when it is opened and saved again', () => {
		for (const stored of [
			{ value: 'business pro' },
			{ value: 'business\npro' },
			{ value: 'C:\\plans\\pro' },
			{ values: ['a, b', 'line\r\nbreak', 'back\\n slash'] }
		]) {
			expect(screenAnswerDraftToValues(screenAnswerValuesToDraft(stored))).toEqual(stored);
		}
		expect(screenAnswerDraftToValues(screenAnswerValuesToDraft({ value: true }))).toEqual({
			value: 'true'
		});
	});

	it('shows a line break inside a value as \\n on its line', () => {
		expect(screenAnswerValuesToDraft({ values: ['business\npro', 'team'] })).toBe(
			'business\\npro\nteam'
		);
	});
});
