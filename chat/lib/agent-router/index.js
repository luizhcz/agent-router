/**
 * Ponto de entrada público do pacote `agent-router`.
 *
 * Reexporta o contrato de tipos, o catálogo, a API principal de roteamento
 * (IntentRouter + config, que já constrói/persiste/carrega o índice denso
 * internamente), os providers de embedding, utilidades lexicais BM25 e a
 * camada de saída para a LLM.
 *
 * Uso típico:
 *
 *   import {
 *     IntentRouter, resolveConfig,
 *     createEmbeddingProvider,
 *     catalog, toToolSchemas,
 *   } from 'agent-router';
 */
// Contrato central de tipos.
export * from './types.js';
// Catálogo de comandos e utilidades.
export { catalog, getCommand, commandsForAgent, validateCatalog } from './catalog/index.js';
// Roteador de intenções e configuração.
export { IntentRouter, DEFAULT_CONFIG, resolveConfig } from './router/index.js';
// Providers de embedding, presets de modelo e cache de embeddings.
export { createEmbeddingProvider, MODEL_PRESETS, EmbeddingCache } from './embeddings/index.js';
// Utilidades lexicais BM25 e normalização de texto (o índice lexical do roteador
// é interno ao IntentRouter; estas são as primitivas reutilizáveis).
export { Bm25Index, normalizeText, tokenize } from './lexical/index.js';
// Camada de saída para a LLM (tool schemas, prompt, tool-choice, explicação).
export { toToolSchemas, buildSystemPrompt, buildToolChoicePayload, explainRoute } from './llm/index.js';
//# sourceMappingURL=index.js.map