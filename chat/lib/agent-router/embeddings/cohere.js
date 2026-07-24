import { l2Normalize, fetchJsonWithRetry, chunk } from './provider.js';
const DEFAULTS = {
    model: 'embed-multilingual-v3.0',
    baseUrl: 'https://api.cohere.com/v2',
    dimensions: 1024,
    maxBatchSize: 96,
    maxRetries: 5,
};
export async function createCohereProvider(opts) {
    const apiKey = opts.apiKey ?? process.env.COHERE_API_KEY;
    if (!apiKey) {
        throw new Error('Provider de embedding Cohere precisa de uma chave. Defina a variável de ' +
            'ambiente COHERE_API_KEY ou passe opts.apiKey.');
    }
    const model = opts.model ?? DEFAULTS.model;
    const baseUrl = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    const dimensions = opts.dimensions ?? DEFAULTS.dimensions;
    const maxBatchSize = opts.maxBatchSize ?? DEFAULTS.maxBatchSize;
    const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
    const id = opts.id ?? `cohere:${model}:${dimensions}`;
    async function embed(texts, inputType) {
        if (texts.length === 0)
            return [];
        const out = [];
        for (const batch of chunk(texts, maxBatchSize)) {
            const json = (await fetchJsonWithRetry(`${baseUrl}/embed`, {
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
            }, { providerLabel: `cohere(${model})`, maxRetries }));
            const floats = json.embeddings.float;
            if (!floats) {
                throw new Error(`cohere(${model}): resposta sem embeddings.float (embedding_types incompatível?)`);
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
        embedQueries(texts) {
            return embed(texts, 'search_query');
        },
        embedDocuments(texts) {
            return embed(texts, 'search_document');
        },
        async dispose() {
            // Nada nativo para liberar; presente por simetria de interface.
        },
    };
}
//# sourceMappingURL=cohere.js.map