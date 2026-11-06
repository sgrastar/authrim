/**
 * The answers a person gives on a Flow `screen` step (a profile completion, a survey), checked
 * against the step's screen as the server resolved it, never against what the browser says the
 * screen was.
 *
 * The browser sends them as `input.fields`: `{ [part's field]: string | boolean | null }`. A
 * checkbox is a boolean (or `'true'`/`'false'`, as a form posts it); a select or radio part one of
 * its choices' values; a text part a string. Only the input parts the screen shows may be
 * answered: a key the screen does not ask for refuses the whole submit.
 *
 * What is stored where:
 * - a part stored to the profile writes the user's standard profile field (the ones a login may
 *   update) or the custom attribute of the same key in the Identity Schema;
 * - an identifier or a contact (email, phone, preferred_username) is never written here;
 * - a part not stored to the profile is never written to the profile, whatever its key: its
 *   answer goes where its `answer_targets` say (`splitOffProfileAnswers`). To the Flow and its
 *   event: a choice is kept with the interaction (`context_json.screen_answers`), and every answer
 *   rides on the `flow.screen.submitted` event (free text there only, stored nowhere). To the
 *   response record: the signed-in user's `screen_responses` row, in their PII database (a guest's
 *   answers are not kept as a record).
 */
import {
  PROFILE_UPDATE_FIELDS,
  SCREEN_CHOICE_BLOCK_TYPES,
  SCREEN_INPUT_BLOCK_TYPES,
  type ProfileUpdateField,
} from '@authrim/ar-lib-core';
import { runtimeAttributeKey } from './runtime-screen-options';

type JsonObject = Record<string, unknown>;

/** The longest text answer kept (a profile field's own rules may say less). */
export const MAX_SCREEN_TEXT_ANSWER_LENGTH = 1000;

const INPUT_BLOCK_TYPES: ReadonlySet<string> = new Set(SCREEN_INPUT_BLOCK_TYPES);
const CHOICE_BLOCK_TYPES: ReadonlySet<string> = new Set(SCREEN_CHOICE_BLOCK_TYPES);
const PROFILE_FIELDS: ReadonlySet<string> = new Set(PROFILE_UPDATE_FIELDS);
/** The parts a person signs in with: a screen that has one is a sign-in, not a form to answer. */
const SIGN_IN_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'auth_widget',
  'code_input_widget',
  'guest_login_widget',
]);

export type ScreenAnswerValue = string | boolean;

export interface RuntimeScreenAnswer {
  /** The part's `field`, as the browser names the answer. */
  field: string;
  blockType: 'identity_field' | 'select' | 'radio' | 'checkbox';
  /** False for a part whose answer is kept off the profile. */
  storeToProfile: boolean;
  answerTargets: string[];
  /** The answer, or null for a part left empty. */
  value: ScreenAnswerValue | null;
}

export type RuntimeScreenAnswerProblem =
  | 'invalid_input'
  | 'unknown_field'
  | 'required'
  | 'invalid_value'
  | 'too_long';

export type RuntimeScreenAnswerRead =
  | { ok: true; answers: RuntimeScreenAnswer[] }
  | { ok: false; problem: RuntimeScreenAnswerProblem; field: string | null };

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isHidden(part: JsonObject): boolean {
  return isRecord(part.display_condition) && part.display_condition.mode === 'hidden';
}

/**
 * A part (or row) shown only while a sign-in method is on. The server does not require its
 * answer: it does not judge the method's availability as the page does, and a screen to answer
 * has no reason to depend on one (a part the page did not draw must never block the submit).
 */
function isConditional(part: JsonObject): boolean {
  return isRecord(part.display_condition) && part.display_condition.mode === 'feature_enabled';
}

function blockTypeOf(part: JsonObject): string {
  return text(part.block_type) ?? 'identity_field';
}

function isCheckboxPart(part: JsonObject): boolean {
  const blockType = blockTypeOf(part);
  // The legacy yes/no form: an identity field of value type boolean.
  return (
    blockType === 'checkbox' ||
    (blockType === 'identity_field' && text(part.value_type) === 'boolean')
  );
}

/**
 * The input parts a screen shows, in order: not hidden themselves, nor in a hidden row. (A
 * person cannot answer what the Login UI does not draw.)
 */
