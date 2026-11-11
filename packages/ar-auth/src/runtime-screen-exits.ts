import { screenLinkExits, type ScreenField } from '@authrim/ar-lib-core';

/**
 * The ways out of a screen step beyond its submit. A link part can leave a screen by an exit
 * (`skipped`, or one it names); where the exit leads is the Flow's: an edge from that handle of
 * the screen node. An exit the Flow has not connected goes where the screen's submit goes, so a
 * screen gains exits without the Flow having to change.
 */

/** The exits the screen of a screen step declares (its link parts), in order. */
export function declaredScreenExits(screen: unknown): string[] {
  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) return [];
  const fields = (screen as Record<string, unknown>).fields;
  if (!Array.isArray(fields)) return [];
  return screenLinkExits(
    fields.filter(
      (field): field is ScreenField =>
        Boolean(field) && typeof field === 'object' && !Array.isArray(field)
    )
  );
}

/**
 * Whether a screen asks for a code: its code input's way back (the Login UI's) leaves by
 * `skipped`, which predates link parts. A part never shown does not count.
 */
function asksForCode(screen: unknown): boolean {
  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) return false;
  const fields = (screen as Record<string, unknown>).fields;
  if (!Array.isArray(fields)) return false;
  let rowHidden = false;
  for (const raw of fields) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const field = raw as Record<string, unknown>;
    const condition = field.display_condition as Record<string, unknown> | null | undefined;
    const hidden = condition?.mode === 'hidden';
    if (field.block_type === 'layout_row') {
      rowHidden = hidden;
      continue;
    }
    if (field.block_type === 'code_input_widget' && !rowHidden && !hidden) return true;
  }
  return false;
}

/**
 * The handle a screen step's submit is routed by, or `undefined` when the screen offers no such
 * way out (an exit or a skip none of its shown parts names: an edge left from a part since removed
 * is not taken, and the answers a skip does not read cannot be passed by).
 * An exit the screen declares, which no edge leaves from, is routed as the submit (`submitted`):
 * wherever the submit goes, and nowhere it would not.
 */
export function screenRoutingHandle(
  screen: unknown,
  handle: string | null,
  outgoingHandles: readonly (string | null | undefined)[]
): string | null | undefined {
  if (!handle || handle === 'submitted') return handle;
  const declared = declaredScreenExits(screen).includes(handle);
  // A skip no shown part offers is not taken (it reads no answers): only a code input's way back.
  if (!declared) return handle === 'skipped' && asksForCode(screen) ? handle : undefined;
  if (outgoingHandles.includes(handle)) return handle;
  // Routed as the submit itself, so it can take no edge the submit would not.
  return 'submitted';
}
