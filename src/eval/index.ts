/**
 * Superfície pública do harness de avaliação.
 *
 * - `evalDataset` / `hardNegatives`: o conjunto rotulado (in-scope) e as
 *   consultas fora de escopo para medir abstenção.
 * - `runEval`: roteia o dataset e devolve o `EvalReport`.
 * - `computeReport`: agrega linhas cruas no `EvalReport` (útil para reprocessar
 *   uma execução sem re-rotear, ou para testes da matemática de recall/MRR).
 */
export { evalDataset, hardNegatives } from './dataset.js';

export { runEval } from './run.js';
export type { RoutableRouter, RunEvalOptions } from './run.js';

export { computeReport } from './recall.js';
export type { EvalRow, EvalReportConfig } from './recall.js';