export function shownScreenInputParts(screen: unknown): JsonObject[] {
  return shownParts(screen).map((shown) => shown.part);
}

/** The shown input parts, each with whether it (or its row) is shown only for a method. */
function shownParts(screen: unknown): Array<{ part: JsonObject; conditional: boolean }> {
  if (!isRecord(screen) || !Array.isArray(screen.fields)) return [];
  const parts: Array<{ part: JsonObject; conditional: boolean }> = [];
  let rowHidden = false;
  let rowConditional = false;
  for (const raw of screen.fields) {
    if (!isRecord(raw)) continue;
    const blockType = blockTypeOf(raw);
    if (blockType === 'layout_row') {
      rowHidden = isHidden(raw);
      rowConditional = isConditional(raw);
      continue;
    }
    if (rowHidden || isHidden(raw) || !INPUT_BLOCK_TYPES.has(blockType)) continue;
    if (!text(raw.field)) continue;
    parts.push({ part: raw, conditional: rowConditional || isConditional(raw) });
  }
  return parts;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** The values a choice part offers (the resolved screen's, from the schema or its own). */
function optionValues(part: JsonObject): Set<string> {
  const values = new Set<string>();
  if (!Array.isArray(part.options)) return values;
  for (const option of part.options) {
    if (isRecord(option) && typeof option.value === 'string') values.add(option.value);
  }
  return values;
}

function readAnswer(
  part: JsonObject,
  raw: unknown
):
  | { ok: true; value: ScreenAnswerValue | null }
  | { ok: false; problem: 'invalid_value' | 'too_long' } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (isCheckboxPart(part)) {
    const checked = readBoolean(raw);
    return checked === null
      ? { ok: false, problem: 'invalid_value' }
      : { ok: true, value: checked };
  }
  if (typeof raw !== 'string') return { ok: false, problem: 'invalid_value' };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (CHOICE_BLOCK_TYPES.has(blockTypeOf(part))) {
    return optionValues(part).has(value)
      ? { ok: true, value }
      : { ok: false, problem: 'invalid_value' };
  }
  if (value.length > MAX_SCREEN_TEXT_ANSWER_LENGTH) return { ok: false, problem: 'too_long' };
  return { ok: true, value };
}

/**
 * Whether a screen is one a person signs in on (it has a sign-in part): its identity fields are
 * what the sign-in uses (the address a code goes to), and its `submitted` is the sign-in's own
 * success (a code checked), sent without answers. Its parts are not answers.
 */
export function isSignInScreen(screen: unknown): boolean {
  if (!isRecord(screen) || !Array.isArray(screen.fields)) return false;
  return screen.fields.some((part) => isRecord(part) && SIGN_IN_BLOCK_TYPES.has(blockTypeOf(part)));
}

/**
 * The answers in `input.fields`, checked against the screen the step shows. A sign-in screen has
 * none (whatever is sent is not read).
 */
export function readRuntimeScreenAnswers(screen: unknown, input: unknown): RuntimeScreenAnswerRead {
  if (isSignInScreen(screen)) return { ok: true, answers: [] };
  const shown = shownParts(screen);
  const rawFields = isRecord(input) ? input.fields : undefined;
  if (rawFields !== undefined && rawFields !== null && !isRecord(rawFields)) {
    return { ok: false, problem: 'invalid_input', field: null };
  }
  const submitted: JsonObject = isRecord(rawFields) ? rawFields : {};
  const byField = new Map(shown.map(({ part }) => [text(part.field) as string, part]));
  for (const key of Object.keys(submitted)) {
    if (!byField.has(key)) return { ok: false, problem: 'unknown_field', field: key };
  }

  const answers: RuntimeScreenAnswer[] = [];
  for (const { part, conditional } of shown) {
    const field = text(part.field) as string;
    const read = readAnswer(
      part,
      Object.prototype.hasOwnProperty.call(submitted, field) ? submitted[field] : undefined
    );
    if (!read.ok) return { ok: false, problem: read.problem, field };
    // A required checkbox must be ticked; any other required part must have an answer.
    const missing = read.value === null || (isCheckboxPart(part) && read.value === false);
    if (part.required === true && !conditional && missing) {
      return { ok: false, problem: 'required', field };
    }
    const blockType = blockTypeOf(part) as RuntimeScreenAnswer['blockType'];
    answers.push({
      field,
      blockType: blockType === 'identity_field' && isCheckboxPart(part) ? 'checkbox' : blockType,
      storeToProfile: part.store_to_profile !== false,
      answerTargets: Array.isArray(part.answer_targets)
        ? part.answer_targets.filter((target): target is string => typeof target === 'string')
        : [],
      value: read.value,
    });
  }
  return { ok: true, answers };
}

/**
 * Where the profile answers go: standard profile fields, and custom attributes by the key the
 * screen names. An empty answer changes nothing (the screen does not show what is stored, so
 * leaving a field empty is not a request to clear it). `customKeys` maps an attribute key as a
 * part names it (lowercase, without `field.canonical.`) to the schema's own key.
 */
export function splitProfileAnswers(
  answers: RuntimeScreenAnswer[],
  customKeys: ReadonlyMap<string, string>
): {
  profile: Partial<Record<ProfileUpdateField, string>>;
  custom: Record<string, ScreenAnswerValue>;
  skipped: string[];
} {
  const profile: Partial<Record<ProfileUpdateField, string>> = {};
  const custom: Record<string, ScreenAnswerValue> = {};
  const skipped: string[] = [];
  for (const answer of answers) {
    if (!answer.storeToProfile || answer.value === null) continue;
    const key = runtimeAttributeKey(answer.field);
    const schemaKey = customKeys.get(key);
    if (schemaKey) {
      custom[schemaKey] = answer.value;
    } else if (PROFILE_FIELDS.has(key) && typeof answer.value === 'string') {
      profile[key as ProfileUpdateField] = answer.value;
    } else {
      // An identifier, a contact, or an attribute the schema does not have (any more).
      skipped.push(answer.field);
    }
  }
  return { profile, custom, skipped };
}

/** The part kinds whose answers are a choice (kept with the Flow, usable to branch on). */
const CHOICE_ANSWER_TYPES: ReadonlySet<RuntimeScreenAnswer['blockType']> = new Set([
  'select',
  'radio',
  'checkbox',
]);

export interface OffProfileScreenAnswers {
  /** Whether the screen has a part whose answers go to the Flow and its event. */
  hasFlowEventPart: boolean;
  /** Whether the screen has such a part that is a choice (select, radio, checkbox). */
  hasFlowContextPart: boolean;
  /** Whether the screen has a part whose answers go to the response record. */
  hasRecordPart: boolean;
  /** Every answer going to the Flow's event, free text included (carried by the event only). */
  flowEvent: Record<string, ScreenAnswerValue>;
  /** The choice answers going to the Flow, kept with the interaction. Free text never is. */
  flowContext: Record<string, ScreenAnswerValue>;
  /** The answers going to the response record (a signed-in user's PII). */
  record: Record<string, ScreenAnswerValue>;
}

/**
 * Where the answers kept off the profile go, by each part's `answer_targets`. A part left empty
 * is absent (it has no answer to keep). A part stored to the profile goes nowhere here.
 */
export function splitOffProfileAnswers(answers: RuntimeScreenAnswer[]): OffProfileScreenAnswers {
  const split: OffProfileScreenAnswers = {
    hasFlowEventPart: false,
    hasFlowContextPart: false,
    hasRecordPart: false,
    flowEvent: {},
    flowContext: {},
    record: {},
  };
  for (const answer of answers) {
    if (answer.storeToProfile) continue;
    const toFlow = answer.answerTargets.includes('flow_event');
    const isChoice = CHOICE_ANSWER_TYPES.has(answer.blockType);
    const toRecord = answer.answerTargets.includes('record');
    if (toFlow) {
      split.hasFlowEventPart = true;
      if (isChoice) split.hasFlowContextPart = true;
    }
    if (toRecord) split.hasRecordPart = true;
    if (answer.value === null) continue;
    if (toFlow) {
      split.flowEvent[answer.field] = answer.value;
      if (isChoice) split.flowContext[answer.field] = answer.value;
    }
    if (toRecord) split.record[answer.field] = answer.value;
  }
  return split;
}
