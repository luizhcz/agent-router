/**
 * Barrel do módulo de roteamento. Superfície pública do `router/`.
 */
const { DEFAULT_CONFIG, resolveConfig } = require('./config.js');
const { minMaxNormalize, reciprocalRankFusion, weightedFusion } = require('./fusion.js');
const { capPerAgent, mmr } = require('./diversify.js');
const { buildLexicalIndex } = require('./lexical.js');
const { IntentRouter } = require('./router.js');
module.exports = {
    DEFAULT_CONFIG,
    resolveConfig,
    minMaxNormalize,
    reciprocalRankFusion,
    weightedFusion,
    capPerAgent,
    mmr,
    buildLexicalIndex,
    IntentRouter,
};
