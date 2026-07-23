import { describe, it, expect } from 'vitest';
import { IntentRouter } from '../src/router/router.js';
import { resolveConfig } from '../src/router/config.js';
import type { Catalog, CommandDef, EmbeddingProvider, Vector } from '../src/types.js';

// ---------------------------------------------------------------------------
// EmbeddingProvider FALSO e determinístico: bag-of-tokens com hashing para um
// vetor pequeno, componentes não-negativos e L2-normalizado. Sem rede, sem
// modelo. Query e documento usam a mesma rota (simétrico) -> cosseno em [0, 1].
// ---------------------------------------------------------------------------
const DIM = 32;

function tokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % DIM;
}

function embed(text: string): Vector {
  const v = new Float32Array(DIM);
  for (const t of tokens(text)) v[hash(t)]! += 1;
  let norm = 0;
  for (let d = 0; d < DIM; d++) norm += v[d]! * v[d]!;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < DIM; d++) v[d]! = v[d]! / norm;
  return v;
}

const fakeEmbedder: EmbeddingProvider = {
  id: 'fake-hash-32',
  dimensions: DIM,
  asymmetric: false,
  async embedQueries(texts) {
    return texts.map(embed);
  },
  async embedDocuments(texts) {
    return texts.map(embed);
  },
};

function cmd(
  id: string,
  agent: CommandDef['agent'],
  name: string,
  description: string,
  utterances: string[],
  keywords: string[],
): CommandDef {
  return { id, agent, name, description, utterances, keywords, params: [] };
}

const catalog: Catalog = {
  agents: [
    { id: 'risk', name: 'Risk', description: 'risco' },
    { id: 'trader', name: 'Trader', description: 'mesa' },
  ],
  commands: [
    cmd('risk.var', 'risk', 'Calcular VaR', 'calcula o value at risk da carteira', [
      'calcular o var da carteira',
      'qual o value at risk hoje',
      'risco de mercado da carteira',
    ], ['VaR', 'value at risk', 'carteira']),
    cmd('risk.stress', 'risk', 'Teste de estresse', 'roda cenarios de estresse na carteira', [
      'rodar teste de estresse',
      'cenario de estresse da carteira',
      'simular choque de mercado',
    ], ['estresse', 'stress test', 'cenario']),
    cmd('risk.limits', 'risk', 'Checar limites', 'verifica limites de risco da mesa', [
      'checar os limites de risco',
      'estamos dentro do limite',
      'consumo de limite atual',
    ], ['limite', 'limits', 'exposicao']),
    cmd('trader.buy', 'trader', 'Comprar ativo', 'envia ordem de compra de um ativo', [
      'comprar acoes da petr4',
      'enviar ordem de compra',
      'quero comprar um ativo',
    ], ['comprar', 'ordem', 'PETR4']),
    cmd('trader.sell', 'trader', 'Vender ativo', 'envia ordem de venda de um ativo', [
      'vender acoes da vale',
      'enviar ordem de venda',
      'quero vender um ativo',
    ], ['vender', 'ordem', 'VALE3']),
    cmd('trader.quote', 'trader', 'Cotacao', 'consulta a cotacao de um ativo', [
      'qual a cotacao da petr4',
      'preco atual do ativo',
      'me da a cotacao agora',
    ], ['cotacao', 'preco', 'quote']),
  ],
};

async function buildRouter(config?: Parameters<typeof IntentRouter.create>[0]['config']) {
  return IntentRouter.create({ catalog, embedder: fakeEmbedder, config });
}

describe('IntentRouter (unit, embedder falso)', () => {
  it('candidates.length <= topK e ordenados por score desc', async () => {
    const router = await buildRouter({ topK: 3, candidatePool: 6 });
    const res = await router.route('calcular o var da carteira');
    expect(res.candidates.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < res.candidates.length; i++) {
      expect(res.candidates[i - 1]!.score).toBeGreaterThanOrEqual(res.candidates[i]!.score);
    }
    expect(res.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('abstained liga abaixo do limiar E os candidatos continuam presentes', async () => {
    const router = await buildRouter({ topK: 3, candidatePool: 6, abstainThreshold: 1 });
    // limiar = 1.0: a menos que a query seja idêntica a um vetor, best-dense < 1 -> abstém
    const res = await router.route('quero entender algo sobre risco de mercado agora');
    expect(res.abstained).toBe(true);
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it('abstained desliga acima do limiar, candidatos presentes', async () => {
    const router = await buildRouter({ topK: 3, candidatePool: 6, abstainThreshold: 0 });
    const res = await router.route('calcular o var da carteira');
    expect(res.abstained).toBe(false);
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it('resolveConfig rejeita candidatePool < topK', () => {
    expect(() => resolveConfig({ topK: 5, candidatePool: 3 })).toThrow();
  });
});
