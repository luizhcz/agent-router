/**
 * `npm run router` — REPL interativo de roteamento.
 *
 * Lê uma consulta, roteia e imprime via `explainRoute`. Comandos internos:
 *   /config              mostra a config ativa
 *   /set <chave> <valor> altera a config em memória (aplicada como override)
 *   /tools               mostra o JSON de tools que iria para a LLM
 *   /help                lista os comandos
 *   /quit                sai
 *
 * Modo não-interativo: qualquer consulta passada por argv é roteada uma vez e o
 * processo encerra (útil para scripts). Flags: --top-k, --no-lexical.
 */
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { explainRoute, toToolSchemas, commandToToolSchema } from '../llm/index.js';
import { IntentRouter, resolveConfig } from '../router/index.js';
import type { RouteResult, RouterConfig, ToolSchema } from '../types.js';

import {
  DEFAULT_CACHE_DIR,
  parseCommonFlags,
  createProviderOrDie,
  pathExists,
  catalog,
  bold,
  cyan,
  dim,
  green,
  red,
  yellow,
  fail,
} from './shared.js';

const CONFIG_KEYS = [
  'topK',
  'candidatePool',
  'useLexical',
  'maxPerAgent',
  'abstainThreshold',
  'fusion.kind',
  'fusion.k',
] as const;

interface Session {
  router: IntentRouter;
  config: RouterConfig;
  lastResult?: RouteResult;
}

async function route(session: Session, query: string): Promise<void> {
  try {
    const result = await session.router.route(query, session.config);
    session.lastResult = result;
    console.log(explainRoute(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red('falha no roteamento: ') + msg);
  }
}

function parseBool(v: string): boolean | undefined {
  if (['true', 'on', '1', 'yes', 'sim'].includes(v)) return true;
  if (['false', 'off', '0', 'no', 'nao', 'não'].includes(v)) return false;
  return undefined;
}

/** Aplica `/set <chave> <valor>` sobre a config. Retorna mensagem de erro ou null. */
function applySet(config: RouterConfig, key: string, rawValue: string): string | null {
  switch (key) {
    case 'topK':
    case 'candidatePool':
    case 'maxPerAgent': {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 0) return `valor inválido para ${key}: ${rawValue}`;
      config[key] = n;
      return null;
    }
    case 'abstainThreshold': {
      const n = Number(rawValue);
      if (Number.isNaN(n)) return `valor inválido para ${key}: ${rawValue}`;
      config.abstainThreshold = n;
      return null;
    }
    case 'useLexical': {
      const b = parseBool(rawValue);
      if (b === undefined) return `valor booleano inválido para ${key}: ${rawValue}`;
      config[key] = b;
      return null;
    }
    case 'fusion.kind': {
      if (rawValue !== 'rrf' && rawValue !== 'weighted') return 'fusion.kind deve ser rrf|weighted';
      config.fusion =
        rawValue === 'rrf'
          ? { kind: 'rrf', k: 60 }
          : { kind: 'weighted', denseWeight: 0.6, lexicalWeight: 0.4 };
      return null;
    }
    case 'fusion.k': {
      if (config.fusion.kind !== 'rrf') return 'fusion.k só se aplica quando fusion.kind=rrf';
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n <= 0) return `valor inválido para fusion.k: ${rawValue}`;
      config.fusion = { kind: 'rrf', k: n };
      return null;
    }
    default:
      return `chave desconhecida: ${key}\nchaves: ${CONFIG_KEYS.join(', ')}`;
  }
}

function readKey(config: RouterConfig, key: string): unknown {
  if (key === 'fusion.kind') return config.fusion.kind;
  if (key === 'fusion.k') return config.fusion.kind === 'rrf' ? config.fusion.k : undefined;
  return (config as unknown as Record<string, unknown>)[key];
}

function printConfig(config: RouterConfig): void {
  console.log(bold('config ativa'));
  console.log(dim(JSON.stringify(config, null, 2)));
}

