/**
 * Superfície pública do módulo de embeddings.
 *
 * Todos os providers implementam `EmbeddingProvider` / `RerankProvider` de
 * ../types.ts. Vetores saem SEMPRE L2-normalizados de embedQueries/
 * embedDocuments — o resto do sistema usa produto escalar direto como cosseno.
 */
// Fábrica + helpers de álgebra e o tipo de opções unificado.
export { createEmbeddingProvider, l2Normalize, dotProduct, } from './provider.js';
// Providers concretos (úteis para instanciar direto, sem a fábrica).
export { createLocalProvider, MODEL_PRESETS } from './local.js';
export { createOpenAIProvider } from './openai.js';
export { createCohereProvider } from './cohere.js';
// Cache persistente em disco.
export { EmbeddingCache } from './cache.js';
//# sourceMappingURL=index.js.map