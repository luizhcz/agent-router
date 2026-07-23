/**
 * Utilidades compartilhadas pelos CLIs (`build-index`, `repl`, `eval`, `bench`).
 *
 * Único ponto onde os CLIs tocam nas superfícies públicas dos módulos irmãos —
 * centraliza suposições de assinatura. Programado contra o que existe de fato:
 *
 *   embeddings → createEmbeddingProvider(opts: EmbeddingOptions): Promise<EmbeddingProvider>
 *   router     → IntentRouter.create(opts: RouterOptions): Promise<IntentRouter>
 *                RouterOptions = { catalog, embedder, config?, cacheDir? }
 *                router.route(query, overrides?): Promise<RouteResult>
 *                router.dispose(): Promise<void>
 *
 * NOTA DE INTEGRAÇÃO: o IntentRouter constrói/carrega o índice denso e o índice
 * BM25 internamente (via `cacheDir`), então os CLIs NÃO montam índice manual —
 * passam `cacheDir` e deixam o router cachear. O `index:build` apenas aquece
 * esse mesmo cache.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stat, readdir, access } from 'node:fs/promises';

import type {
  Catalog,
  EmbeddingProvider,
  RouterConfig,
  RouteResult,
} from '../types.js';
import type { EmbeddingOptions, LocalEmbeddingOptions } from '../embeddings/index.js';

import { catalog, validateCatalog } from '../catalog/index.js';
import { createEmbeddingProvider, MODEL_PRESETS } from '../embeddings/index.js';
import { IntentRouter, resolveConfig } from '../router/index.js';

// ---------------------------------------------------------------------------
// Caminhos e constantes
// ---------------------------------------------------------------------------

/** Raiz do pacote, ancorada no próprio arquivo (funciona sob tsx e sob dist/). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Diretório de cache do índice do router. `index:build` o aquece; os demais CLIs o reusam. */
export const DEFAULT_CACHE_DIR =
  process.env.ROUTER_CACHE_DIR ?? join(PACKAGE_ROOT, '.cache', 'router-index');

/** Raiz das pastas de modelos locais (offline). Contém `<modelo>/onnx/model.onnx`. */
export const MODELS_DIR = process.env.ROUTER_MODELS_DIR ?? join(PACKAGE_ROOT, 'models');

// ---------------------------------------------------------------------------
// Saída no terminal
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = (s: string) => paint('1', s);
export const dim = (s: string) => paint('2', s);
export const red = (s: string) => paint('31', s);
export const green = (s: string) => paint('32', s);
export const yellow = (s: string) => paint('33', s);
export const cyan = (s: string) => paint('36', s);

/** Imprime uma mensagem acionável em stderr e encerra com código 1. */
export function fail(message: string, hint?: string): never {
  console.error(red('erro: ') + message);
  if (hint) console.error(dim(hint));
  process.exit(1);
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

/** Percentil (interpolação linear) sobre uma amostra. `values` não precisa estar ordenado. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Soma o tamanho de todos os arquivos num diretório (1 nível; o cache é plano). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) total += s.size;
    } catch {
      /* ignora entradas transitórias */
    }
  }
  return total;
}

/**
 * Nº exato de vetores que o índice terá: por comando, 1 canonical + N utterances
 * + 1 keywords (espelha o `collectDocEntries` do index/router).
 */
export function expectedVectorCount(c: Catalog): number {
  return c.commands.reduce((n, cmd) => n + 2 + cmd.utterances.length, 0);
}

// ---------------------------------------------------------------------------
// Parsing de flags comuns aos CLIs
// ---------------------------------------------------------------------------

export interface CommonFlags {
  /** Overrides de config derivados de --top-k / --no-rerank / --no-lexical. */
  overrides: Partial<RouterConfig>;
  /** Argumentos posicionais restantes (ex.: a consulta única do REPL). */
  positional: string[];
}

/** Extrai `--top-k N|=N`, `--no-lexical`/`--lexical`. */
export function parseCommonFlags(argv: string[]): CommonFlags {
  const overrides: Partial<RouterConfig> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;

    switch (key) {
      case '--top-k':
      case '--topk': {
        const raw = inlineVal ?? argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) fail(`valor inválido para --top-k: ${raw}`);
        overrides.topK = n;
        overrides.candidatePool = Math.max(n * 4, 20); // pool folga sobre topK
        break;
      }
      case '--no-lexical':
        overrides.useLexical = false;
        break;
      case '--lexical':
        overrides.useLexical = true;
        break;
      default:
        positional.push(arg);
    }
  }

  return { overrides, positional };
}

// ---------------------------------------------------------------------------
// Providers e router, com erros acionáveis
// ---------------------------------------------------------------------------

/**
 * Opções do provider local. Padrão do projeto: MiniLM multilíngue rodando
 * OFFLINE da pasta `models/paraphrase-multilingual-MiniLM-L12-v2` (simétrico,
 * 384d, sem prefixos). `ROUTER_MODEL` troca o preset:
 *   - `minilm` (padrão): offline, da pasta local, sem rede.
 *   - `e5`: E5-base assimétrico 768d, baixado do Hub na 1ª vez.
 *   - qualquer outra string: tratada como `repo_id` cru (usa os defaults do
 *     provider — cuidado: dims/pooling/prefixos podem não bater com o modelo).
 * `ROUTER_DTYPE` sobrepõe a precisão dos pesos.
 */
