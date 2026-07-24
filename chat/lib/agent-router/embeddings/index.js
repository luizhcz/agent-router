/**
 * Superfície pública do módulo de embeddings.
 *
 * Todos os providers implementam `EmbeddingProvider` / `RerankProvider` de
 * ../types.ts. Vetores saem SEMPRE L2-normalizados de embedQueries/
 * embedDocuments — o resto do sistema usa produto escalar direto como cosseno.
 */
// Fábrica + helpers de álgebra e o tipo de opções unificado.
export { createEmbeddingProvider, l2Normalize, dotProduct, } from './provider.js';
// Provider concreto local (MiniLM) + presets de modelo. Os providers HTTP
// (openai/cohere) e o EmbeddingCache foram removidos do snapshot do chat.
export { createLocalProvider, MODEL_PRESETS } from './local.js';