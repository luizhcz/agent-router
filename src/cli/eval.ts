/**
 * `npm run eval` — roda o harness de avaliação e imprime o EvalReport formatado.
 *
 * Mostra recall@1/3/5, MRR, taxa de abstenção, quebra por agente/idioma/tag,
 * latências (p50/p95/p99) e a LISTA DE MISSES com a posição real do alvo — que é
 * por onde se melhora o sistema.
 *
 * Flags para comparar configurações:
 *   --top-k N     tamanho do top-K entregue
 *   --no-lexical  desliga o BM25
 *
 * Assinatura programada: runEval(router, evalDataset): Promise<EvalReport>.
 */
import { runEval, evalDataset } from '../eval/index.js';
import type { EvalReport } from '../types.js';

import {
  parseCommonFlags,
  bootstrapRouter,
  fmtMs,
  bold,
  cyan,
  dim,
  green,
  red,
  yellow,
  fail,
} from './shared.js';

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function colorRecall(x: number): string {
  const s = pct(x);
  if (x >= 0.9) return green(s);
  if (x >= 0.75) return yellow(s);
  return red(s);
}

function printBreakdown(
  title: string,
  rows: Record<string, { total: number; recallAtK: number }>,
): void {
  const entries = Object.entries(rows).sort((a, b) => b[1].total - a[1].total);
  if (entries.length === 0) return;
  console.log(bold(title));
  const keyWidth = Math.max(...entries.map(([k]) => k.length), 8);
  for (const [key, { total, recallAtK }] of entries) {
    console.log(
      '  ' + key.padEnd(keyWidth) + '  ' + dim(`n=${String(total).padStart(3)}`) + '  ' + colorRecall(recallAtK),
    );
  }
  console.log();
}

function printReport(report: EvalReport, primaryK: number): void {
  console.log();
  console.log(bold('=== EvalReport ===') + dim(`  (${report.total} exemplos)`));
  console.log();

  // Recall@K + MRR.
  console.log(bold('métricas globais'));
  const ks = Object.keys(report.recallAt)
    .map(Number)
    .sort((a, b) => a - b);
  for (const k of ks) {
    console.log('  ' + `recall@${k}`.padEnd(12) + colorRecall(report.recallAt[k] ?? 0));
  }
  console.log('  ' + 'MRR'.padEnd(12) + report.mrr.toFixed(4));
  console.log('  ' + 'abstenção'.padEnd(12) + pct(report.abstainRate));
  console.log();

  // Quebras.
  printBreakdown(`por agente (recall@${primaryK})`, report.byAgent);
  printBreakdown(`por idioma (recall@${primaryK})`, report.byLang);
  printBreakdown(`por tag (recall@${primaryK})`, report.byTag);

  // Latências.
  console.log(bold('latência de roteamento'));
  console.log('  p50  ' + fmtMs(report.latency.p50));
  console.log('  p95  ' + fmtMs(report.latency.p95));
  console.log('  p99  ' + fmtMs(report.latency.p99));
  console.log();

  // Misses — o coração do relatório.
  if (report.misses.length === 0) {
    console.log(green(`nenhum miss — o alvo entrou no top-${primaryK} em todos os ${report.total} exemplos.`));
    return;
  }
  console.log(bold(red(`misses (${report.misses.length}/${report.total})`)) + dim('  alvo fora do top-K'));
  for (const m of report.misses) {
    const rank = m.expectedRank < 0 ? red('não recuperado') : yellow(`posição real #${m.expectedRank}`);
    console.log();
    console.log('  ' + cyan(`"${m.query}"`) + dim(`  [${m.lang}·${m.tag}]`));
    console.log('    esperado: ' + bold(m.expected) + '   ' + rank);
    console.log('    top-K:    ' + dim(m.got.join(', ')));
  }
  console.log();
}

async function main(): Promise<void> {
  const { overrides } = parseCommonFlags(process.argv.slice(2));

  if (!Array.isArray(evalDataset) || evalDataset.length === 0) {
    fail('dataset de avaliação vazio', 'Verifique src/eval/index.ts (export evalDataset).');
  }

  const { router, config } = await bootstrapRouter(overrides);

  console.error(
    dim(
      `avaliando ${evalDataset.length} exemplos · topK=${config.topK} · lexical=${config.useLexical}…`,
    ),
  );

  // Reporta no ponto de operação real: recall@topK como métrica primária (quebras
  // por agente/idioma/tag) e a tabela cobrindo 1/3/5 + o topK entregue.
  const ks = [...new Set([1, 3, 5, config.topK])].sort((a, b) => a - b);
  let report: EvalReport;
  try {
    report = await runEval(router, evalDataset, { report: { ks, primaryK: config.topK } });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    fail(`falha ao rodar o harness de avaliação: ${msg}`);
  }

  printReport(report, config.topK);
  await router.dispose();
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
