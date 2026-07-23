/**
 * Montagem do payload final para `client.messages.create`.
 *
 * Puro: não chama a API nem importa o SDK. Produz `{ tools, tool_choice, system }`,
 * incluindo o system prompt que ensina a LLM a interpretar uma lista PRÉ-FILTRADA por
 * um roteador semântico — a intenção certa muito provavelmente está entre as opções,
 * mas não necessariamente em primeiro lugar.
 */

import type { RouteCandidate, RouteResult, ToolSchema } from '../types.js';
import { clarifyTool, commandIdToToolName, toToolSchemas, CLARIFY_TOOL_NAME } from './tools.js';

export interface BuildPromptOptions {
  /** Texto de persona/domínio prefixado ao system prompt. Ex.: "Você é o copiloto de risco...". */
  preamble?: string;
  /** Inclui a lista de candidatos (nome, agente, scores) no corpo do prompt. Padrão `true`. */
  includeCandidateList?: boolean;
  /** Inclui a legenda explicando o que os scores significam. Padrão `true`. */
  explainScores?: boolean;
}

export interface BuildPayloadOptions extends BuildPromptOptions {
  /**
   * `tool_choice` a usar. Padrão `'auto'` — a LLM pode chamar uma tool, pedir
   * esclarecimento ou responder em texto. `'any'` força a chamada de alguma tool.
   */
  toolChoice?: 'auto' | 'any';
  /**
   * Inclui a tool de escape mesmo quando `result.abstained` é `false` (útil para
   * deixar a LLM sinalizar ambiguidade a qualquer momento). Padrão `false`:
   * a tool de escape só entra quando o roteador absteve.
   */
  forceClarifyTool?: boolean;
}

/** Formato pronto para espalhar em `client.messages.create({ ...payload, model, messages })`. */
export interface ToolChoicePayload {
  tools: ToolSchema[];
  tool_choice: { type: 'auto' } | { type: 'any' };
  system: string;
}

const CORE_INSTRUCTIONS = [
  'As ferramentas (tools) abaixo NÃO são o catálogo inteiro: elas foram PRÉ-FILTRADAS por um',
  'roteador semântico a partir de um conjunto muito maior de comandos, com base na similaridade',
  'com o pedido do usuário. Trabalhe sob estas regras:',
  '',
  '- A ferramenta correta está, com ALTA probabilidade, entre as opções apresentadas — mas NÃO',
  '  necessariamente é a primeira. Leia a descrição de TODAS antes de decidir.',
  '- A ordem e os scores refletem apenas a estimativa de similaridade do roteador, que é um sinal',
  '  FRACO. Use-os no máximo como desempate; o conteúdo do pedido e a descrição de cada ferramenta',
  '  têm sempre precedência sobre o número.',
  '- Se NENHUMA ferramenta claramente atende ao pedido, ou se ele está ambíguo entre duas ou mais,',
  '  PREFIRA pedir esclarecimento (ferramenta `' + CLARIFY_TOOL_NAME + '`, quando disponível) a',
  '  escolher no chute. Um esclarecimento custa muito menos que uma ação errada.',
  '- Nunca invente ferramentas ou parâmetros que não estejam na lista.',
].join('\n');

const SCORE_LEGEND = [
  'Como ler os scores de cada ferramenta (sinal fraco, apenas para desempate):',
  '- score: pontuação final do roteador após fusão das listas; escala relativa — só compare',
  '  entre as opções desta lista, nunca em valor absoluto.',
  '- dense: melhor similaridade de cosseno (0..1) entre o pedido e os exemplos do comando.',
  '- lexical: aderência de palavras-chave/siglas (BM25 normalizado, 0..1).',
  'Scores próximos entre si indicam empate: nesse caso decida pelo conteúdo, não pelo número.',
].join('\n');

const ABSTAIN_NOTE = [
  'ATENÇÃO: o roteador NÃO encontrou nenhum candidato acima do piso de confiança (abstenção).',
  'É provável que o pedido esteja fora do escopo destas ferramentas ou mal especificado. Trate',
  '`' + CLARIFY_TOOL_NAME + '` como a opção padrão, a menos que uma das demais claramente sirva.',
].join('\n');

function fmtScore(n: number): string {
  return n.toFixed(4);
}

function renderCandidateLine(candidate: RouteCandidate, showScores: boolean): string {
  const toolName = commandIdToToolName(candidate.commandId);
  const head = `- ${toolName} [${candidate.command.agent}]: ${candidate.command.name}`;
  if (!showScores) return head;
  const b = candidate.breakdown;
  return `${head} (score ${fmtScore(candidate.score)}, dense ${fmtScore(b.dense)}, lexical ${fmtScore(b.lexical)})`;
}

function renderCandidateBlock(result: RouteResult, showScores: boolean): string {
  if (result.candidates.length === 0) {
    return 'Ferramentas disponíveis: (nenhuma) — o roteador não recuperou candidatos.';
  }
  const lines = result.candidates.map((c) => renderCandidateLine(c, showScores));
  return ['Ferramentas disponíveis (pré-filtradas para este pedido):', ...lines].join('\n');
}

/**
 * Constrói o system prompt para a rodada de tool-calling.
 *
 * O prompt sempre traz as instruções centrais; opcionalmente a lista de candidatos com
 * seus scores e a legenda de como interpretá-los. Quando `result.abstained` é `true`,
 * anexa um aviso reforçando a preferência pelo esclarecimento.
 */
export function buildSystemPrompt(result: RouteResult, opts: BuildPromptOptions = {}): string {
  const includeList = opts.includeCandidateList !== false;
  const explainScores = opts.explainScores !== false;

  const parts: string[] = [];
  if (opts.preamble && opts.preamble.trim()) parts.push(opts.preamble.trim());
  parts.push(CORE_INSTRUCTIONS);
  if (result.abstained) parts.push(ABSTAIN_NOTE);
  if (includeList) parts.push(renderCandidateBlock(result, explainScores));
  if (includeList && explainScores && result.candidates.length > 0) parts.push(SCORE_LEGEND);

  return parts.join('\n\n');
}

/**
 * Monta `{ tools, tool_choice, system }` pronto para `client.messages.create`.
 *
 * Inclui a tool de escape `pedir_esclarecimento` quando o roteador absteve
 * (`result.abstained === true`) ou quando `opts.forceClarifyTool` é `true`.
 */
export function buildToolChoicePayload(
  result: RouteResult,
  opts: BuildPayloadOptions = {},
): ToolChoicePayload {
  const tools = toToolSchemas(result.candidates);
  if (result.abstained || opts.forceClarifyTool) tools.push(clarifyTool());

  const tool_choice = { type: opts.toolChoice ?? 'auto' } as ToolChoicePayload['tool_choice'];
  const system = buildSystemPrompt(result, opts);

  return { tools, tool_choice, system };
}
