import { GATE_LOGIC_JS } from './gate-logic';
import { GATE_UI_JS } from './gate-ui';
import { SCENE_UI_JS } from './scene-ui';

/** Drops indentation, blank lines and whole-line comments; token order and line breaks stay. */
export function compactJs(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('/*'))
    .join('\n');
}

/** Every page's script, served as /assets/scene.js: the theme, and the city behind the page. */
export const SCENE_JS = `(function () {
'use strict';
${compactJs(SCENE_UI_JS)}
})();
`;

/**
 * The waiting page's script, served as /assets/wait.js: everything that page runs, in one request,
 * so that asking for the status never waits for another file. First the same code as
 * /assets/scene.js, then the logic (unit-tested as it is) and the DOM code in a closure of their own.
 */
export const WAIT_JS = `${SCENE_JS}(function () {
'use strict';
${compactJs(GATE_LOGIC_JS)}
${compactJs(GATE_UI_JS)}
})();
`;
