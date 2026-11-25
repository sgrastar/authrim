import { describe, expect, it } from 'vitest';
import { screenShowsConsentWidget } from '../screens';

const hidden = { mode: 'hidden' as const };

describe('a screen that shows a consent box', () => {
  it('needs a consent widget part', () => {
    expect(screenShowsConsentWidget([])).toBe(false);
    expect(screenShowsConsentWidget([{ block_type: 'heading' }])).toBe(false);
    expect(screenShowsConsentWidget([{ block_type: 'consent_widget' }])).toBe(true);
  });

  it('does not count a box shown only on a condition', () => {
    const conditional = { mode: 'feature_enabled' as const, feature: 'passkey' as const };
    expect(
      screenShowsConsentWidget([{ block_type: 'consent_widget', display_condition: conditional }])
    ).toBe(false);
    expect(
      screenShowsConsentWidget([
        { block_type: 'layout_row', display_condition: conditional },
        { block_type: 'consent_widget' },
      ])
    ).toBe(false);
  });

  it('does not count a box that is hidden, itself or by its row', () => {
    expect(
      screenShowsConsentWidget([{ block_type: 'consent_widget', display_condition: hidden }])
    ).toBe(false);
    expect(
      screenShowsConsentWidget([
        { block_type: 'layout_row', display_condition: hidden },
        { block_type: 'consent_widget' },
      ])
    ).toBe(false);
    // The next row's condition holds from there on.
    expect(
      screenShowsConsentWidget([
        { block_type: 'layout_row', display_condition: hidden },
        { block_type: 'layout_row' },
        { block_type: 'consent_widget' },
      ])
    ).toBe(true);
  });
});
