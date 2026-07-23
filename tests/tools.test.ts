import { describe, it, expect } from 'vitest';
import { catalog } from '../src/catalog/index.js';
import {
  TOOL_NAME_PATTERN,
  commandIdToToolName,
  toolNameToCommandId,
  commandToToolSchema,
  toToolSchemas,
} from '../src/llm/tools.js';
import type { RouteCandidate } from '../src/types.js';

describe('toToolSchemas / mapeamento de nomes', () => {
  it('todos os nomes de tool casam com ^[a-zA-Z0-9_-]{1,64}$', () => {
    for (const cmd of catalog.commands) {
      const name = commandIdToToolName(cmd.id);
      expect(TOOL_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it('ida-e-volta é identidade para TODOS os comandos do catálogo real', () => {
    for (const cmd of catalog.commands) {
      const name = commandIdToToolName(cmd.id);
      expect(toolNameToCommandId(name)).toBe(cmd.id);
    }
  });

  it('required do JSON Schema lista exatamente os params com required: true', () => {
    for (const cmd of catalog.commands) {
      const schema = commandToToolSchema(cmd);
      const expected = cmd.params.filter((p) => p.required).map((p) => p.name).sort();
      expect([...schema.input_schema.required].sort()).toEqual(expected);
    }
  });

  it('params enum viram enum no JSON Schema com os enumValues', () => {
    for (const cmd of catalog.commands) {
      const schema = commandToToolSchema(cmd);
      for (const p of cmd.params) {
        if (p.type === 'enum') {
          const prop = schema.input_schema.properties[p.name] as {
            type: string;
            enum?: string[];
          };
          expect(prop.type).toBe('string');
          expect(prop.enum).toEqual(p.enumValues);
        }
      }
    }
  });

  it('toToolSchemas preserva a ordem dos candidatos', () => {
    const first3 = catalog.commands.slice(0, 3);
    const candidates = first3.map(
      (command, i) =>
        ({
          commandId: command.id,
          command,
          score: 10 - i,
          breakdown: {
            dense: 0,
            lexical: 0,
            ranks: {},
            matchedText: '',
            matchedKind: 'canonical',
          },
        }) as RouteCandidate,
    );
    const schemas = toToolSchemas(candidates);
    expect(schemas.map((s) => toolNameToCommandId(s.name))).toEqual(
      first3.map((c) => c.id),
    );
  });
});
