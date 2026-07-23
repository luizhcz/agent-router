import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import { pipeline, env } from '@huggingface/transformers';
import type { EmbeddingProvider, Vector } from '../types.js';
import { l2Normalize, chunk } from './provider.js';

/**
 * Provider local via @huggingface/transformers (onnxruntime-node nativo). É o
 * padrão do projeto: roda 100% offline, sem chave de API.
 *
 * Padrão de modelo (brief §1): `Xenova/multilingual-e5-base`, 768 dims, fp32,
 * pooling `mean`, prefixos `"query: "` / `"passage: "`. Para o modelo de máxima
 * qualidade (Qwen3-Embedding-0.6B), passe `pooling: 'last_token'`, o
 * `queryPrefix` com a instrução, `documentPrefix: ''` e `dimensions: 1024`.
 *
 * Presets prontos em `MODEL_PRESETS` (E5, MiniLM). O MiniLM é SIMÉTRICO
 * (`asymmetric: false`, sem prefixos) e 384 dims — aplicar os prefixos do E5
 * nele degrada recall sem erro. Para rodar de uma pasta local sem rede, passe
 * `localModelPath` (raiz onde vive `<model>/onnx/model*.onnx`) — isso desliga o
 * download remoto (pegadinha: o carregamento vira 100% offline).
 */
export interface LocalEmbeddingOptions {
  kind: 'local';
  /**
   * `repo_id` no Hub, ou — quando `localModelPath` é dado — o NOME DA PASTA do
   * modelo dentro dela. Padrão: `Xenova/multilingual-e5-base`.
   */
  model?: string;
  /**
   * Raiz de modelos locais. Quando presente, o transformers.js carrega de
   * `<localModelPath>/<model>/…` e o download remoto é DESLIGADO (offline).
   * Caminho relativo é resolvido a partir do CWD do processo.
   */
  localModelPath?: string;
  /**
   * Precisão dos pesos ONNX. Padrão em CPU é `fp32` (pegadinha #7 do brief:
   * omitir NÃO dá q8 no backend nativo). `q8` exige que o repo tenha o arquivo
   * quantizado correspondente (pegadinha #6).
   */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'q4f16' | 'bnb4';
  /**
   * Dimensão de saída. Padrão 768 (e5-base). Se o modelo emitir MAIS dims que
   * este valor, o vetor é truncado (Matryoshka, ex.: Qwen3 1024→N) e
   * re-normalizado. Emitir MENOS que o configurado é erro de configuração.
   */
  dimensions?: number;
  /**
   * Estratégia de pooling passada na CHAMADA (pegadinha #3). `mean` para E5;
   * `last_token` para decoders como Qwen3 (pegadinha #9). Nunca use `mean` num
   * modelo last-token — derruba qualidade silenciosamente.
   */
  pooling?: 'none' | 'mean' | 'cls' | 'first_token' | 'eos' | 'last_token';
  /** Prefixo literal do lado query. Padrão `"query: "` (com o espaço). */
  queryPrefix?: string;
  /** Prefixo literal do lado documento. Padrão `"passage: "` (com o espaço). */
  documentPrefix?: string;
  /** `true` se query/documento usam prefixos distintos. Padrão `true` (E5). */
  asymmetric?: boolean;
  /** Itens por forward pass (padding em lote). Padrão 32. */
  batchSize?: number;
  /** Teto de tokens; textos maiores são truncados. Padrão 256. */
  maxLength?: number;
  /** Backend. Padrão `cpu` (onnxruntime-node nativo). */
  device?: 'cpu' | 'gpu' | 'auto' | 'wasm' | 'webgpu';
  /** Threads intra-op do onnxruntime nativo (pegadinha #8). Padrão 4. */
  intraOpNumThreads?: number;
  /** Threads inter-op. Padrão 1. */
  interOpNumThreads?: number;
  /** Roda uma inferência dummy no boot para pagar o cold start (#12). Padrão true. */
  warmup?: boolean;
  /** Sobrescreve o id estável do provider (entra na chave de cache). */
  id?: string;
}

