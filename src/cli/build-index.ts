/**
 * `npm run index:build` — valida o catálogo, constrói o índice denso, persiste
 * em disco (no `cacheDir` que o IntentRouter consome) e imprime estatísticas.
 *
 * O índice do router é construído/persistido dentro de `IntentRouter.create`
 * quando o cache está frio, então "construir o índice" aqui = criar o router
 * apontando para o `cacheDir` e cronometrar. Os demais CLIs (repl/eval/bench)
 * reusam esse mesmo cache e sobem rápido.
 *
 * Passos:
 *   1. Valida o catálogo; aborta com código 1 e lista os problemas se houver.
 *   2. Carrega o provider de embedding (baixa o modelo na 1ª vez).
 *   3. Cria o router → embeda todo o catálogo e grava o índice em `cacheDir`.
 *   4. Mede o tamanho em disco e imprime as estatísticas.
 */
import { rm } from 'node:fs/promises';

import { IntentRouter } from '../router/index.js';

import {
  DEFAULT_CACHE_DIR,
  assertCatalogValid,
  catalog,
  createProviderOrDie,
  dirSize,
  expectedVectorCount,
  pathExists,
  fmtBytes,
  fmtMs,
  bold,
  green,
  dim,
  yellow,
  fail,
} from './shared.js';

async function main(): Promise<void> {
  const cacheDir = process.argv[2] ?? DEFAULT_CACHE_DIR;
  const force = process.argv.includes('--force');

  // 1. Catálogo íntegro antes de gastar tempo embedando.
  console.error(dim('validando catálogo…'));
  assertCatalogValid(catalog);
  console.error(
    green('✓ catálogo válido') +
      dim(` (${catalog.commands.length} comandos, ${catalog.agents.length} agentes)`),
  );

  // Reconstrução forçada: apaga o cache para o router obrigatoriamente reembedar.
  if (force && (await pathExists(cacheDir))) {
    console.error(dim('--force: descartando cache existente…'));
    await rm(cacheDir, { recursive: true, force: true });
  } else if (await pathExists(cacheDir)) {
    console.error(
      yellow('cache já existe.') +
        dim(' Se o fingerprint bater, será reutilizado (sem reembedar). Use --force para reconstruir.'),
    );
  }

  // 2. Provider (pode baixar o modelo).
  console.error(dim('carregando provider de embedding…'));
  const embedder = await createProviderOrDie();

  // 3. Cria o router → constrói e persiste o índice se o cache estiver frio.
  console.error(dim('construindo/carregando índice…'));
  const t0 = performance.now();
  let router: IntentRouter;
  try {
    router = await IntentRouter.create({ catalog, embedder, cacheDir });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    fail(`falha ao construir o índice: ${msg}`);
  }
  const buildMs = performance.now() - t0;

  // 4. Estatísticas.
  const vectors = expectedVectorCount(catalog);
  const diskBytes = await dirSize(cacheDir);

  const line = (label: string, value: string) => console.log('  ' + label.padEnd(22) + bold(value));

  console.log();
  console.log(bold('índice pronto'));
  line('provider', embedder.id);
  line('dimensões', String(embedder.dimensions));
  line('comandos', String(catalog.commands.length));
  line('vetores', String(vectors));
  line('vetores/comando', (vectors / catalog.commands.length).toFixed(1));
  line('tempo (build+load)', fmtMs(buildMs));
  line('tamanho em disco', diskBytes ? fmtBytes(diskBytes) : '— (não cacheado)');
  line('cacheDir', cacheDir);
  console.log();
  console.log(green('pronto.') + dim(' rode `npm run router` para testar o roteamento.'));

  await router.dispose();
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
