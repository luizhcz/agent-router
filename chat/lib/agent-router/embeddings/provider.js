import { createLocalProvider } from './local.js';
import { createOpenAIProvider } from './openai.js';
import { createCohereProvider } from './cohere.js';
/**
 * Fábrica única de providers de embedding. Não faz trabalho pesado: só resolve
 * a variante e delega. O carregamento do modelo (local) ou a validação de chave
 * (HTTP) acontece dentro de cada `create*`.
 */
export async function createEmbeddingProvider(opts) {
    switch (opts.kind) {
        case 'local':
            return createLocalProvider(opts);
        case 'openai':
            return createOpenAIProvider(opts);
        case 'cohere':
            return createCohereProvider(opts);
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
/**
 * POST JSON com retry exponencial + jitter. Reenfileira em 429 e 5xx,
 * respeitando `Retry-After` quando presente. 4xx (exceto 429) falha na hora
 * com o corpo da resposta na mensagem — normalmente é chave inválida ou payload
 * malformado, coisas que retry não conserta.
 */
export async function fetchJsonWithRetry(url, init, opts) {
    const baseDelayMs = opts.baseDelayMs ?? 500;
    const maxDelayMs = opts.maxDelayMs ?? 20_000;
    let lastErr;
    for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
        let res;
        try {
            res = await fetch(url, init);
        }
        catch (err) {
            // Erro de rede/DNS/timeout — retriable.
            lastErr = err;
            if (attempt < opts.maxRetries - 1) {
                await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
                continue;
            }
            break;
        }
        if (res.ok) {
            return (await res.json());
        }
        const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
        const body = await safeText(res);
        lastErr = new Error(`${opts.providerLabel}: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
        if (!retriable || attempt === opts.maxRetries - 1) {
            throw lastErr;
        }
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        await sleep(retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
    throw lastErr instanceof Error
        ? lastErr
        : new Error(`${opts.providerLabel}: falhou após ${opts.maxRetries} tentativas`);
}
function backoffDelay(attempt, base, max) {
    const exp = Math.min(max, base * 2 ** attempt);
    // Full jitter.
    return Math.floor(Math.random() * exp);
}
function parseRetryAfter(header) {
    if (!header)
        return null;
    const secs = Number(header);
    if (Number.isFinite(secs))
        return Math.max(0, secs * 1000);
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs))
        return Math.max(0, dateMs - Date.now());
    return null;
}
async function safeText(res) {
    try {
        const t = await res.text();
        return t.length > 500 ? `${t.slice(0, 500)}…` : t;
    }
    catch {
        return '';
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
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