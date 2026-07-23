/**
 * Fusão de listas de ranqueamento (denso + lexical) numa lista única ordenada.
 *
 * Duas estratégias, espelhando `FusionStrategy` em types.ts:
 * - RRF (padrão): usa só posições, imune a escalas incompatíveis.
 * - Weighted: soma ponderada após min-max de cada lista.
 *
 * Cada lista de entrada é assumida **já ordenada por score desc** — o índice na
 * lista é a posição (rank 1-based) que o RRF consome.
 */

/** Item pontuado; a unidade sobre a qual as fusões operam. */
export interface ScoredItem {
  commandId: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009). Cada lista contribui
 * `1 / (k + rank)` para cada item, com `rank` 1-based. `k=60` é o default de
 * produção (OpenSearch/Elastic); a curva é chata em [40, 80].
 *
 * Itens ausentes de uma lista simplesmente não recebem contribuição dela.
 */
export function reciprocalRankFusion(lists: ScoredItem[][], k: number): ScoredItem[] {
  const agg = new Map<string, number>();
  for (const list of lists) {
    for (const [i, item] of list.entries()) {
      const rank = i + 1;
      agg.set(item.commandId, (agg.get(item.commandId) ?? 0) + 1 / (k + rank));
    }
  }
  return toSorted(agg);
}

/**
 * Soma ponderada convexa após min-max de cada lista. `weights[i]` casa com
 * `lists[i]`; pesos ausentes valem 0. Itens fora de uma lista contribuem 0 por
 * ela.
 *
 * Nota (Brief §4): BM25 gera outliers que comprimem o resto sob min-max puro;
 * quando houver dados rotulados para migrar de RRF para cá, clipar percentil
 * (p1/p99) ou usar z-score antes desta chamada.
 */
export function weightedFusion(lists: ScoredItem[][], weights: number[]): ScoredItem[] {
  const agg = new Map<string, number>();
  for (const [li, list] of lists.entries()) {
    const w = weights[li] ?? 0;
    if (w === 0) continue;
    const norm = minMaxNormalize(list.map((x) => x.score));
    for (const [i, item] of list.entries()) {
      agg.set(item.commandId, (agg.get(item.commandId) ?? 0) + w * (norm[i] ?? 0));
    }
  }
  return toSorted(agg);
}

/**
 * Normaliza para [0, 1] por min-max.
 *
 * Caso degenerado (todos os valores iguais → divisão por zero): devolve **1**
 * para todos, nunca `NaN`. Interpretação: sem sinal de ordenação dentro da
 * lista, todos os itens são igualmente (máximo) relevantes por ela.
 */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return values.map(() => 1);
  return values.map((v) => (v - min) / range);
}

function toSorted(agg: Map<string, number>): ScoredItem[] {
  return [...agg.entries()]
    .map(([commandId, score]) => ({ commandId, score }))
    .sort((a, b) => b.score - a.score);
}
