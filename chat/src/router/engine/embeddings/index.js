/**
 * Superfície pública do módulo de embeddings (só o provider local neste snapshot).
 * Vetores saem SEMPRE L2-normalizados de embedQueries/embedDocuments — o resto
 * do sistema usa produto escalar direto como cosseno.
 */
const { createEmbeddingProvider, l2Normalize, dotProduct } = require('./provider.js');
const { createLocalProvider, MODEL_PRESETS } = require('./local.js');
module.exports = {
    createEmbeddingProvider,
    l2Normalize,
    dotProduct,
    createLocalProvider,
    MODEL_PRESETS,
};
