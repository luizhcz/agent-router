import { describe, it, expect } from 'vitest';
import {
  reciprocalRankFusion,
  weightedFusion,
  minMaxNormalize,
  type ScoredItem,
} from '../src/router/fusion.js';

const s = (id: string, score: number): ScoredItem => ({ commandId: id, score });

describe('reciprocalRankFusion', () => {
  it('dá a ordem esperada calculada à mão', () => {
    const k = 60;
    const listA: ScoredItem[] = [s('x1', 3), s('x2', 2), s('x3', 1)];
    const listB: ScoredItem[] = [s('x2', 3), s('x3', 2), s('x1', 1)];
    // x1 = 1/61 + 1/63 = 0.032266
    // x2 = 1/62 + 1/61 = 0.032522  (maior)
    // x3 = 1/63 + 1/62 = 0.032002  (menor)
    const fused = reciprocalRankFusion([listA, listB], k);
    expect(fused.map((f) => f.commandId)).toEqual(['x2', 'x1', 'x3']);

    const byId = new Map(fused.map((f) => [f.commandId, f.score]));
    expect(byId.get('x1')!).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(byId.get('x2')!).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(byId.get('x3')!).toBeCloseTo(1 / 63 + 1 / 62, 10);
  });

  it('um item bem posicionado nas DUAS listas supera um item ótimo em apenas uma', () => {
    const k = 60;
    const listA: ScoredItem[] = [s('solo', 5), s('good', 4)];
    const listB: ScoredItem[] = [s('other', 5), s('good', 4)];
    // good = 1/62 + 1/62 = 2/62 = 0.032258
    // solo = 1/61 = 0.016393
    const fused = reciprocalRankFusion([listA, listB], k);
    expect(fused[0]!.commandId).toBe('good');
    const byId = new Map(fused.map((f) => [f.commandId, f.score]));
    expect(byId.get('good')!).toBeGreaterThan(byId.get('solo')!);
  });
});

describe('minMaxNormalize', () => {
  it('com todos os valores iguais não produz NaN (devolve 1 para todos)', () => {
    const out = minMaxNormalize([7, 7, 7]);
    expect(out).toEqual([1, 1, 1]);
    for (const v of out) expect(Number.isNaN(v)).toBe(false);
  });

  it('mapeia min->0 e max->1', () => {
    expect(minMaxNormalize([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it('lista vazia -> []', () => {
    expect(minMaxNormalize([])).toEqual([]);
  });
});

describe('weightedFusion', () => {
  it('respeita os pesos (peso maior na 1ª lista favorece "a")', () => {
    const listA: ScoredItem[] = [s('a', 1), s('b', 0)]; // norm -> a=1, b=0
    const listB: ScoredItem[] = [s('a', 0), s('b', 1)]; // norm -> a=0, b=1

    const favorA = weightedFusion([listA, listB], [2, 1]);
    expect(favorA[0]!.commandId).toBe('a');
    const a1 = new Map(favorA.map((f) => [f.commandId, f.score]));
    expect(a1.get('a')!).toBeCloseTo(2, 10);
    expect(a1.get('b')!).toBeCloseTo(1, 10);

    const favorB = weightedFusion([listA, listB], [1, 2]);
    expect(favorB[0]!.commandId).toBe('b');
    const b1 = new Map(favorB.map((f) => [f.commandId, f.score]));
    expect(b1.get('a')!).toBeCloseTo(1, 10);
    expect(b1.get('b')!).toBeCloseTo(2, 10);
  });

  it('peso 0 ignora a lista por completo', () => {
    const listA: ScoredItem[] = [s('a', 1), s('b', 0)];
    const listB: ScoredItem[] = [s('c', 1), s('d', 0)];
    const fused = weightedFusion([listA, listB], [1, 0]);
    expect(fused.map((f) => f.commandId).sort()).toEqual(['a', 'b']);
  });
});
