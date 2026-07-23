import { describe, it, expect } from 'vitest';
import { capPerAgent } from '../src/router/diversify.js';
import type { Catalog, CommandDef } from '../src/types.js';

function cmd(id: string, agent: CommandDef['agent']): CommandDef {
  return {
    id,
    agent,
    name: id,
    description: 'x',
    utterances: [],
    keywords: [],
    params: [],
  };
}

const catalog: Catalog = {
  agents: [
    { id: 'risk', name: 'Risk', description: '' },
    { id: 'trader', name: 'Trader', description: '' },
  ],
  commands: [
    cmd('risk.a1', 'risk'),
    cmd('risk.a2', 'risk'),
    cmd('risk.a3', 'risk'),
    cmd('trader.b1', 'trader'),
    cmd('trader.b2', 'trader'),
  ],
};

// Ordem de entrada = ordem por score desc.
const input = [
  { commandId: 'risk.a1', score: 5 },
  { commandId: 'risk.a2', score: 4 },
  { commandId: 'trader.b1', score: 3 },
  { commandId: 'risk.a3', score: 2 },
  { commandId: 'trader.b2', score: 1 },
];

describe('capPerAgent', () => {
  it('respeita o teto, preserva ordem relativa e promove os de baixo', () => {
    const out = capPerAgent(input, 1, catalog);
    // teto 1 por agente: sobra o 1º de cada agente; trader.b1 (pos 3) sobe para pos 2
    expect(out.map((x) => x.commandId)).toEqual(['risk.a1', 'trader.b1']);
  });

  it('teto 2 mantém a ordem relativa e corta só o excedente', () => {
    const out = capPerAgent(input, 2, catalog);
    expect(out.map((x) => x.commandId)).toEqual([
      'risk.a1',
      'risk.a2',
      'trader.b1',
      'trader.b2',
    ]);
  });

  it('maxPerAgent = 0 é no-op', () => {
    const out = capPerAgent(input, 0, catalog);
    expect(out).toEqual(input);
  });

  it('teto maior que a lista é no-op', () => {
    const out = capPerAgent(input, 10, catalog);
    expect(out.map((x) => x.commandId)).toEqual(input.map((x) => x.commandId));
  });
});
