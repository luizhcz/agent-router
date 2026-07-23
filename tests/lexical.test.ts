import { describe, it, expect } from 'vitest';
import { normalizeText, tokenize } from '../src/lexical/tokenize.js';
import { Bm25Index } from '../src/lexical/bm25.js';

describe('normalizeText', () => {
  it('remove acentos: "ações" -> "acoes"', () => {
    expect(normalizeText('ações')).toBe('acoes');
  });

  it('minúsculas + colapso de pontuação', () => {
    expect(normalizeText('Cálculo, do VaR!')).toBe('calculo do var');
  });
});

describe('tokenize preserva siglas e tickers como tokens inteiros', () => {
  const cases: Array<[string, string]> = [
    ['PETR4', 'petr4'],
    ['VaR', 'var'],
    ['IPO', 'ipo'],
    ['CVM', 'cvm'],
    ['DV01', 'dv01'],
  ];

  for (const [raw, expected] of cases) {
    it(`${raw} vira um único token "${expected}"`, () => {
      const toks = tokenize(raw);
      expect(toks).toEqual([expected]);
    });
  }

  it('mantém siglas inteiras dentro de uma frase e não as remove como stopword', () => {
    const toks = tokenize('calcular o VaR e o DV01 da PETR4');
    expect(toks).toContain('var');
    expect(toks).toContain('dv01');
    expect(toks).toContain('petr4');
    // nenhuma sigla foi quebrada em pedaços
    expect(toks).not.toContain('petr');
    expect(toks).not.toContain('01');
  });
});

describe('Bm25Index', () => {
  it('devolve [] para consulta sem termos conhecidos e nunca NaN', () => {
    const idx = new Bm25Index([
      { id: 'a', text: 'calcular var da carteira' },
      { id: 'b', text: 'gerar relatorio de risco' },
    ]);
    expect(idx.searchAll('xyzinexistentekkk')).toEqual([]);

    const res = idx.searchAll('calcular var');
    for (const r of res) expect(Number.isNaN(r.score)).toBe(false);
  });

  it('um documento com o termo raro pontua acima de um com termo comum', () => {
    const docs = [
      { id: 'raro', text: 'zebra comum' },
      { id: 'comum', text: 'comum coisa' },
      { id: 'f1', text: 'comum coisa' },
      { id: 'f2', text: 'comum outra' },
      { id: 'f3', text: 'comum mais' },
    ];
    const idx = new Bm25Index(docs);
    const res = idx.searchAll('zebra comum');
    const byId = new Map(res.map((r) => [r.commandId, r.score]));
    // 'zebra' é raro (df=1), 'comum' é comum (df alto): idf(zebra) >> idf(comum)
    expect(byId.get('raro')!).toBeGreaterThan(byId.get('comum')!);
  });

  it('scores em ordem decrescente', () => {
    const idx = new Bm25Index([
      { id: 'a', text: 'var var var carteira' },
      { id: 'b', text: 'var carteira' },
      { id: 'c', text: 'outra coisa' },
    ]);
    const res = idx.searchAll('var');
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
    }
  });

  it('agrega por commandId: vários field-docs do mesmo comando somam num único resultado', () => {
    const idx = new Bm25Index([
      { id: 'x', text: 'var carteira' },
      { id: 'x', text: 'var risco' },
      { id: 'y', text: 'var isolado' },
    ]);
    const res = idx.searchAll('var');
    const entriesForX = res.filter((r) => r.commandId === 'x');
    expect(entriesForX).toHaveLength(1);
    // 'x' aparece em dois field-docs contra um de 'y' -> soma maior
    const byId = new Map(res.map((r) => [r.commandId, r.score]));
    expect(byId.get('x')!).toBeGreaterThan(byId.get('y')!);
  });
});
