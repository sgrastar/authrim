import { GATE_ASSETS } from './gate-assets';
import { GATE_GEOMETRY } from './gate-geometry';
import { GATE_LOGIC_JS } from './gate-logic';
import { GATE_RENDER_JS } from './gate-render';
import { GATE_UI_JS } from './gate-ui';

/** Drops indentation, blank lines and whole-line comments; token order and line breaks stay. */
export function compactJs(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('/*'))
    .join('\n');
}

/**
 * The gate page's script, served as /assets/wait.js: the logic (unit-tested as it is), the canvas
 * renderer and the DOM code, in one closure. Geometry and asset URLs are data, not code.
 */
export const WAIT_JS = `(function () {
'use strict';
${compactJs(GATE_LOGIC_JS)}
var GEO = ${JSON.stringify(GATE_GEOMETRY)};
var ASSETS = ${JSON.stringify(GATE_ASSETS)};
${compactJs(GATE_RENDER_JS)}
${compactJs(GATE_UI_JS)}
})();
`;
