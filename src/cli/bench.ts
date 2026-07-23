/**
 * `npm run bench` — mede a latência de roteamento sobre o dataset.
 *
 * Separa o tempo por fase (embedding / busca) e reporta p50/p95/p99, com
 * aquecimento antes de medir (a 1ª inferência cria a InferenceSession).
 *
 * Flags:
 *   --runs N      quantas passadas sobre o dataset (default 3)
 *   --warmup N    consultas de aquecimento não medidas (default 5)
 *   --top-k N     tamanho do top-K
 *   --no-lexical  desliga o BM25
 */
import { evalDataset } from '../eval/index.js';

import {
  parseCommonFlags,
  bootstrapRouter,
  percentile,
  fmtMs,
  bold,
  cyan,
  dim,
  yellow,
  fail,
} from './shared.js';

/** Extrai --runs/--warmup do argv, devolvendo o restante para parseCommonFlags. */
function extractIntFlag(argv: string[], name: string, fallback: number): { value: number; rest: string[] } {
  const rest: string[] = [];
  let value = fallback;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === name || arg.startsWith(name + '=')) {
      const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) fail(`valor inválido para ${name}: ${raw}`);
      value = n;
    } else {
      rest.push(arg);
    }
  }
  return { value, rest };
}

interface Samples {
  embed: number[];
  search: number[];
  total: number[];
}

function reportPhase(label: string, samples: number[], all: number[]): void {
  if (samples.length === 0) return;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const shareTotal = all.reduce((a, b) => a + b, 0);
  const shareThis = samples.reduce((a, b) => a + b, 0);
  const share = shareTotal > 0 ? (shareThis / shareTotal) * 100 : 0;
  console.log(
    '  ' +
      label.padEnd(10) +
      'p50 ' + fmtMs(percentile(samples, 50)).padStart(9) +
      '   p95 ' + fmtMs(percentile(samples, 95)).padStart(9) +
      '   p99 ' + fmtMs(percentile(samples, 99)).padStart(9) +
      '   ' + dim(`média ${fmtMs(mean)} · ${share.toFixed(0)}% do total`),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { value: runs, rest: r1 } = extractIntFlag(argv, '--runs', 3);
  const { value: warmup, rest: r2 } = extractIntFlag(r1, '--warmup', 5);
  const { overrides } = parseCommonFlags(r2);

  if (!Array.isArray(evalDataset) || evalDataset.length === 0) {
    fail('dataset vazio', 'Verifique src/eval/index.ts (export evalDataset).');
  }
  const queries = evalDataset.map((e) => e.query);

  console.error(dim('carregando pipeline…'));
  const { router, config, embedder } = await bootstrapRouter(overrides);

  // Aquecimento — não medido.
  const warmQueries = queries.slice(0, Math.min(warmup, queries.length));
  console.error(dim(`aquecendo (${warmQueries.length} consultas)…`));
  for (const q of warmQueries) {
    try {
      await router.route(q);
    } catch {
      /* aquecimento tolera falha isolada */
    }
  }

  // Medição.
  console.error(dim(`medindo ${runs} passada(s) × ${queries.length} consultas…`));
  const s: Samples = { embed: [], search: [], total: [] };
  let failures = 0;
  for (let run = 0; run < runs; run++) {
    for (const q of queries) {
      try {
        const res = await router.route(q);
        s.embed.push(res.timings.embedMs);
        s.search.push(res.timings.searchMs);
        s.total.push(res.timings.totalMs);
      } catch {
        failures++;
      }
    }
  }

  if (s.total.length === 0) fail('nenhuma consulta roteada com sucesso.');

  console.log();
  console.log(
    bold('latência de roteamento') +
      dim(`  n=${s.total.length} · topK=${config.topK} · lexical=${config.useLexical}`),
  );
  console.log();
  reportPhase('embedding', s.embed, s.total);
  reportPhase('busca', s.search, s.total);
  console.log('  ' + '─'.repeat(58));
  reportPhase(cyan('total'), s.total, s.total);
  console.log();
  const throughput = 1000 / (s.total.reduce((a, b) => a + b, 0) / s.total.length);
  console.log(dim(`throughput sequencial ≈ ${throughput.toFixed(1)} consultas/s`));
  if (failures > 0) console.log(yellow(`${failures} consulta(s) falharam durante a medição.`));

  await embedder.dispose?.();
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
