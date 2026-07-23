/**
 * Conversão do top-K do roteador para o formato de `tools` da API da Anthropic.
 *
 * Este módulo é puro: não chama nenhuma LLM nem depende do SDK. Ele só transforma
 * `CommandDef` em `ToolSchema` (JSON Schema) e cuida do mapeamento de nomes nos dois
 * sentidos — o nome de tool precisa casar com `^[a-zA-Z0-9_-]{1,64}$`, e o id de
 * comando (`<agent>.<snake_case>`) tem ponto, que não é permitido.
 */

import type {
  CommandDef,
  CommandParam,
  RouteCandidate,
  ToolSchema,
} from '../types.js';

/** Nome da tool de escape que a LLM usa quando prefere pedir esclarecimento a chutar. */
export const CLARIFY_TOOL_NAME = 'pedir_esclarecimento';

/** Regex que a API da Anthropic exige para `tool.name`. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Separador reversível para o ponto do id de comando.
 *
 * Ids seguem `<agent>.<snake_case>` — os agentes não usam `_` e a parte do comando
 * usa sempre `_` simples, então `__` (duplo) nunca aparece naturalmente e serve como
 * marca inequívoca do ponto na volta.
 */
const DOT_ESCAPE = '__';

/**
 * `risk.calcular_var` → `risk__calcular_var`.
 *
 * Lança se o resultado não casar com {@link TOOL_NAME_PATTERN} (ex.: id com caractere
 * inesperado ou nome longo demais) — melhor falhar aqui do que a API rejeitar o payload.
 */
export function commandIdToToolName(commandId: string): string {
  const name = commandId.split('.').join(DOT_ESCAPE);
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Não foi possível derivar um nome de tool válido de "${commandId}" ` +
        `(obtido "${name}"; precisa casar com ${TOOL_NAME_PATTERN}).`,
    );
  }
  return name;
}

/**
 * `risk__calcular_var` → `risk.calcular_var`. Inverso exato de
 * {@link commandIdToToolName} para nomes derivados de comandos.
 *
 * O nome de escape ({@link CLARIFY_TOOL_NAME}) não tem `__` e volta inalterado — ele
 * não corresponde a nenhum comando e deve ser tratado como sentinela pelo chamador.
 */
export function toolNameToCommandId(toolName: string): string {
  return toolName.split(DOT_ESCAPE).join('.');
}

/** `true` se o nome é a tool de escape, não um comando roteável. */
export function isClarifyToolName(toolName: string): boolean {
  return toolName === CLARIFY_TOOL_NAME;
}

/**
 * Mapeia um `ParamType` (+ metadados) para o fragmento de JSON Schema da propriedade.
 * A `description` do parâmetro é sempre incluída como `description` do schema.
 */
export function paramToJsonSchema(param: CommandParam): Record<string, unknown> {
  const base: Record<string, unknown> = { description: param.description };

  switch (param.type) {
    case 'string':
      return { type: 'string', ...base };
    case 'number':
      return { type: 'number', ...base };
    case 'boolean':
      return { type: 'boolean', ...base };
    case 'date':
      // JSON Schema não tem tipo "date"; a convenção é string + format 'date' (ISO-8601).
      return { type: 'string', format: 'date', ...base };
    case 'enum':
      // enumValues é garantido pela validação do catálogo; degrada para string livre se ausente.
      return param.enumValues && param.enumValues.length > 0
        ? { type: 'string', enum: [...param.enumValues], ...base }
        : { type: 'string', ...base };
    default: {
      // Exaustividade: se um novo ParamType surgir, o compilador aponta aqui.
      const _never: never = param.type;
      throw new Error(`ParamType não suportado: ${String(_never)}`);
    }
  }
}

/** Converte um único `CommandDef` no `ToolSchema` correspondente. */
export function commandToToolSchema(command: CommandDef): ToolSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of command.params) {
    properties[param.name] = paramToJsonSchema(param);
    if (param.required) required.push(param.name);
  }

  return {
    name: commandIdToToolName(command.id),
    description: `${command.name} — ${command.description}`,
    input_schema: { type: 'object', properties, required },
  };
}

/**
 * Converte o top-K do roteador na lista de tools entregue à LLM.
 *
 * A ordem dos candidatos é preservada (o roteador já ordenou por score), mas a ordem
 * é um sinal fraco — o system prompt instrui a LLM a não tratá-la como decisão.
 */
export function toToolSchemas(candidates: RouteCandidate[]): ToolSchema[] {
  return candidates.map((candidate) => commandToToolSchema(candidate.command));
}

/**
 * Tool de escape: a LLM a invoca quando nenhum comando serve ou o pedido está ambíguo.
 * Incluída no payload quando `result.abstained` é `true` (ver `buildToolChoicePayload`).
 */
export function clarifyTool(): ToolSchema {
  return {
    name: CLARIFY_TOOL_NAME,
    description:
      'Use quando NENHUM dos comandos disponíveis claramente atende ao pedido, ou quando ' +
      'o pedido está ambíguo entre dois ou mais comandos. Pedir esclarecimento é preferível ' +
      'a escolher um comando errado.',
    input_schema: {
      type: 'object',
      properties: {
        pergunta: {
          type: 'string',
          description:
            'Pergunta objetiva, em pt-BR, que ajude o usuário a esclarecer o que ele quer.',
        },
        motivo: {
          type: 'string',
          enum: ['nenhum_comando_adequado', 'ambiguo_entre_comandos', 'faltam_parametros'],
          description: 'Por que o esclarecimento é necessário.',
        },
      },
      required: ['pergunta'],
    },
  };
}
