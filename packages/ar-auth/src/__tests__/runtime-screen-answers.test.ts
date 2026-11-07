import { describe, expect, it } from 'vitest';
import {
  MAX_SCREEN_TEXT_ANSWER_LENGTH,
  hasSignInMethodPart,
  readRuntimeScreenAnswers,
  readSignUpScreenFields,
  shownScreenInputParts,
  splitOffProfileAnswers,
  splitProfileAnswers,
  type RuntimeScreenAnswer,
} from '../runtime-screen-answers';

const options = [
  { value: 'sales', label: 'Sales' },
  { value: 'dev', label: 'Development' },
];

const screen = {
  fields: [
    { field: 'heading', block_type: 'heading', label: 'Tell us more' },
    { field: 'name', label: 'Name', required: true },
    { field: 'department', block_type: 'select', options, label: 'Department' },
    { field: 'newsletter', block_type: 'checkbox', label: 'News', required: true },
    {
      field: 'survey_source',
      block_type: 'radio',
      store_to_profile: false,
      answer_targets: ['record'],
      options,
      label: 'How did you hear',
    },
    { field: 'legacy_ok', value_type: 'boolean', label: 'OK' },
    { field: 'secret', label: 'Hidden', display_condition: { mode: 'hidden' } },
    { field: 'row', block_type: 'layout_row', display_condition: { mode: 'hidden' } },
    { field: 'in_hidden_row', label: 'Hidden row' },
  ],
};

const complete = { name: ' Ada ', newsletter: true, department: 'dev' };

