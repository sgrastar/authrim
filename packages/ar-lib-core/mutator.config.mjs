import { createMutatorConfig } from '../../mutator.base.mjs';

// ar-lib-core is by far the largest package (900+ source files, ~200k mutants). Mutating every
// line produced a report too large to serialize and a type-check pass of nearly two hours, so:
// - src/test/ (fixtures and setup that tsconfig.json excludes from the program) is skipped;
// - at most one mutant per source line runs, the most productive mutator first. Raise
//   `mutantsPerLine` (2, 3, ...) once the first pass is cached to deepen the run.
// src/types/ stays in: besides type declarations it holds runtime logic (event pattern
// matching, mode checks, registration flow graphs) that needs mutants.
export default createMutatorConfig({
  exclude: ['src/test/**'],
  mutantsPerLine: 1,
});
