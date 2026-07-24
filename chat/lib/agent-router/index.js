/**
 * Ponto de entrada da lib agent-router VENDORIZADA e ENXUGADA para o chat.
 * Contém SÓ o que o chat consome: IntentRouter (roteamento denso+BM25) e
 * createEmbeddingProvider/MODEL_PRESETS (embedding local MiniLM). Os módulos
 * não usados pelo chat — catalog/, llm/, lexical/ e os providers HTTP
 * (openai/cohere) + EmbeddingCache — foram removidos deste snapshot.
 */
// Roteador de intenções e configuração.
export { IntentRouter, DEFAULT_CONFIG, resolveConfig } from './router/index.js';
// Provider de embedding local (MiniLM) + presets de modelo.
export { createEmbeddingProvider, MODEL_PRESETS } from './embeddings/index.js';