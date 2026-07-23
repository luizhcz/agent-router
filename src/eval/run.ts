/**
 * Harness de avaliação — roteia cada exemplo do dataset e mede recall@K.
 *
 * `runEval(router, dataset?, opts?)` roteia CADA exemplo pedindo ao roteador o
 * pool de produção INTEIRO ordenado (não apenas o top-5 entregue), de modo a
 * descobrir a posição REAL do alvo mesmo quando ele cai fora do top-5 — sem isso
 * a lista de `misses` do relatório fica inútil (não dá pra saber se o alvo estava
 * em #6 ou nem foi recuperado).
 *
 * Fidelidade (crítico): para obter esse ranking sobrescrevemos APENAS `topK`
 * (levando-o à profundidade do `candidatePool` de produção) e NUNCA o
 * `candidatePool`. Alargar o `candidatePool` mudaria (a) o CONJUNTO de itens que
 * entra nas listas densa/lexical fundidas — o RRF só agrega itens presentes em
 * cada lista fatiada, então o top-5 pode reordenar —, (b) o pool que o
 * cross-encoder rerankeia (o catálogo inteiro em vez dos 20 de produção) e (c) o
 * conjunto sobre o qual `maxPerAgent` corta. Mantendo o `candidatePool` de
 * produção e só soltando o corte final `topK`, o prefixo devolvido é bit-a-bit o
 * top-K de produção sob QUALQUER config (RRF, weighted, rerank, maxPerAgent), e
 * recall@K/MRR/expectedRank são o valor REAL do roteador. A profundidade do
 * ranking fica limitada ao `candidatePool`: um alvo fora do pool de produção
 * aparece como `-1` (não recuperado) — exatamente como produção o perderia.
 *
 * Concorrência limitada (Brief): embeda/roteia em janelas de tamanho fixo em vez
 * de disparar N roteamentos de uma vez, para não reter N tensores/pools em
 * memória num catálogo servido por onnxruntime nativo.
 */
import type { EvalExample, EvalReport, RouteResult, RouterConfig } from '../types.js';

import { computeReport, type EvalReportConfig, type EvalRow } from './recall.js';
import { evalDataset } from './dataset.js';

/**
 * Superfície mínima do roteador que o harness consome. `IntentRouter` a
 * satisfaz; tipá-la assim mantém o eval desacoplado do provider concreto e
 * trivialmente mockável em teste.
 */
export interface RoutableRouter {
  route(query: string, overrides?: Partial<RouterConfig>): Promise<RouteResult>;
  /**
   * Config-base resolvida do roteador. Quando presente, o harness mede na
   * profundidade do `candidatePool` REAL de produção (alargando só `topK`), o que
   * mantém recall@K fiel. `IntentRouter` a expõe; mocks podem omiti-la e cair no
   * fallback `fullRankSize`.
   */
  readonly resolvedConfig?: RouterConfig;
}

export interface RunEvalOptions {
  /** Parâmetros de agregação repassados a `computeReport` (ks, primaryK). */
  report?: EvalReportConfig;
  /** Quantos exemplos rotear em paralelo. Default 8. */
  concurrency?: number;
  /**
   * Alvo de `topK`/`candidatePool` usado para forçar o ranking completo. Precisa
   * folgar sobre o tamanho do catálogo; o default cobre qualquer catálogo real.
   */
  fullRankSize?: number;
  /** Callback opcional de progresso (concluídos, total). */
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_FULL_RANK_SIZE = 100_000;

/** Localiza a posição 1-based de `expected` no ranking; `-1` se ausente. */
function rankOf(ranking: string[], expected: string): number {
  const idx = ranking.indexOf(expected);
  return idx === -1 ? -1 : idx + 1;
}

/**
 * Roteia um exemplo pedindo o pool de produção inteiro ordenado e monta a
 * `EvalRow` crua.
 *
 * Sobrescreve APENAS `topK` — levando-o à profundidade do `candidatePool` real de
 * produção (via `router.resolvedConfig`) — e deixa `candidatePool`, fusão,
 * lexical, rerank, `maxPerAgent` e abstenção intactos da config-base. Assim o
 * prefixo devolvido é idêntico ao top-K de produção e recall@K/expectedRank são
 * fiéis (ver a nota de fidelidade no topo do arquivo). Sem `resolvedConfig`
 * (mocks), cai no fallback `fullRankSize`.
 */
async function evalOne(
  router: RoutableRouter,
  example: EvalExample,
  fullRankSize: number,
): Promise<EvalRow> {
  const base = router.resolvedConfig;
  // `topK` = `candidatePool` de produção satisfaz a validação (candidatePool >=
  // topK) e devolve todo o pool ordenado, sem alargar a composição da fusão.
  const overrides: Partial<RouterConfig> = base
    ? { topK: base.candidatePool }
    : { topK: fullRankSize, candidatePool: fullRankSize };
  const result = await router.route(example.query, overrides);
  const ranking = result.candidates.map((c) => c.commandId);
  return {
    example,
    ranking,
    expectedRank: rankOf(ranking, example.expected),
    abstained: result.abstained,
    latencyMs: result.timings.totalMs,
  };
}

/**
 * Executa `worker` sobre `items` com no máximo `limit` em voo, preservando a
 * ordem de saída. Pool de índices compartilhado: cada "trilha" puxa o próximo
 * índice livre — sem alocar N promessas de uma vez.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: () => void,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  async function lane(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
      onSettled?.();
    }
  }

  await Promise.all(Array.from({ length: width }, () => lane()));
  return out;
}

/**
 * Roda o harness completo: roteia todo o `dataset` (default `evalDataset`) com
 * concorrência limitada e devolve o `EvalReport` agregado por `computeReport`.
 */
export async function runEval(
  router: RoutableRouter,
  dataset: EvalExample[] = evalDataset,
  opts: RunEvalOptions = {},
): Promise<EvalReport> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const fullRankSize = opts.fullRankSize ?? DEFAULT_FULL_RANK_SIZE;

  let done = 0;
  const total = dataset.length;
  const rows = await mapWithConcurrency(
    dataset,
    concurrency,
    (example) => evalOne(router, example, fullRankSize),
    () => opts.onProgress?.(++done, total),
  );

  return computeReport(rows, opts.report);
}
