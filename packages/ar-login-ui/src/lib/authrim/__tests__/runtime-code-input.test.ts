import { describe, expect, it } from 'vitest';
import { withRequestedTotpCodeInput } from '../runtime-code-input';

const widget = { block_type: 'code_input_widget', field: 'code.totp' };
const auth = { block_type: 'auth_widget', field: 'auth.totp' };

describe('the code input of a method selection', () => {
	it('is added after the screen once an authenticator code has been asked for', () => {
		expect(withRequestedTotpCodeInput([auth], { totp_code_requested: 'true' }, widget)).toEqual([
			auth,
			widget
		]);
		expect(withRequestedTotpCodeInput([auth], { totp_code_requested: true }, widget)).toEqual([
			auth,
			widget
		]);
	});

	it('is not there before a code is asked for', () => {
		expect(withRequestedTotpCodeInput([auth], { totp_code_requested: 'false' }, widget)).toEqual([
			auth
		]);
		expect(withRequestedTotpCodeInput([auth], {}, widget)).toEqual([auth]);
	});

	it('is not added to a screen that has one of its own', () => {
		const own = { block_type: 'code_input_widget', field: 'code' };
		expect(withRequestedTotpCodeInput([own], { totp_code_requested: 'true' }, widget)).toEqual([
			own
		]);
	});

	it('is added to a screen whose only code input is for the emailed code', () => {
		const mail = { block_type: 'code_input_widget', field: 'code', code_input_mode: 'mail_otp' };
		expect(withRequestedTotpCodeInput([mail], { totp_code_requested: 'true' }, widget)).toEqual([
			mail,
			widget
		]);
		const fixedByMethod = {
			block_type: 'code_input_widget',
			field: 'code',
			auth_method: 'mail_otp'
		};
		expect(
			withRequestedTotpCodeInput([fixedByMethod], { totp_code_requested: 'true' }, widget)
		).toEqual([fixedByMethod, widget]);
	});

	it("is added when the screen's code input is hidden, not when it takes the authenticator code", () => {
		const hidden = {
			block_type: 'code_input_widget',
			field: 'code',
			display_condition: { mode: 'hidden' }
		};
		expect(withRequestedTotpCodeInput([hidden], { totp_code_requested: 'true' }, widget)).toEqual([
			hidden,
			widget
		]);
		for (const mode of ['auto', 'totp']) {
			const own = { block_type: 'code_input_widget', field: 'code', code_input_mode: mode };
			expect(withRequestedTotpCodeInput([own], { totp_code_requested: 'true' }, widget)).toEqual([
				own
			]);
		}
	});

	describe('where the input is placed and what counts as shown', () => {
		const row = (shown: boolean) => ({
			block_type: 'layout_row',
			field: 'row',
			display_condition: { mode: shown ? 'always' : 'hidden' }
		});
		const asked = { totp_code_requested: 'true' };

		it('is placed before a trailing row that is not shown, not inside it', () => {
			const result = withRequestedTotpCodeInput(
				[auth, row(false), { block_type: 'heading', field: 'x' }],
				asked,
				widget
			);

			expect(result.map((field) => field.field)).toEqual(['auth.totp', 'code.totp', 'row', 'x']);
		});

		it('is placed after the last shown row, whatever shown rows come before a hidden one', () => {
			const result = withRequestedTotpCodeInput(
				[row(true), auth, row(false), { block_type: 'heading', field: 'x' }],
				asked,
				widget
			);

			expect(result.map((field) => field.field)).toEqual([
				'row',
				'auth.totp',
				'code.totp',
				'row',
				'x'
			]);
		});

		it("is added when the screen's own code input is in a row that is not shown", () => {
			const own = { block_type: 'code_input_widget', field: 'code' };

			const result = withRequestedTotpCodeInput([auth, row(false), own], asked, widget);

			expect(result.map((field) => field.field)).toEqual(['auth.totp', 'code.totp', 'row', 'code']);
		});

		it('judges what is shown as the screen does, not by the display condition alone', () => {
			const own = {
				block_type: 'code_input_widget',
				field: 'code',
				display_condition: { mode: 'feature_enabled', feature: 'totp' }
			} as never;
			const featureOff = (field: {
				display_condition?: { mode?: string; feature?: string } | null;
			}) => field.display_condition?.feature !== 'totp';

			expect(
				withRequestedTotpCodeInput([auth, own], asked, widget, featureOff as never).map(
					(field) => field.field
				)
			).toEqual(['auth.totp', 'code', 'code.totp']);
			// Where the feature is on, the screen's own input is the one.
			expect(withRequestedTotpCodeInput([auth, own], asked, widget, () => true)).toEqual([
				auth,
				own
			]);
		});
	});
});
