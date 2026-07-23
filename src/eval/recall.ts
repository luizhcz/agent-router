/**
 * Agregação de métricas do harness de avaliação.
 *
 * `computeReport` transforma as linhas cruas por-exemplo (`EvalRow`, uma por
 * consulta, já com o ranking COMPLETO do roteador) no `EvalReport` de
 * ../types.ts. Separar produção (run.ts) de agregação (aqui) deixa a matemática
 * testável sem tocar em modelo, ONNX ou índice.
 *
 * Definições (Brief: recall@K é a métrica-mestra):
 * - recall@K = fração de exemplos em que o comando esperado aparece entre os K
 *   primeiros do ranking completo. Como o gold é único por exemplo, isso é 0/1
 *   por exemplo.
 * - MRR = média de 1/rank sobre o ranking COMPLETO (rank 1-based do alvo);
 *   exemplos em que o alvo nem foi recuperado contribuem 0.
 * - Percentis de latência por INTERPOLAÇÃO linear entre postos (método R-7 /
 *   default do numpy), nunca por índice arredondado.
 */
import type { EvalExample, EvalReport } from '../types.js';

/**
 * Resultado cru de rotear UM exemplo. `run.ts` produz um destes por consulta; a
 * agregação vive inteiramente em `computeReport`.
 */
export interface EvalRow {
  /** O exemplo rotulado que originou esta linha. */
  example: EvalExample;
  /**
   * Ranking COMPLETO devolvido pelo roteador (ids de comando, melhor primeiro).
   * É a lista inteira, não o top-K — é dela que sai a posição real do alvo.
   */
  ranking: string[];
  /** Posição 1-based do `expected` em `ranking`; `-1` se nem foi recuperado. */
  expectedRank: number;
  /** `true` se o roteador abstendeu (melhor cosseno < abstainThreshold). */
  abstained: boolean;
  /** Latência total do roteamento deste exemplo, em ms. */
  latencyMs: number;
}

/** Parâmetros de agregação. Tudo opcional; os defaults cobrem o caso comum. */
export interface EvalReportConfig {
  /** Valores de K para recall@K. Default `[1, 3, 5]`. */
  ks?: number[];
  /**
   * K "principal" usado nas quebras por agente/idioma/tag e na fronteira de
   * `misses` (alvo fora do top-K). Default `5` — a métrica-mestra do sistema.
   */
  primaryK?: number;
}

const DEFAULT_KS = [1, 3, 5] as const;
const DEFAULT_PRIMARY_K = 5;

/** Agente derivado do id do comando (`<agent>.<snake>` → `<agent>`). */
function agentOf(commandId: string): string {
  const dot = commandId.indexOf('.');
  return dot === -1 ? commandId : commandId.slice(0, dot);
}

/** `true` se o alvo caiu dentro do top-K (rank válido e ≤ K). */
function hitAtK(expectedRank: number, k: number): boolean {
  return expectedRank >= 1 && expectedRank <= k;
}

/**
 * Percentil por interpolação linear entre os dois postos vizinhos (R-7).
 * `values` NÃO precisa vir ordenado — ordenamos aqui. `p` em [0, 100].
 */
function percentile(values: number[], p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (n === 1) return sorted[0]!;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/**
 * Quebra o recall@primaryK por uma chave categórica (agente, idioma ou tag).
 * Cada bucket reporta o total de exemplos e o recall@primaryK dentro dele.
 */
function breakdownBy(
  rows: EvalRow[],
  primaryK: number,
  keyOf: (row: EvalRow) => string,
): Record<string, { total: number; recallAtK: number }> {
  const acc = new Map<string, { total: number; hits: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const cur = acc.get(key) ?? { total: 0, hits: 0 };
    cur.total += 1;
    if (hitAtK(row.expectedRank, primaryK)) cur.hits += 1;
    acc.set(key, cur);
  }
  const out: Record<string, { total: number; recallAtK: number }> = {};
  for (const [key, { total, hits }] of acc) {
    out[key] = { total, recallAtK: total === 0 ? 0 : hits / total };
  }
  return out;
}

/**
 * Consolida as linhas cruas no `EvalReport` completo de ../types.ts.
 * Função pura: mesmas linhas → mesmo relatório, sem I/O nem estado global.
 */
export function computeReport(rows: EvalRow[], config: EvalReportConfig = {}): EvalReport {
  const ks = (config.ks ?? [...DEFAULT_KS]).slice().sort((a, b) => a - b);
  const primaryK = config.primaryK ?? DEFAULT_PRIMARY_K;
  const total = rows.length;

  // recall@K para cada K pedido.
  const recallAt: Record<number, number> = {};
  for (const k of ks) {
    if (total === 0) {
      recallAt[k] = 0;
      continue;
    }
    let hits = 0;
    for (const row of rows) if (hitAtK(row.expectedRank, k)) hits += 1;
    recallAt[k] = hits / total;
  }

  // MRR sobre o ranking completo (alvo não recuperado → contribui 0).
  let reciprocalSum = 0;
  for (const row of rows) {
    if (row.expectedRank >= 1) reciprocalSum += 1 / row.expectedRank;
  }
  const mrr = total === 0 ? 0 : reciprocalSum / total;

  // Taxa de abstenção sobre os exemplos avaliados.
  let abstainCount = 0;
  for (const row of rows) if (row.abstained) abstainCount += 1;
  const abstainRate = total === 0 ? 0 : abstainCount / total;

  // Quebras por agente / tag / idioma, todas em recall@primaryK.
  const byAgent = breakdownBy(rows, primaryK, (r) => agentOf(r.example.expected));
  const byTag = breakdownBy(rows, primaryK, (r) => r.example.tag);
  const byLang = breakdownBy(rows, primaryK, (r) => r.example.lang);

  // Misses: o alvo ficou fora do top-primaryK. É por onde se melhora o sistema.
  const misses: EvalReport['misses'] = [];
  for (const row of rows) {
    if (hitAtK(row.expectedRank, primaryK)) continue;
    misses.push({
      query: row.example.query,
      expected: row.example.expected,
      lang: row.example.lang,
      tag: row.example.tag,
      expectedRank: row.expectedRank,
      got: row.ranking.slice(0, primaryK),
    });
  }
  // Piores primeiro: não recuperados (-1) no fim, depois posição decrescente.
  misses.sort((a, b) => {
    const ra = a.expectedRank < 0 ? Number.POSITIVE_INFINITY : a.expectedRank;
    const rb = b.expectedRank < 0 ? Number.POSITIVE_INFINITY : b.expectedRank;
    return rb - ra;
  });

  const latencies = rows.map((r) => r.latencyMs);
  const latency = {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };

  return {
    total,
    recallAt,
    mrr,
    abstainRate,
    byAgent,
    byTag,
    byLang,
    misses,
    latency,
  };
}
