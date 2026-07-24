/**
 * Motor de roteamento integrado ao chat (CommonJS). Antes era a lib externa
 * `agent-router` (ESM, vendorizada); foi dobrada pra dentro do projeto e
 * convertida pra CJS — sem package.json próprio, sem ponte import(). Expõe só o
 * que o chat consome: IntentRouter (roteamento denso+BM25) e
 * createEmbeddingProvider/MODEL_PRESETS (embedding local MiniLM offline).
 */
const { IntentRouter, DEFAULT_CONFIG, resolveConfig } = require('./router/index.js');
const { createEmbeddingProvider, MODEL_PRESETS } = require('./embeddings/index.js');
module.exports = {
    IntentRouter,
    DEFAULT_CONFIG,
    resolveConfig,
    createEmbeddingProvider,
    MODEL_PRESETS,
};