function printTools(session: Session): void {
  // As tools que de fato iriam para a LLM: os comandos do último top-K, ou o
  // catálogo inteiro se ainda não houve consulta.
  let schemas: ToolSchema[];
  if (session.lastResult && session.lastResult.candidates.length > 0) {
    schemas = toToolSchemas(session.lastResult.candidates);
    console.error(dim(`(${schemas.length} tools do último roteamento)`));
  } else {
    schemas = catalog.commands.map(commandToToolSchema);
    console.error(dim(`(catálogo inteiro — ${schemas.length} tools; rode uma consulta para reduzir)`));
  }
  console.log(JSON.stringify(schemas, null, 2));
}

function printHelp(): void {
  console.log(bold('comandos'));
  console.log('  ' + cyan('/config') + '               mostra a config ativa');
  console.log('  ' + cyan('/set <chave> <valor>') + '  altera a config em memória');
  console.log('  ' + cyan('/tools') + '                JSON de tools que iria para a LLM');
  console.log('  ' + cyan('/help') + '                 esta ajuda');
  console.log('  ' + cyan('/quit') + '                 sai');
  console.log(dim('  chaves de /set: ' + CONFIG_KEYS.join(', ')));
  console.log(dim('  qualquer outra linha é tratada como consulta a rotear.'));
}

/** Retorna `true` para sinalizar saída do REPL. */
async function handleCommand(session: Session, line: string): Promise<boolean> {
  const parts = line.trim().slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case 'quit':
    case 'exit':
    case 'q':
      return true;
    case 'config':
      printConfig(session.config);
      return false;
    case 'tools':
      printTools(session);
      return false;
    case 'help':
    case '?':
      printHelp();
      return false;
    case 'set': {
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      if (!key || value === '') {
        console.error(red('uso: ') + '/set <chave> <valor>');
        console.error(dim('chaves: ' + CONFIG_KEYS.join(', ')));
        return false;
      }
      const errMsg = applySet(session.config, key, value);
      if (errMsg) {
        console.error(red(errMsg));
        return false;
      }
      console.log(green('ok. ') + dim(`${key} = ${JSON.stringify(readKey(session.config, key))}`));
      return false;
    }
    default:
      console.error(red(`comando desconhecido: /${cmd}`) + dim('  (/help)'));
      return false;
  }
}

async function main(): Promise<void> {
  const { overrides, positional } = parseCommonFlags(process.argv.slice(2));
  const config = resolveConfig(overrides);
  const cacheDir = DEFAULT_CACHE_DIR;

  if (!(await pathExists(cacheDir))) {
    console.error(yellow('índice ausente em cache — construindo em memória (pode demorar na 1ª vez).'));
    console.error(dim('Para cachear em disco: npm run index:build'));
  }

  console.error(dim('carregando provider e índice…'));
  const embedder = await createProviderOrDie();

  const session: Session = {
    router: await IntentRouter.create({ catalog, embedder, config, cacheDir }),
    config,
  };

  // Modo não-interativo: consulta única via argv.
  if (positional.length > 0) {
    await route(session, positional.join(' '));
    await embedder.dispose?.();
    return;
  }

  // Modo interativo.
  console.error(
    green('roteador pronto.') +
      dim(
        ` ${catalog.commands.length} comandos · topK=${config.topK} · lexical=${config.useLexical}`,
      ),
  );
  console.error(dim('digite uma consulta ou /help. Ctrl-D para sair.'));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const prompt = () => (stdout.isTTY ? cyan('› ') : '');

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question(prompt());
      } catch {
        break; // EOF (Ctrl-D) ou stream fechado
      }
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('/')) {
        const shouldQuit = await handleCommand(session, trimmed);
        if (shouldQuit) break;
        continue;
      }
      await route(session, trimmed);
    }
  } finally {
    rl.close();
    await embedder.dispose?.();
  }
  console.error(dim('até logo.'));
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
