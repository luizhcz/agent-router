/**
 * IntentRouter — o coração do sistema.
 *
 * Reduz um catálogo de ~50 comandos a um top-K enxuto para a LLM. Pipeline por
 * consulta (Brief §1-§9):
 *   embeda a query (lado query) → busca densa (max-sim por comando) até
 *   `candidatePool` → busca lexical BM25 se `useLexical` → funde (`config.fusion`)
 *   → rerank do pool se `useRerank` → aplica `maxPerAgent` → corta em `topK` →
 *   decide `abstained` pelo MELHOR score DENSO (cosseno) vs `abstainThreshold`.
 *
 * Invariante crítica: mesmo com `abstained === true`, os candidatos são SEMPRE
 * devolvidos — abstenção é um sinal para a LLM, não motivo para esconder recall.
 */
const { createHash } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { resolveConfig } = require('./config.js');
const { capPerAgent } = require('./diversify.js');
const { minMaxNormalize, reciprocalRankFusion, weightedFusion } = require('./fusion.js');
const { buildLexicalIndex } = require('./lexical.js');
/** Versão da lógica de construção de documentos; entra no fingerprint do índice. */
const INDEX_VERSION = 1;
class IntentRouter {
    embedder;
    reranker;
    config;
    index;
    lexical;
    catalog;
    commandById;
    constructor(embedder, reranker, config, index, lexical, catalog, commandById) {
        this.embedder = embedder;
        this.reranker = reranker;
        this.config = config;
        this.index = index;
        this.lexical = lexical;
        this.catalog = catalog;
        this.commandById = commandById;
    }
    /**
     * Carrega o índice do cache (se o fingerprint bater) ou o reconstrói e salva.
     * O fingerprint cobre catálogo + provider + versão da indexação.
     */
    static async create(opts) {
        const config = resolveConfig(opts.config);
        const { catalog, embedder } = opts;
        const fingerprint = computeFingerprint(catalog, embedder.id, embedder.dimensions);
        let index = null;
        if (opts.cacheDir) {
            index = await loadIndex(opts.cacheDir, catalog, embedder.id, fingerprint);
        }
        if (!index) {
            index = await buildIndex(catalog, embedder, fingerprint);
            if (opts.cacheDir)
                await saveIndex(opts.cacheDir, index);
        }
        const lexical = buildLexicalIndex(catalog);
        const commandById = new Map(catalog.commands.map((c) => [c.id, c]));
        return new IntentRouter(embedder, opts.reranker, config, index, lexical, catalog, commandById);
    }
    /** Rota uma consulta. `overrides` mescla sobre a config-base (validado). */
    async route(query, overrides) {
        const config = overrides ? resolveConfig(overrides, this.config) : this.config;
        const tEmbed = performance.now();
        const [qVec] = await this.embedder.embedQueries([query]);
        const embedMs = performance.now() - tEmbed;
        if (!qVec)
            throw new Error('embedQueries não devolveu vetor para a consulta');
        return this.searchFromEmbedding(query, qVec, config, embedMs);
    }
    /**
     * Rota um lote. Embeda todas as consultas num único forward pass (muito mais
     * rápido que N chamadas) e depois roteia cada uma. O `embedMs` por resultado é
     * o custo amortizado do batch.
     */
    async routeBatch(queries) {
        if (queries.length === 0)
            return [];
        const tEmbed = performance.now();
        const vecs = await this.embedder.embedQueries(queries);
        const embedMsPer = (performance.now() - tEmbed) / queries.length;
        const results = [];
        for (const [i, query] of queries.entries()) {
            const qVec = vecs[i];
            if (!qVec)
                throw new Error(`embedQueries não devolveu vetor para a consulta índice ${i}`);
            results.push(await this.searchFromEmbedding(query, qVec, this.config, embedMsPer));
        }
        return results;
    }
    /** Libera os recursos nativos dos providers. Idempotente. */
    async dispose() {
        await this.embedder.dispose?.();
        await this.reranker?.dispose?.();
    }
    /**
     * Config-base resolvida (defaults + overrides do construtor), somente leitura.
     * O harness de avaliação a consulta para medir na profundidade do
     * `candidatePool` REAL de produção — alargar só o `topK`, nunca o
     * `candidatePool`, preserva a composição da fusão e o escopo do rerank.
     */
    get resolvedConfig() {
        return this.config;
    }
    // -------------------------------------------------------------------------
    // Núcleo do pipeline (compartilhado por route e routeBatch)
    // -------------------------------------------------------------------------
    async searchFromEmbedding(query, qVec, config, embedMs) {
        const tSearch = performance.now();
        // 1) Denso: cosseno máximo (max-sim) por comando + rastro do melhor vetor.
        const dense = this.denseSearch(qVec);
        const denseListFull = dense.ranked;
        const bestDenseScore = denseListFull[0]?.score ?? -Infinity; // top-1 cosseno global
        const denseListPool = denseListFull.slice(0, config.candidatePool);
        const denseRank = new Map(denseListPool.map((x, i) => [x.commandId, i + 1]));
        // 2) Lexical (BM25) opcional.
        const lexNorm = new Map();
        const lexRank = new Map();
        let lexListPool = [];
        if (config.useLexical) {
            const lexFull = this.lexical.search(query).slice(0, config.candidatePool);
            const norm = minMaxNormalize(lexFull.map((x) => x.score));
            for (const [i, x] of lexFull.entries()) {
                lexRank.set(x.commandId, i + 1);
                lexNorm.set(x.commandId, norm[i] ?? 0);
            }
            lexListPool = lexFull;
        }
        // 3) Fusão.
        const lists = [denseListPool];
        if (config.useLexical)
            lists.push(lexListPool);
        let fused;
        if (config.fusion.kind === 'rrf') {
            fused = reciprocalRankFusion(lists, config.fusion.k);
        }
        else {
            const weights = config.useLexical
                ? [config.fusion.denseWeight, config.fusion.lexicalWeight]
                : [config.fusion.denseWeight];
            fused = weightedFusion(lists, weights);
        }
        let pool = fused.slice(0, config.candidatePool);
        const searchMs = performance.now() - tSearch;
        // 4) Rerank opcional do pool.
        let rerankMs = 0;
        const rerankScore = new Map();
        const rerankRank = new Map();
        if (config.useRerank && this.reranker && pool.length > 0) {
            const tRerank = performance.now();
            const docs = pool.map((p) => this.rerankDocText(p.commandId));
            const scores = await this.reranker.rerank(query, docs);
            for (const [i, p] of pool.entries())
                rerankScore.set(p.commandId, scores[i] ?? 0);
            pool = [...pool].sort((a, b) => (rerankScore.get(b.commandId) ?? 0) - (rerankScore.get(a.commandId) ?? 0));
            for (const [i, p] of pool.entries())
                rerankRank.set(p.commandId, i + 1);
            rerankMs = performance.now() - tRerank;
        }
        // 5) Monta candidatos com breakdown completo (na ordem atual do pool).
        let candidates = pool.map((p) => {
            const command = this.commandById.get(p.commandId);
            const matched = dense.matched.get(p.commandId);
            const rerank = rerankScore.get(p.commandId);
            const ranks = {};
            const dr = denseRank.get(p.commandId);
            if (dr !== undefined)
                ranks.dense = dr;
            const lr = lexRank.get(p.commandId);
            if (lr !== undefined)
                ranks.lexical = lr;
            const rr = rerankRank.get(p.commandId);
            if (rr !== undefined)
                ranks.rerank = rr;
            const breakdown = {
                dense: dense.byCommand.get(p.commandId) ?? 0,
                lexical: lexNorm.get(p.commandId) ?? 0,
                ranks,
                matchedText: matched?.text ?? '',
                matchedKind: matched?.kind ?? 'canonical',
            };
            if (rerank !== undefined)
                breakdown.rerank = rerank;
            // Score final: rerank quando rodou (reordena o pool), senão o fundido.
            const score = rerank !== undefined ? rerank : p.score;
            return { commandId: p.commandId, command, score, breakdown };
        });
        // 6) Teto por agente e corte em topK.
        candidates = capPerAgent(candidates, config.maxPerAgent, this.catalog);
        candidates = candidates.slice(0, config.topK);
        // 7) Abstenção pelo MELHOR score denso (cosseno interpretável), nunca o fundido.
        const abstained = bestDenseScore < config.abstainThreshold;
        return {
            query,
            candidates, // devolvidos mesmo com abstained === true
            abstained,
            timings: {
                embedMs,
                searchMs,
                rerankMs,
                totalMs: embedMs + searchMs + rerankMs,
            },
        };
    }
    /**
     * Busca densa: para cada comando, o maior cosseno (produto escalar, vetores
     * L2-normalizados) entre a query e qualquer um de seus vetores (max-sim, §5).
     * Retorna também o vetor vencedor por comando, para `matchedText`/`matchedKind`.
     */
    denseSearch(qVec) {
        const dim = this.index.dimensions;
        const matrix = this.index.matrix;
        const vectors = this.index.vectors;
        const byCommand = new Map();
        const matched = new Map();
        for (const [i, v] of vectors.entries()) {
            const off = i * dim;
            let dot = 0;
            for (let d = 0; d < dim; d++)
                dot += qVec[d] * matrix[off + d];
            const cur = byCommand.get(v.commandId);
            if (cur === undefined || dot > cur) {
                byCommand.set(v.commandId, dot);
                matched.set(v.commandId, v);
            }
        }
        const ranked = [...byCommand.entries()]
            .map(([commandId, score]) => ({ commandId, score }))
            .sort((a, b) => b.score - a.score);
        return { byCommand, matched, ranked };
    }
    /** Texto que o cross-encoder pontua contra a query: nome + descrição + keywords. */
    rerankDocText(commandId) {
        const cmd = this.commandById.get(commandId);
        return `${cmd.name}. ${cmd.description} ${cmd.keywords.join(' ')}`.trim();
    }
}
/** Um vetor por campo relevante do comando (canonical, cada utterance, keywords). */
function collectDocSpecs(catalog) {
    const specs = [];
    for (const cmd of catalog.commands) {
        specs.push({ commandId: cmd.id, kind: 'canonical', text: `${cmd.name}. ${cmd.description}` });
        for (const u of cmd.utterances)
            specs.push({ commandId: cmd.id, kind: 'utterance', text: u });
        if (cmd.keywords.length > 0) {
            specs.push({ commandId: cmd.id, kind: 'keywords', text: cmd.keywords.join(', ') });
        }
    }
    return specs;
}
async function buildIndex(catalog, embedder, fingerprint) {
    const specs = collectDocSpecs(catalog);
    const dim = embedder.dimensions;
    const raw = await embedder.embedDocuments(specs.map((s) => s.text));
    if (raw.length !== specs.length) {
        throw new Error(`embedDocuments devolveu ${raw.length} vetores para ${specs.length} textos`);
    }
    // Matriz achatada, própria (cópia): subarrays do provider podem compartilhar buffer (§13).
    const matrix = new Float32Array(specs.length * dim);
    const vectors = [];
    for (const [i, spec] of specs.entries()) {
        const vec = raw[i];
        if (!vec || vec.length !== dim) {
            throw new Error(`vetor ${i} com dimensão inesperada (esperado ${dim})`);
        }
        matrix.set(vec, i * dim);
        vectors.push({
            commandId: spec.commandId,
            kind: spec.kind,
            text: spec.text,
            vector: matrix.subarray(i * dim, (i + 1) * dim),
        });
    }
    return {
        catalog,
        vectors,
        matrix,
        dimensions: dim,
        providerId: embedder.id,
        fingerprint,
        builtAt: new Date().toISOString(),
    };
}
function computeFingerprint(catalog, providerId, dimensions) {
    const payload = JSON.stringify({
        v: INDEX_VERSION,
        providerId,
        dimensions,
        commands: catalog.commands.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            utterances: c.utterances,
            keywords: c.keywords,
        })),
    });
    return createHash('sha256').update(payload).digest('hex');
}
function indexPaths(cacheDir, providerId) {
    const safe = providerId.replace(/[^a-z0-9_.-]/gi, '_');
    return {
        meta: join(cacheDir, `index-${safe}.meta.json`),
        bin: join(cacheDir, `index-${safe}.bin`),
    };
}
async function saveIndex(cacheDir, index) {
    await mkdir(cacheDir, { recursive: true });
    const { meta, bin } = indexPaths(cacheDir, index.providerId);
    const metaObj = {
        providerId: index.providerId,
        dimensions: index.dimensions,
        fingerprint: index.fingerprint,
        builtAt: index.builtAt,
        vectors: index.vectors.map((v) => ({ commandId: v.commandId, kind: v.kind, text: v.text })),
    };
    await writeFile(meta, JSON.stringify(metaObj));
    await writeFile(bin, Buffer.from(index.matrix.buffer, index.matrix.byteOffset, index.matrix.byteLength));
}
async function loadIndex(cacheDir, catalog, providerId, expectedFingerprint) {
    try {
        const { meta, bin } = indexPaths(cacheDir, providerId);
        const metaObj = JSON.parse(await readFile(meta, 'utf8'));
        if (metaObj.fingerprint !== expectedFingerprint)
            return null;
        const buf = await readFile(bin);
        // Cópia exata dos bytes num ArrayBuffer próprio, alinhado a 4 (Float32).
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const matrix = new Float32Array(ab);
        const dim = metaObj.dimensions;
        if (matrix.length !== metaObj.vectors.length * dim)
            return null; // arquivo corrompido → reconstrói
        const vectors = metaObj.vectors.map((v, i) => ({
            commandId: v.commandId,
            kind: v.kind,
            text: v.text,
            vector: matrix.subarray(i * dim, (i + 1) * dim),
        }));
        return {
            catalog,
            vectors,
            matrix,
            dimensions: dim,
            providerId: metaObj.providerId,
            fingerprint: metaObj.fingerprint,
            builtAt: metaObj.builtAt,
        };
    }
    catch {
        return null; // cache ausente/ilegível → reconstrói
    }
}
module.exports = { IntentRouter };
