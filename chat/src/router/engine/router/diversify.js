/**
 * Aplica um teto de comandos por agente, **mantendo a ordem por score** de
 * entrada e descartando o excedente de cada agente (os de baixo score sobem
 * naturalmente ao filtrar os de cima que já estouraram o teto).
 *
 * `maxPerAgent <= 0` é no-op (devolve a lista intacta).
 */
function capPerAgent(candidates, maxPerAgent, catalog) {
    if (maxPerAgent <= 0)
        return candidates;
    const agentOf = new Map(catalog.commands.map((c) => [c.id, c.agent]));
    const counts = new Map();
    const out = [];
    for (const c of candidates) {
        const agent = agentOf.get(c.commandId) ?? '__unknown__';
        const n = counts.get(agent) ?? 0;
        if (n >= maxPerAgent)
            continue;
        counts.set(agent, n + 1);
        out.push(c);
    }
    return out;
}
/**
 * Maximal Marginal Relevance (Carbonell & Goldstein 1998). Seleciona
 * iterativamente o item que maximiza `λ·rel − (1−λ)·max_sim_aos_já_escolhidos`.
 *
 * Relevância = `score` do candidato (min-max implícito por divisão pelo máximo);
 * similaridade = cosseno entre os **centroides** dos comandos, derivados dos
 * vetores do índice. Exportado por completude — o brief manda usar só se o eval
 * pedir; NÃO faz parte do pipeline padrão.
 */
function mmr(candidates, lambda, topK, index) {
    if (candidates.length === 0)
        return [];
    const centroids = buildCentroids(index);
    const relMax = Math.max(...candidates.map((c) => c.score)) || 1;
    const selected = [];
    const rest = [...candidates];
    const limit = Math.min(topK, candidates.length);
    while (selected.length < limit && rest.length > 0) {
        let bestIdx = 0;
        let bestVal = -Infinity;
        for (const [i, c] of rest.entries()) {
            const rel = c.score / relMax;
            let maxSim = 0;
            for (const s of selected) {
                maxSim = Math.max(maxSim, cosine(centroids, c.commandId, s.commandId));
            }
            const val = lambda * rel - (1 - lambda) * maxSim;
            if (val > bestVal) {
                bestVal = val;
                bestIdx = i;
            }
        }
        const [picked] = rest.splice(bestIdx, 1);
        if (picked)
            selected.push(picked);
    }
    return selected;
}
/** Um vetor L2-normalizado por comando: a média dos seus vetores no índice. */
function buildCentroids(index) {
    const dim = index.dimensions;
    const sums = new Map();
    for (const v of index.vectors) {
        let acc = sums.get(v.commandId);
        if (!acc) {
            acc = new Float32Array(dim);
            sums.set(v.commandId, acc);
        }
        for (let d = 0; d < dim; d++)
            acc[d] += v.vector[d];
    }
    for (const acc of sums.values()) {
        let n = 0;
        for (let d = 0; d < dim; d++)
            n += acc[d] * acc[d];
        n = Math.sqrt(n) || 1;
        for (let d = 0; d < dim; d++)
            acc[d] = acc[d] / n;
    }
    return sums;
}
function cosine(centroids, a, b) {
    const va = centroids.get(a);
    const vb = centroids.get(b);
    if (!va || !vb)
        return 0;
    let dot = 0;
    for (let d = 0; d < va.length; d++)
        dot += va[d] * vb[d];
    return dot;
}
module.exports = { capPerAgent, mmr };
