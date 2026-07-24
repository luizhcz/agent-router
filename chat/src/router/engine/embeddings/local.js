const { createHash } = require('node:crypto');
const { isAbsolute, resolve } = require('node:path');
const { pipeline, env } = require('@huggingface/transformers');
const { l2Normalize, chunk } = require('./provider.js');
const DEFAULTS = {
    model: 'Xenova/multilingual-e5-base',
    dtype: 'fp32',
    dimensions: 768,
    pooling: 'mean',
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    asymmetric: true,
    batchSize: 32,
    maxLength: 256,
    device: 'cpu',
    intraOpNumThreads: 4,
    interOpNumThreads: 1,
    warmup: true,
};
/**
 * Presets de modelo com a REPRESENTAÇÃO correta de cada um já fixada. Espalhe
 * um preset sobre `{ kind: 'local' }` para não errar dims/pooling/simetria.
 */
const MODEL_PRESETS = {
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
};
async function createLocalProvider(opts) {
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
    // O id estável entra na chave de cache do índice (fingerprint em router.js).
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
    let extractorPromise = null;
    function getExtractor() {
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
                }));
                if (warmup) {
                    // Paga o cold start (criação da InferenceSession) antes do tráfego.
                    await extractor([`${queryPrefix}warmup`], { pooling, normalize: false });
                }
                return extractor;
            })();
        }
        return extractorPromise;
    }
    async function embedWithPrefix(texts, prefix) {
        if (texts.length === 0)
            return [];
        const extractor = await getExtractor();
        const out = [];
        for (const batch of chunk(texts, batchSize)) {
            const prefixed = batch.map((t) => `${prefix}${truncateChars(t, maxLength)}`);
            // pooling/normalize são opções da CHAMADA (#3). Pedimos normalize:false e
            // normalizamos nós mesmos depois de truncar dims — só assim o vetor
            // Matryoshka truncado continua unitário.
            const tensor = await extractor(prefixed, { pooling, normalize: false });
            const [n, dim] = tensorShape(tensor);
            if (dim < dimensions) {
                throw new Error(`local(${model}): modelo emitiu ${dim} dims, mas dimensions=${dimensions} ` +
                    `foi configurado. Ajuste 'dimensions' para <= ${dim}.`);
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
        embedQueries(texts) {
            return embedWithPrefix(texts, queryPrefix);
        },
        embedDocuments(texts) {
            return embedWithPrefix(texts, asymmetric ? documentPrefix : queryPrefix);
        },
        async dispose() {
            if (!extractorPromise)
                return;
            const extractor = await extractorPromise;
            extractorPromise = null;
            await extractor.dispose?.();
        },
    };
}
function tensorShape(t) {
    // Com pooling != 'none', dims == [batch, embedDim].
    const dims = t.dims;
    if (dims.length !== 2) {
        throw new Error(`local: esperava tensor 2D [batch, dim] com pooling ativo, veio [${dims.join(', ')}]`);
    }
    return [dims[0], dims[1]];
}
/**
 * Truncamento defensivo por caracteres. O `_call` do pipeline não expõe
 * `max_length` (brief §2), e ele já trunca por tokens internamente; este corte
 * grosseiro por caracteres só evita alimentar o tokenizer com textos
 * absurdamente longos. ~6 chars/token é uma folga segura.
 */
function truncateChars(text, maxTokens) {
    const cap = maxTokens * 6;
    return text.length > cap ? text.slice(0, cap) : text;
}
module.exports = { MODEL_PRESETS, createLocalProvider };
