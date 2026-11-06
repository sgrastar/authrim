import { describe, expect, it } from 'vitest';
import {
	hasScreenAnswer,
	offProfileFieldKeys,
	requiredScreenInputParts,
	screenAnswerFields
} from '../runtime-screen-answers';

const screen = {
	fields: [
		{ field: 'heading', block_type: 'heading' },
		{ field: 'given_name' },
		{ field: 'department', block_type: 'select' },
		{ field: 'newsletter', block_type: 'checkbox' },
		{ field: 'agree', value_type: 'boolean' },
		{ field: 'survey', block_type: 'radio', store_to_profile: false },
		{ field: 'secret', display_condition: { mode: 'hidden' } },
		{ field: 'row', block_type: 'layout_row', display_condition: { mode: 'hidden' } },
		{ field: 'in_hidden_row' }
	]
};

describe('screenAnswerFields', () => {
	it('sends each shown input part: a checkbox as a boolean, empty text as null', () => {
		const values: Record<string, string | boolean> = {
			given_name: 'Ada',
			department: '',
			newsletter: 'true',
			agree: false,
			survey: 'web',
			secret: 'never sent',
			in_hidden_row: 'never sent'
		};
		expect(screenAnswerFields(screen, (field) => values[field])).toEqual({
			given_name: 'Ada',
			department: null,
			newsletter: true,
			agree: false,
			survey: 'web'
		});
	});

	it('leaves a box never touched (or never drawn) unanswered, not unticked', () => {
		expect(screenAnswerFields(screen, () => undefined)).toMatchObject({
			newsletter: null,
			agree: null
		});
	});

	it('sends no answers on a sign-in screen', () => {
		const codeScreen = {
			fields: [{ field: 'email' }, { field: 'auth.code', block_type: 'code_input_widget' }]
		};
		expect(screenAnswerFields(codeScreen, () => 'ada@example.com')).toEqual({});
	});

	it('requires what the server requires: not a part shown only for a method', () => {
		const required = requiredScreenInputParts({
			fields: [
				{ field: 'a', required: true },
				{ field: 'b', required: true, display_condition: { mode: 'feature_enabled' } },
				{ field: 'row', block_type: 'layout_row', display_condition: { mode: 'feature_enabled' } },
				{ field: 'c', required: true }
			]
		});
		expect(required.map((part) => part.field)).toEqual(['a']);
	});

	it('names the parts kept off the profile', () => {
		expect([...offProfileFieldKeys(screen)]).toEqual(['survey']);
	});

	it('counts a ticked box or a non-empty value as an answer', () => {
		expect(hasScreenAnswer({ block_type: 'checkbox' }, 'false')).toBe(false);
		expect(hasScreenAnswer({ block_type: 'checkbox' }, true)).toBe(true);
		expect(hasScreenAnswer({ field: 'x' }, '  ')).toBe(false);
		expect(hasScreenAnswer({ field: 'x' }, 'a')).toBe(true);
	});
});
