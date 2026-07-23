/**
 * Barrel do módulo de roteamento. Superfície pública do `src/router/`.
 */
export { DEFAULT_CONFIG, resolveConfig } from './config.js';
export { minMaxNormalize, reciprocalRankFusion, weightedFusion } from './fusion.js';
export type { ScoredItem } from './fusion.js';
export { capPerAgent, mmr } from './diversify.js';
export { buildLexicalIndex } from './lexical.js';
export type { LexicalIndex } from './lexical.js';
export { IntentRouter } from './router.js';
export type { RouterOptions } from './router.js';
