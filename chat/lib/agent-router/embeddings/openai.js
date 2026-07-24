import { l2Normalize, fetchJsonWithRetry, chunk } from './provider.js';
const DEFAULTS = {
    model: 'text-embedding-3-small',
    baseUrl: 'https://api.openai.com/v1',
    maxBatchSize: 2048,
    maxRetries: 5,
};
/** Largura NATIVA (full) por modelo — o que a API retorna quando `dimensions` é omitido. */
const MODEL_FULL_DIMENSIONS = {
    'text-embedding-3-small': 1536,
    'text-embedding-3-large': 3072,
    'text-embedding-ada-002': 1536,
};
/**
 * Resolve a dimensão que o provider vai ANUNCIAR (fonte de verdade do índice).
 * Se o usuário pediu `dimensions` explícito (truncamento Matryoshka), é ele. Senão
 * é a largura full do modelo — que varia (3-small=1536, 3-large=3072). Presumir
 * 1536 fixo faria o provider anunciar 1536 enquanto a API devolve 3072, quebrando
 * a checagem de dimensão no build. Para um modelo desconhecido sem `dimensions`
 * explícito, falha alto pedindo o valor em vez de anunciar uma largura mentirosa.
 */
function resolveDimensions(model, explicit) {
    if (explicit !== undefined)
        return explicit;
    const full = MODEL_FULL_DIMENSIONS[model];
    if (full !== undefined)
        return full;
    throw new Error(`Modelo de embedding OpenAI '${model}' não tem largura full conhecida. Passe ` +
        `'dimensions' explicitamente (ex.: { model: '${model}', dimensions: N }) para ` +
        `o provider anunciar a dimensão correta do índice.`);
}
export async function createOpenAIProvider(opts) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('Provider de embedding OpenAI precisa de uma chave. Defina a variável de ' +
            'ambiente OPENAI_API_KEY ou passe opts.apiKey.');
    }
    const model = opts.model ?? DEFAULTS.model;
    const dimensions = resolveDimensions(model, opts.dimensions);
    const baseUrl = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    const maxBatchSize = opts.maxBatchSize ?? DEFAULTS.maxBatchSize;
    const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
    const id = opts.id ?? `openai:${model}:${dimensions}`;
    async function embed(texts) {
        if (texts.length === 0)
            return [];
        const out = [];
        for (const batch of chunk(texts, maxBatchSize)) {
            const body = { model, input: batch };
            // Só manda `dimensions` se o usuário pediu truncamento explícito; alguns
            // modelos legados não aceitam o parâmetro.
            if (opts.dimensions !== undefined)
                body['dimensions'] = opts.dimensions;
            const json = (await fetchJsonWithRetry(`${baseUrl}/embeddings`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
            }, { providerLabel: `openai(${model})`, maxRetries }));
            // A API não garante ordem — reordena por `index`.
            const sorted = [...json.data].sort((a, b) => a.index - b.index);
            for (const item of sorted) {
                out.push(l2Normalize(Float32Array.from(item.embedding)));
            }
        }
        return out;
    }
    return {
        id,
        dimensions,
        asymmetric: false,
        embedQueries: embed,
        embedDocuments: embed,
        async dispose() {
            // Nada nativo para liberar; presente por simetria de interface.
        },
    };
}
//# sourceMappingURL=openai.js.map