/** Tensor de saída do pipeline de feature-extraction (subset que usamos). */
interface FeatureTensor {
  dims: number[];
  data: Float32Array;
  type: string;
}

type FeatureExtractor = ((
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<FeatureTensor>) & {
  dispose?: () => Promise<void>;
};

const DEFAULTS = {
  model: 'Xenova/multilingual-e5-base',
  dtype: 'fp32' as const,
  dimensions: 768,
  pooling: 'mean' as const,
  queryPrefix: 'query: ',
  documentPrefix: 'passage: ',
  asymmetric: true,
  batchSize: 32,
  maxLength: 256,
  device: 'cpu' as const,
  intraOpNumThreads: 4,
  interOpNumThreads: 1,
  warmup: true,
};

/**
 * Presets de modelo com a REPRESENTAÇÃO correta de cada um já fixada. Espalhe
 * um preset sobre `{ kind: 'local' }` para não errar dims/pooling/simetria.
 */
export const MODEL_PRESETS = {
  /** E5-base multilíngue: assimétrico, 768d, prefixos `query:`/`passage:`. */
  e5: {
    model: 'Xenova/multilingual-e5-base',
    dimensions: 768,
    pooling: 'mean',
    asymmetric: true,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    dtype: 'fp32',
  },
  /**
   * paraphrase-multilingual-MiniLM-L12-v2: SIMÉTRICO, 384d, SEM prefixos,
   * mean pooling. ~4x menor/mais rápido que o E5-base.
   */
  minilm: {
    model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dimensions: 384,
    pooling: 'mean',
    asymmetric: false,
    queryPrefix: '',
    documentPrefix: '',
    // q8 (int8) => onnx/model_quantized.onnx (~118MB vs 448MB do fp32). Perda de
    // recall desprezível em roteamento por embedding; 4x menor pra versionar/clonar.
    dtype: 'q8',
  },
} as const satisfies Record<string, Partial<LocalEmbeddingOptions>>;

export async function createLocalProvider(
  opts: LocalEmbeddingOptions,
): Promise<EmbeddingProvider> {
  const model = opts.model ?? DEFAULTS.model;
  const dtype = opts.dtype ?? DEFAULTS.dtype;
  const dimensions = opts.dimensions ?? DEFAULTS.dimensions;
  const pooling = opts.pooling ?? DEFAULTS.pooling;
  const queryPrefix = opts.queryPrefix ?? DEFAULTS.queryPrefix;
  const documentPrefix = opts.documentPrefix ?? DEFAULTS.documentPrefix;
  const asymmetric = opts.asymmetric ?? DEFAULTS.asymmetric;
  const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
  const maxLength = opts.maxLength ?? DEFAULTS.maxLength;
  const device = opts.device ?? DEFAULTS.device;
  const intraOpNumThreads = opts.intraOpNumThreads ?? DEFAULTS.intraOpNumThreads;
  const interOpNumThreads = opts.interOpNumThreads ?? DEFAULTS.interOpNumThreads;
  const warmup = opts.warmup ?? DEFAULTS.warmup;
  // Modo offline: `localModelPath` aponta a raiz onde vive `<model>/onnx/*.onnx`.
  // Resolvido para absoluto (env.localModelPath é interpretado pelo transformers.js).
  const localRoot = opts.localModelPath
    ? isAbsolute(opts.localModelPath)
      ? opts.localModelPath
      : resolve(process.cwd(), opts.localModelPath)
    : undefined;
  // O id estável entra na chave de cache do índice (fingerprint em router.ts).
  // Ele PRECISA cobrir tudo que muda a REPRESENTAÇÃO dos vetores — não só
  // model/dtype/dimensions, mas também pooling e os prefixos query/document
  // (asymmetric decide qual prefixo o lado documento usa). Sem isso, trocar
  // pooling:'last_token' ou documentPrefix mantendo o mesmo modelo reaproveitaria
  // silenciosamente um índice cacheado noutro espaço, e query e documentos
  // passariam a viver em representações diferentes (recall despenca sem erro).
  const reprHash = createHash('sha256')
    .update(JSON.stringify({ pooling, queryPrefix, documentPrefix, asymmetric }))
    .digest('hex')
    .slice(0, 12);
  const id = opts.id ?? `local:${model}:${dtype}:${dimensions}:${reprHash}`;

  // Carregamento preguiçoso: o pipeline (caro de criar) só nasce na primeira
  // chamada de embed, e uma única instância é reusada para sempre (#12).
  let extractorPromise: Promise<FeatureExtractor> | null = null;

  function getExtractor(): Promise<FeatureExtractor> {
    if (!extractorPromise) {
      extractorPromise = (async () => {
        if (localRoot) {
          // Carrega de disco e NÃO toca a rede. `env` é global no transformers.js;
          // como cada processo cria um único provider, configurá-lo aqui é seguro.
          env.localModelPath = localRoot;
          env.allowLocalModels = true;
          env.allowRemoteModels = false;
        }
        const extractor = (await pipeline('feature-extraction', model, {
          device,
          dtype,
          session_options: {
            intraOpNumThreads,
            interOpNumThreads,
            graphOptimizationLevel: 'all',
          },
        })) as unknown as FeatureExtractor;

        if (warmup) {
          // Paga o cold start (criação da InferenceSession) antes do tráfego.
          await extractor([`${queryPrefix}warmup`], { pooling, normalize: false });
        }
        return extractor;
      })();
    }
    return extractorPromise;
  }

  async function embedWithPrefix(texts: string[], prefix: string): Promise<Vector[]> {
    if (texts.length === 0) return [];
    const extractor = await getExtractor();
    const out: Vector[] = [];

    for (const batch of chunk(texts, batchSize)) {
      const prefixed = batch.map((t) => `${prefix}${truncateChars(t, maxLength)}`);
      // pooling/normalize são opções da CHAMADA (#3). Pedimos normalize:false e
      // normalizamos nós mesmos depois de truncar dims — só assim o vetor
      // Matryoshka truncado continua unitário.
      const tensor = await extractor(prefixed, { pooling, normalize: false });
      const [n, dim] = tensorShape(tensor);

      if (dim < dimensions) {
        throw new Error(
          `local(${model}): modelo emitiu ${dim} dims, mas dimensions=${dimensions} ` +
            `foi configurado. Ajuste 'dimensions' para <= ${dim}.`,
        );
      }

      for (let i = 0; i < n; i++) {
        // subarray compartilha o buffer do tensor (#13); slice() copia para um
        // buffer independente antes de o tensor ser descartado/reusado.
        const full = tensor.data.subarray(i * dim, i * dim + dimensions).slice();
        out.push(l2Normalize(full));
      }
    }
    return out;
  }

  return {
    id,
    dimensions,
    asymmetric,

    embedQueries(texts: string[]): Promise<Vector[]> {
      return embedWithPrefix(texts, queryPrefix);
    },
    embedDocuments(texts: string[]): Promise<Vector[]> {
      return embedWithPrefix(texts, asymmetric ? documentPrefix : queryPrefix);
    },

    async dispose(): Promise<void> {
      if (!extractorPromise) return;
      const extractor = await extractorPromise;
      extractorPromise = null;
      await extractor.dispose?.();
    },
  };
}

function tensorShape(t: FeatureTensor): [number, number] {
  // Com pooling != 'none', dims == [batch, embedDim].
  const dims = t.dims;
  if (dims.length !== 2) {
    throw new Error(
      `local: esperava tensor 2D [batch, dim] com pooling ativo, veio [${dims.join(', ')}]`,
    );
  }
  return [dims[0]!, dims[1]!];
}

/**
 * Truncamento defensivo por caracteres. O `_call` do pipeline não expõe
 * `max_length` (brief §2), e ele já trunca por tokens internamente; este corte
 * grosseiro por caracteres só evita alimentar o tokenizer com textos
 * absurdamente longos. ~6 chars/token é uma folga segura.
 */
function truncateChars(text: string, maxTokens: number): string {
  const cap = maxTokens * 6;
  return text.length > cap ? text.slice(0, cap) : text;
}
