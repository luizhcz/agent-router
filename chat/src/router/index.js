// ROUTER — superfície pública do módulo de roteamento de intenções do chat.
//
// Reduz os ~46 comandos do catálogo (tagueados por agente: trader/content) a um
// top-K enxuto ANTES da LLM, via embedding MiniLM offline + kNN. Integra em
// agent-runtime.processMessage como pré-filtro do `getPromptIn(context, filter)`.

const { ChatIntentRouter } = require('./intent-router');
const { buildCatalog } = require('./catalog-builder');

module.exports = { ChatIntentRouter, buildCatalog };
