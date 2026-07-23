// ROUTER — ponte CommonJS → pacote ESM `agent-router` (../../../dist), rodando o
// modelo de embedding MiniLM 100% OFFLINE da pasta ../../../models.
//
// O chat é CommonJS e o pacote do router é ESM (NodeNext); a ponte é um
// `import()` dinâmico dentro de um contexto async. O @huggingface/transformers
// resolve do node_modules do pacote raiz (o dist vive sob ele).

const path = require('path');
const crypto = require('crypto');
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

    // Identificadores para atribuição de KPIs (routing_events): modelo + fingerprint
    // do catálogo (muda quando um comando/utterance é editado).
    this.modelId = 'paraphrase-multilingual-MiniLM-L12-v2';
    this.fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(this.catalog.commands.map((c) => ({ id: c.id, d: c.description, u: c.utterances }))))
      .digest('hex')
      .slice(0, 16);

    // MiniLM simétrico 384d, carregado da pasta local (sem rede).
    const embedder = await createEmbeddingProvider({
      kind: 'local',
      ...MODEL_PRESETS.minilm,
      model: 'paraphrase-multilingual-MiniLM-L12-v2', // nome da pasta em MODELS_DIR
      localModelPath: MODELS_DIR,
    });

    // Configuramos topK/candidatePool = tamanho do catálogo para que route()
    // devolva o RANKING COMPLETO; o corte em top-K (e o filtro por agente da
    // conversa) é aplicado em `route()` abaixo. Sem isso, um chat só-content
    // pegaria apenas os poucos content que sobrassem no top-8 global.
    const n = this.catalog.commands.length;
    this.router = await IntentRouter.create({
      catalog: this.catalog,
      embedder,
      config: { topK: n, candidatePool: n, abstainThreshold: this.abstainThreshold },
      cacheDir: CACHE_DIR,
    });

    this.ready = true;
    return {
      commands: this.catalog.commands.length,
      agents: this.catalog.agents.map((a) => a.id),
    };
  }

  /**
   * Roteia um enunciado do usuário. `opts.agents` (opcional) restringe ao escopo da
   * conversa: pontua o ranking completo, filtra aos agentes habilitados (+ 'system'
   * sempre) e corta em `topK`. Sem `opts.agents`, usa todos os agentes. Devolve
   * `{ methods, agents, abstained, candidates }`; `methods` é a lista (top-K) de
   * métodos para filtrar os comandos que vão à LLM. Router não pronto => `null`
   * (o runtime cai no comportamento sem filtro).
   */
  async route(text, opts = {}) {
    if (!this.ready || !text) return null;
    const res = await this.router.route(text); // ranking completo
    let candidates = res.candidates;
    if (opts.agents && opts.agents.length) {
      const allow = new Set([...opts.agents, 'system']);
      candidates = candidates.filter((c) => allow.has(c.command.agent));
    }
    candidates = candidates.slice(0, this.topK); // top-K efetivo do subconjunto
    return {
      methods: candidates.map((c) => c.command.method),
      agents: [...new Set(candidates.map((c) => c.command.agent))],
      abstained: res.abstained,
      modelId: this.modelId,
      fingerprint: this.fingerprint,
      candidates: candidates.map((c) => ({
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
