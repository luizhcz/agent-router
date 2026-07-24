import { createLocalProvider } from './local.js';
/**
 * Fábrica de providers de embedding. Neste snapshot só existe o provider LOCAL
 * (MiniLM offline) — os providers HTTP (openai/cohere) foram removidos por não
 * serem usados pelo chat. O carregamento do modelo acontece em createLocalProvider.
 */
export async function createEmbeddingProvider(opts) {
    switch (opts.kind) {
        case 'local':
            return createLocalProvider(opts);
        default: {
            // Exaustividade: se um novo `kind` entrar em EmbeddingOptions e não for
            // tratado, isto vira erro de compilação.
            const never = opts;
            throw new Error(`kind de embedding desconhecido: ${JSON.stringify(never)}`);
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers de álgebra compartilhados (usados por todos os providers)
//
// São `function` declarations (hoisted) de propósito: local.ts/openai.ts/
// cohere.ts importam daqui e provider.ts importa deles, formando um ciclo de
// módulos. Com funções hoisted o binding já existe durante a avaliação
// circular, então o ciclo é seguro (nenhuma chamada acontece em top-level).
// ---------------------------------------------------------------------------
/**
 * Normaliza L2 (retorna cópia nova; não muta a entrada). Vetores de norma zero
 * são devolvidos como cópia inalterada para não gerar NaN. Todo vetor que sai
 * de um provider passa por aqui — é o ponto único que garante o invariante de
 * que cosseno == produto escalar no resto do sistema.
 */
export function l2Normalize(v) {
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
        const x = v[i];
        sum += x * x;
    }
    const norm = Math.sqrt(sum);
    const out = new Float32Array(v.length);
    if (norm === 0 || !Number.isFinite(norm)) {
        out.set(v);
        return out;
    }
    const inv = 1 / norm;
    for (let i = 0; i < v.length; i++) {
        out[i] = v[i] * inv;
    }
    return out;
}
/**
 * Produto escalar de dois trechos de Float32Array. Com vetores L2-normalizados
 * isto é a similaridade de cosseno. `offsetA`/`offsetB`/`len` permitem operar
 * sobre fatias de uma matriz densa achatada sem copiar.
 */
export function dotProduct(a, b, offsetA = 0, offsetB = 0, len) {
    const n = len ?? Math.min(a.length - offsetA, b.length - offsetB);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += a[offsetA + i] * b[offsetB + i];
    }
    return sum;
}
// (helpers HTTP fetchJsonWithRetry/backoffDelay/parseRetryAfter/safeText/sleep
//  removidos: só eram usados pelos providers openai/cohere, que saíram do snapshot.)
/** Divide `items` em blocos de no máximo `size`. Usado para respeitar o limite
 *  de itens por requisição das APIs HTTP e para batching local. */
export function chunk(items, size) {
    if (size <= 0)
        throw new Error(`chunk: tamanho de bloco inválido: ${size}`);
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}
//# sourceMappingURL=provider.js.map