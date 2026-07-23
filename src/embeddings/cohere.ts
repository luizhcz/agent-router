import type { EmbeddingProvider, Vector } from '../types.js';
import { l2Normalize, fetchJsonWithRetry, chunk } from './provider.js';

/**
 * Provider HTTP da Cohere Embed API v2 (fetch nativo). Os modelos v3 são
 * assimétricos via `input_type`: consultas usam `search_query`, documentos
 * usam `search_document` — daí `asymmetric = true`. A API aceita no máximo 96
 * textos por requisição, então o batch respeita esse teto.
 */
export interface CohereEmbeddingOptions {
  kind: 'cohere';
  /** Padrão `embed-multilingual-v3.0` (1024 dims). */
  model?: string;
  /** Chave. Padrão: `process.env.COHERE_API_KEY`. */
  apiKey?: string;
  /** Base da API. Padrão `https://api.cohere.com/v2`. */
  baseUrl?: string;
  /** Dimensões do modelo (multilingual-v3.0 = 1024). Padrão 1024. */
  dimensions?: number;
  /** Itens por requisição. Limite da API é 96; padrão 96. */
  maxBatchSize?: number;
  /** Tentativas totais em 429/5xx. Padrão 5. */
  maxRetries?: number;
  /** Sobrescreve o id estável do provider. */
  id?: string;
}

interface CohereEmbedResponse {
  embeddings: { float?: number[][] };
}

const DEFAULTS = {
  model: 'embed-multilingual-v3.0',
  baseUrl: 'https://api.cohere.com/v2',
  dimensions: 1024,
  maxBatchSize: 96,
  maxRetries: 5,
};

export async function createCohereProvider(
  opts: CohereEmbeddingOptions,
): Promise<EmbeddingProvider> {
  const apiKey = opts.apiKey ?? process.env.COHERE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Provider de embedding Cohere precisa de uma chave. Defina a variável de ' +
        'ambiente COHERE_API_KEY ou passe opts.apiKey.',
    );
  }

  const model = opts.model ?? DEFAULTS.model;
  const baseUrl = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
  const dimensions = opts.dimensions ?? DEFAULTS.dimensions;
  const maxBatchSize = opts.maxBatchSize ?? DEFAULTS.maxBatchSize;
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const id = opts.id ?? `cohere:${model}:${dimensions}`;

  async function embed(
    texts: string[],
    inputType: 'search_query' | 'search_document',
  ): Promise<Vector[]> {
    if (texts.length === 0) return [];
    const out: Vector[] = [];

    for (const batch of chunk(texts, maxBatchSize)) {
      const json = (await fetchJsonWithRetry(
        `${baseUrl}/embed`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            texts: batch,
            input_type: inputType,
            embedding_types: ['float'],
          }),
        },
        { providerLabel: `cohere(${model})`, maxRetries },
      )) as CohereEmbedResponse;

      const floats = json.embeddings.float;
      if (!floats) {
        throw new Error(
          `cohere(${model}): resposta sem embeddings.float (embedding_types incompatível?)`,
        );
      }
      // A API preserva a ordem dos `texts` enviados.
      for (const vec of floats) {
        out.push(l2Normalize(Float32Array.from(vec)));
      }
    }
    return out;
  }

  return {
    id,
    dimensions,
    asymmetric: true,
    embedQueries(texts: string[]): Promise<Vector[]> {
      return embed(texts, 'search_query');
    },
    embedDocuments(texts: string[]): Promise<Vector[]> {
      return embed(texts, 'search_document');
    },
    async dispose(): Promise<void> {
      // Nada nativo para liberar; presente por simetria de interface.
    },
  };
}
