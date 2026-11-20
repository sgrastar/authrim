import { createMutatorConfig } from '../../mutator.base.mjs';

// ar-management is the largest service package (500+ source files, ~220k mutants). Mutating
// every line produced a report too large to serialize (RangeError at JSON.stringify) and a
// type-check pass of nearly six hours, so at most one mutant per source line runs, the most
// productive mutator first. Raise `mutantsPerLine` (2, 3, ...) once the first pass is cached to
// deepen the run.
export default createMutatorConfig({ mutantsPerLine: 1 });