describe('readRuntimeScreenAnswers', () => {
  it('reads the shown input parts only', () => {
    expect(shownScreenInputParts(screen).map((part) => part.field)).toEqual([
      'name',
      'department',
      'newsletter',
      'survey_source',
      'legacy_ok',
    ]);
  });

  it('accepts complete answers, trims text and reads a posted checkbox', () => {
    const read = readRuntimeScreenAnswers(screen, {
      fields: { ...complete, newsletter: 'true', survey_source: 'sales' },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.answers).toEqual([
      expect.objectContaining({ field: 'name', value: 'Ada', storeToProfile: true }),
      expect.objectContaining({ field: 'department', blockType: 'select', value: 'dev' }),
      expect.objectContaining({ field: 'newsletter', blockType: 'checkbox', value: true }),
      expect.objectContaining({
        field: 'survey_source',
        storeToProfile: false,
        answerTargets: ['record'],
        value: 'sales',
      }),
      expect.objectContaining({ field: 'legacy_ok', blockType: 'checkbox', value: null }),
    ]);
  });

  it('refuses a key the screen does not show', () => {
    for (const key of ['secret', 'in_hidden_row', 'email', '__proto__x']) {
      expect(readRuntimeScreenAnswers(screen, { fields: { ...complete, [key]: 'x' } })).toEqual({
        ok: false,
        problem: 'unknown_field',
        field: key,
      });
    }
  });

  it('refuses a missing required answer and an unticked required checkbox', () => {
    expect(readRuntimeScreenAnswers(screen, { fields: { ...complete, name: '  ' } })).toEqual({
      ok: false,
      problem: 'required',
      field: 'name',
    });
    expect(
      readRuntimeScreenAnswers(screen, { fields: { ...complete, newsletter: false } })
    ).toEqual({ ok: false, problem: 'required', field: 'newsletter' });
    expect(readRuntimeScreenAnswers(screen, undefined)).toMatchObject({ ok: false, field: 'name' });
  });

  it('refuses a choice outside the options, a wrong type and a too long text', () => {
    expect(
      readRuntimeScreenAnswers(screen, { fields: { ...complete, department: 'hr' } })
    ).toMatchObject({ ok: false, problem: 'invalid_value', field: 'department' });
    expect(
      readRuntimeScreenAnswers(screen, { fields: { ...complete, newsletter: 'yes' } })
    ).toMatchObject({ ok: false, problem: 'invalid_value', field: 'newsletter' });
    expect(readRuntimeScreenAnswers(screen, { fields: { ...complete, name: 42 } })).toMatchObject({
      ok: false,
      problem: 'invalid_value',
    });
    expect(
      readRuntimeScreenAnswers(screen, {
        fields: { ...complete, name: 'x'.repeat(MAX_SCREEN_TEXT_ANSWER_LENGTH + 1) },
      })
    ).toMatchObject({ ok: false, problem: 'too_long', field: 'name' });
    expect(readRuntimeScreenAnswers(screen, { fields: ['name'] })).toMatchObject({
      ok: false,
      problem: 'invalid_input',
    });
  });

  it('reads no answers on a screen a person signs in on (its submit is the sign-in)', () => {
    const codeScreen = {
      fields: [
        { field: 'email', label: 'Email', required: true },
        { field: 'auth.code_input', block_type: 'code_input_widget', required: true },
      ],
    };
    expect(readRuntimeScreenAnswers(codeScreen, {})).toEqual({ ok: true, answers: [] });
    expect(readRuntimeScreenAnswers(codeScreen, { fields: { other: 'x' } })).toEqual({
      ok: true,
      answers: [],
    });
  });

  it('does not require a part shown only for a sign-in method', () => {
    const conditional = {
      fields: [
        {
          field: 'nickname',
          required: true,
          display_condition: { mode: 'feature_enabled', feature: 'passkey' },
        },
      ],
    };
    expect(readRuntimeScreenAnswers(conditional, { fields: {} }).ok).toBe(true);
    // Nor one in a row shown only for a method.
    const inConditionalRow = {
      fields: [
        {
          field: 'row',
          block_type: 'layout_row',
          display_condition: { mode: 'feature_enabled', feature: 'passkey' },
        },
        { field: 'nickname', required: true },
      ],
    };
    expect(readRuntimeScreenAnswers(inConditionalRow, { fields: {} }).ok).toBe(true);
  });
});

describe('splitProfileAnswers', () => {
  it('splits standard fields and custom attributes, and never stores an off-profile answer', () => {
    const read = readRuntimeScreenAnswers(
      {
        fields: [
          { field: 'field.canonical.given_name', label: 'Given name' },
          { field: 'Department', block_type: 'select', options },
          { field: 'newsletter', block_type: 'checkbox' },
          { field: 'preferred_username', label: 'Username' },
          { field: 'email', label: 'Email' },
          { field: 'gone', label: 'Gone' },
          { field: 'empty', label: 'Empty' },
          {
            field: 'name',
            store_to_profile: false,
            answer_targets: ['record'],
            label: 'Not the profile name',
          },
        ],
      },
      {
        fields: {
          'field.canonical.given_name': 'Ada',
          Department: 'dev',
          newsletter: false,
          preferred_username: 'ada',
          email: 'ada@example.com',
          gone: 'x',
          name: 'kept off the profile',
        },
      }
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const split = splitProfileAnswers(
      read.answers,
      new Map([
        ['department', 'department'],
        ['newsletter', 'newsletter'],
      ])
    );
    expect(split.profile).toEqual({ given_name: 'Ada' });
    expect(split.custom).toEqual({ department: 'dev', newsletter: false });
    expect(split.skipped).toEqual(['preferred_username', 'email', 'gone']);
  });
});

describe('splitOffProfileAnswers', () => {
  const answer = (
    field: string,
    blockType: RuntimeScreenAnswer['blockType'],
    answerTargets: string[],
    value: RuntimeScreenAnswer['value'],
    storeToProfile = false
  ): RuntimeScreenAnswer => ({ field, blockType, storeToProfile, answerTargets, value });

  it('sends choices to the Flow, every Flow answer to its event and the rest to the record', () => {
    const split = splitOffProfileAnswers([
      answer('plan', 'select', ['flow_event', 'record'], 'pro'),
      answer('note', 'identity_field', ['flow_event'], 'Call me'),
      answer('agree', 'checkbox', ['flow_event'], false),
      answer('source', 'radio', ['record'], 'web'),
      answer('given_name', 'identity_field', [], 'Ada', true),
    ]);

    expect(split.flowContext).toEqual({ plan: 'pro', agree: false });
    expect(split.flowEvent).toEqual({ plan: 'pro', note: 'Call me', agree: false });
    expect(split.record).toEqual({ plan: 'pro', source: 'web' });
    expect(split.hasFlowEventPart).toBe(true);
    expect(split.hasFlowContextPart).toBe(true);
  });

  it('keeps nothing for a part left empty, and knows the screen sends to the Flow all the same', () => {
    const split = splitOffProfileAnswers([
      answer('plan', 'select', ['flow_event'], null),
      answer('note', 'identity_field', ['record'], null),
    ]);

    expect(split).toEqual({
      hasFlowEventPart: true,
      hasFlowContextPart: true,
      hasRecordPart: true,
      flowEvent: {},
      flowContext: {},
      record: {},
    });
  });

  it('sends nothing anywhere for a screen whose answers all go to the profile', () => {
    const split = splitOffProfileAnswers([
      answer('given_name', 'identity_field', ['flow_event'], 'Ada', true),
    ]);

    expect(split.hasFlowEventPart).toBe(false);
    expect(split.flowEvent).toEqual({});
  });
});

describe('readSignUpScreenFields', () => {
  const fixed = (field: string) => ['email', 'name', 'field.canonical.email'].includes(field);
  const signUp = {
    fields: [
      { field: 'email', label: 'Email', required: true },
      { field: 'company', label: 'Company', required: true },
      { field: 'plan', block_type: 'select', options, label: 'Plan' },
      { field: 'terms', block_type: 'checkbox', label: 'Terms', required: true },
      { field: 'legacy_ok', value_type: 'boolean', label: 'OK' },
      {
        field: 'survey',
        block_type: 'radio',
        store_to_profile: false,
        answer_targets: ['flow_event'],
        options,
        label: 'Survey',
      },
      { field: 'internal', label: 'Hidden', display_condition: { mode: 'hidden' } },
      {
        field: 'promo',
        label: 'Promo',
        required: true,
        display_condition: { mode: 'feature_enabled' },
      },
      { field: 'signup', block_type: 'auth_widget', auth_method: 'passkey' },
    ],
  };
  const read = (fields: unknown) => readSignUpScreenFields(signUp, fields, fixed);

  it('accepts the attributes the screen shows and stores to the profile', () => {
    expect(read({ company: 'Acme', plan: 'dev', terms: 'true', legacy_ok: false })).toEqual({
      ok: true,
    });
    // The fixed fields are the sign-up's own; numbers are left to the Identity Schema.
    expect(read({ email: 'a@example.com', company: 42, terms: true })).toEqual({ ok: true });
  });

  it('refuses an attribute the screen does not show or keeps off the profile', () => {
    expect(read({ company: 'Acme', terms: true, internal: 'x' })).toEqual({
      ok: false,
      problem: 'unknown_field',
      field: 'internal',
    });
    expect(read({ company: 'Acme', terms: true, survey: 'dev' })).toEqual({
      ok: false,
      problem: 'unknown_field',
      field: 'survey',
    });
    expect(read({ company: 'Acme', terms: true, role: 'admin' })).toMatchObject({
      field: 'role',
    });
  });

  it('refuses a value the part does not offer', () => {
    expect(read({ company: 'Acme', terms: true, plan: 'enterprise' })).toEqual({
      ok: false,
      problem: 'invalid_value',
      field: 'plan',
    });
    expect(read({ company: 'Acme', terms: 'yes' })).toMatchObject({ problem: 'invalid_value' });
    expect(read({ company: ['Acme'], terms: true })).toMatchObject({
      problem: 'invalid_value',
      field: 'company',
    });
  });

  it('needs every required part, a required checkbox ticked', () => {
    expect(read({ terms: true })).toEqual({ ok: false, problem: 'required', field: 'company' });
    expect(read({ company: '  ', terms: true })).toMatchObject({ field: 'company' });
    expect(read({ company: 'Acme', terms: false })).toEqual({
      ok: false,
      problem: 'required',
      field: 'terms',
    });
    // A part shown only for a method is not required here, nor a fixed field.
    expect(read({ company: 'Acme', terms: true })).toEqual({ ok: true });
  });

  it('reads no attributes as none, and refuses what is not an object', () => {
    expect(readSignUpScreenFields({ fields: [] }, undefined, fixed)).toEqual({ ok: true });
    expect(read('company=Acme')).toEqual({ ok: false, problem: 'invalid_input', field: null });
  });

  it('tells a screen a sign-in or sign-up starts on', () => {
    expect(hasSignInMethodPart(signUp)).toBe(true);
    expect(hasSignInMethodPart(screen)).toBe(false);
    expect(hasSignInMethodPart({ fields: [{ block_type: 'code_input_widget' }] })).toBe(false);
  });
});