export interface ModelChoice {
  embedding: EmbeddingOptions;
  /**
   * Limiar de abstenção calibrado para a ESCALA DE COSSENO deste modelo. Os
   * cossenos do E5 (assimétrico) e do MiniLM (paraphrase, simétrico) vivem em
   * faixas diferentes, então um limiar único abstém demais ou de menos. Valores
   * obtidos por índice de Youden sobre o dataset (em-escopo vs hard negatives):
   * MiniLM ~0.58, E5 ~0.72.
   */
  abstainThreshold: number;
  /** Rótulo legível para logs. */
  label: string;
}

/** Resolve o modelo ativo (via `ROUTER_MODEL`) e sua calibração de abstenção. */
export function resolveModelChoice(): ModelChoice {
  const choice = (process.env.ROUTER_MODEL ?? 'minilm').trim();
  let mc: ModelChoice;

  if (choice === 'minilm') {
    // Offline: nome da pasta dentro de MODELS_DIR (não o repo_id do Hub).
    mc = {
      embedding: {
        kind: 'local',
        ...MODEL_PRESETS.minilm,
        model: 'paraphrase-multilingual-MiniLM-L12-v2',
        localModelPath: MODELS_DIR,
      },
      abstainThreshold: 0.58,
      label: 'minilm (offline, 384d)',
    };
  } else if (choice === 'e5') {
    mc = { embedding: { kind: 'local', ...MODEL_PRESETS.e5 }, abstainThreshold: 0.72, label: 'e5-base (768d)' };
  } else {
    // Modelo cru: sem calibração conhecida, herda o default da lib (0.72).
    mc = { embedding: { kind: 'local', model: choice }, abstainThreshold: 0.72, label: choice };
  }

  if (process.env.ROUTER_DTYPE) {
    (mc.embedding as LocalEmbeddingOptions).dtype =
      process.env.ROUTER_DTYPE as LocalEmbeddingOptions['dtype'];
  }
  return mc;
}

/** Cria o provider de embedding, traduzindo falhas de download/modelo em dicas. */
export async function createProviderOrDie(
  embedding: EmbeddingOptions = resolveModelChoice().embedding,
): Promise<EmbeddingProvider> {
  try {
    return await createEmbeddingProvider(embedding);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      `não foi possível carregar o modelo de embedding: ${msg}`,
      `Padrão: MiniLM offline de ${MODELS_DIR}/paraphrase-multilingual-MiniLM-L12-v2 (384d, fp32). ` +
        'Confirme que a pasta tem onnx/model.onnx + tokenizer.json + config.json. ' +
        'ROUTER_MODEL=e5 usa o E5-base (baixa do Hub na 1ª vez). ROUTER_MODELS_DIR aponta outra raiz.',
    );
  }
}

export interface RouterBundle {
  router: IntentRouter;
  embedder: EmbeddingProvider;
  /** Config efetiva (defaults + overrides). */
  config: RouterConfig;
  cacheDir: string;
  /** `true` se o cache de índice já existia no disco antes de criar o router. */
  cacheWasWarm: boolean;
}

/**
 * Monta um IntentRouter pronto: cria o provider de embedding e deixa o router
 * construir/carregar o índice a partir de `cacheDir`.
 *
 * `announceCache` (default true) emite um aviso acionável quando o cache está
 * frio — o router vai construir o índice em memória, o que é lento na 1ª vez.
 */
export async function bootstrapRouter(
  overrides: Partial<RouterConfig> = {},
  announceCache = true,
): Promise<RouterBundle> {
  const choice = resolveModelChoice();
  // O limiar de abstenção é específico do modelo (escala de cosseno). Injeta o
  // calibrado, a menos que o chamador tenha pedido um valor explícito.
  const effectiveOverrides: Partial<RouterConfig> =
    overrides.abstainThreshold === undefined
      ? { ...overrides, abstainThreshold: choice.abstainThreshold }
      : overrides;
  const config = resolveConfig(effectiveOverrides);
  const cacheDir = DEFAULT_CACHE_DIR;
  const cacheWasWarm = await pathExists(cacheDir);

  if (announceCache && !cacheWasWarm) {
    console.error(
      yellow('índice ausente em cache — construindo em memória (pode levar alguns segundos).'),
    );
    console.error(dim(`Para cachear em disco e acelerar execuções futuras: npm run index:build`));
  }

  const embedder = await createProviderOrDie(choice.embedding);

  const router = await IntentRouter.create({
    catalog,
    embedder,
    config: effectiveOverrides,
    cacheDir,
  });

  return { router, embedder, config, cacheDir, cacheWasWarm };
}

// ---------------------------------------------------------------------------
// Validação de catálogo (compartilhada por build-index e eval)
// ---------------------------------------------------------------------------

/** Aborta com código 1 e lista os problemas se o catálogo estiver malformado. */
export function assertCatalogValid(c: Catalog = catalog): void {
  const problems = validateCatalog(c);
  if (problems.length > 0) {
    console.error(red(`catálogo inválido — ${problems.length} problema(s):`));
    for (const p of problems) console.error('  • ' + p);
    process.exit(1);
  }
}

export { catalog };
export type { RouteResult, RouterConfig };
