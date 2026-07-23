// ROUTER — ponte CommonJS → pacote ESM `agent-router` (../../../dist), rodando o
// modelo de embedding MiniLM 100% OFFLINE da pasta ../../../models.
//
// O chat é CommonJS e o pacote do router é ESM (NodeNext); a ponte é um
// `import()` dinâmico dentro de um contexto async. O @huggingface/transformers
// resolve do node_modules do pacote raiz (o dist vive sob ele).

const path = require('path');
const { pathToFileURL } = require('url');

const { buildCatalog } = require('./catalog-builder');

// Raiz do pacote agent-router (dois níveis acima de chat/src/router).
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ROUTER_DIST = path.join(ROOT, 'dist', 'index.js');
const MODELS_DIR = process.env.ROUTER_MODELS_DIR || path.join(ROOT, 'models');
const CACHE_DIR = process.env.ROUTER_CACHE_DIR || path.join(__dirname, '.cache', 'router-index');

/**
 * Envolve o IntentRouter para o runtime do chat. `initialize(commandElements)`
 * constrói o catálogo a partir dos comandos tagueados, carrega o MiniLM offline
 * e prepara/persiste o índice denso. `route(text)` devolve os candidatos top-K.
 */
class ChatIntentRouter {
  constructor(opts = {}) {
    this.topK = opts.topK || 8;
    this.abstainThreshold = opts.abstainThreshold != null ? opts.abstainThreshold : 0.58; // escala MiniLM
    this.ready = false;
  }

  async initialize(commandElements) {
    const mod = await import(pathToFileURL(ROUTER_DIST).href);
    const { IntentRouter, createEmbeddingProvider, MODEL_PRESETS } = mod;

    this.catalog = buildCatalog(commandElements);

    // MiniLM simétrico 384d, carregado da pasta local (sem rede).
    const embedder = await createEmbeddingProvider({
      kind: 'local',
      ...MODEL_PRESETS.minilm,
      model: 'paraphrase-multilingual-MiniLM-L12-v2', // nome da pasta em MODELS_DIR
      localModelPath: MODELS_DIR,
    });

    this.router = await IntentRouter.create({
      catalog: this.catalog,
      embedder,
      config: { topK: this.topK, abstainThreshold: this.abstainThreshold },
      cacheDir: CACHE_DIR,
    });

    this.ready = true;
    return {
      commands: this.catalog.commands.length,
      agents: this.catalog.agents.map((a) => a.id),
    };
  }

  /**
   * Roteia um enunciado do usuário. Devolve `{ methods, agents, abstained, candidates }`
   * onde `methods` é a lista (top-K) de nomes de método para filtrar os comandos
   * que vão à LLM. Se o router não estiver pronto, devolve `null` (o runtime cai
   * no comportamento sem filtro).
   */
  async route(text) {
    if (!this.ready || !text) return null;
    const res = await this.router.route(text);
    return {
      methods: res.candidates.map((c) => c.command.method),
      agents: [...new Set(res.candidates.map((c) => c.command.agent))],
      abstained: res.abstained,
      candidates: res.candidates.map((c) => ({
        method: c.command.method,
        agent: c.command.agent,
        score: c.score,
      })),
      timings: res.timings,
    };
  }

  async dispose() {
    if (this.router) await this.router.dispose();
    this.ready = false;
  }
}

module.exports = { ChatIntentRouter, MODELS_DIR, ROUTER_DIST };
