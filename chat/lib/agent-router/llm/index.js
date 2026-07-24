/**
 * Camada de saída para a LLM: converte o top-K do roteador no payload de tools.
 *
 * Sem chamadas de API e sem dependência do SDK da Anthropic — este módulo só monta
 * `{ tools, tool_choice, system }` pronto para `client.messages.create`.
 */
export * from './tools.js';
export * from './prompt.js';
export * from './explain.js';
//# sourceMappingURL=index.js.map