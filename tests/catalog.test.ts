import { describe, it, expect } from 'vitest';
import { catalog, validateCatalog } from '../src/catalog/index.js';

describe('catalog', () => {
  it('valida sem nenhum problema', () => {
    expect(validateCatalog()).toEqual([]);
  });

  it('tem exatamente 4 agentes', () => {
    expect(catalog.agents).toHaveLength(4);
    const ids = catalog.agents.map((a) => a.id).sort();
    expect(ids).toEqual(['content', 'public-offerings', 'risk', 'trader']);
  });

  it('tem pelo menos 48 comandos', () => {
    expect(catalog.commands.length).toBeGreaterThanOrEqual(48);
  });

  it('todo id é único', () => {
    const ids = catalog.commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('todo id começa com o prefixo do seu agente', () => {
    for (const cmd of catalog.commands) {
      expect(cmd.id.startsWith(`${cmd.agent}.`)).toBe(true);
    }
  });

  it('toda utterance é não-vazia e sem duplicata dentro do comando', () => {
    for (const cmd of catalog.commands) {
      expect(cmd.utterances.length).toBeGreaterThanOrEqual(8);
      for (const u of cmd.utterances) {
        expect(u.trim().length).toBeGreaterThan(0);
      }
      expect(new Set(cmd.utterances).size).toBe(cmd.utterances.length);
    }
  });

  it('todo parâmetro enum tem enumValues não-vazio', () => {
    for (const cmd of catalog.commands) {
      for (const p of cmd.params) {
        if (p.type === 'enum') {
          expect(Array.isArray(p.enumValues)).toBe(true);
          expect(p.enumValues!.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
