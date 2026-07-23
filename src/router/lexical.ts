/**
 * Índice lexical BM25 para o estágio 1 (recupera siglas/tickers que o denso
 * dilui). Segue o Brief §6:
 * - lowercase + strip-accents sempre;
 * - dois campos: palavras (stopwords mínimas) e char 3-grams (tolerância a typo);
 * - sem stemming (code-switching pt/en/es gera stems-lixo);
 * - keywords entram sem remoção de stopword e com peso extra (duplicadas).
 *
 * O score lexical de um comando é `BM25_palavras + BM25_char3gram`.
 */
import type { Catalog } from '../types.js';
import type { ScoredItem } from './fusion.js';

/** Lista mínima (~30 termos): artigos/preposições/conjunções mais comuns pt/en/es. */
const STOPWORDS = new Set<string>([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'e', 'ou', 'que', 'para', 'por', 'com', 'sem',
  'ao', 'aos', 'se', 'the', 'of', 'to', 'and', 'la', 'el', 'los', 'las', 'del', 'y',
]);

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function wordTokens(text: string): string[] {
  return stripAccents(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function filterStopwords(tokens: string[]): string[] {
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/** Char n-grams por palavra (sem cruzar fronteira de palavra); palavras curtas entram inteiras. */
function charNgrams(text: string, n: number): string[] {
  const words = stripAccents(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const grams: string[] = [];
  for (const w of words) {
    if (w.length <= n) {
      grams.push(w);
      continue;
    }
    for (let i = 0; i + n <= w.length; i++) grams.push(w.slice(i, i + n));
  }
  return grams;
}

/** BM25 clássico (Okapi) sobre documentos já tokenizados. */
class BM25 {
  private readonly tf: Map<string, number>[] = [];
  private readonly df = new Map<string, number>();
  private readonly lengths: number[] = [];
  private readonly avg: number;
  private readonly n: number;

  constructor(
    docs: string[][],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    this.n = docs.length;
    let total = 0;
    for (const toks of docs) {
      const counts = new Map<string, number>();
      for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(counts);
      this.lengths.push(toks.length);
      total += toks.length;
    }
    this.avg = this.n > 0 ? total / this.n : 0;
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  scoreDoc(i: number, queryTerms: string[]): number {
    const counts = this.tf[i];
    if (!counts) return 0;
    const len = this.lengths[i] ?? 0;
    const avg = this.avg || 1;
    let s = 0;
    for (const q of queryTerms) {
      const f = counts.get(q);
      if (!f) continue;
      s += this.idf(q) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / avg)));
    }
    return s;
  }
}

export interface LexicalIndex {
  /** Devolve comandos com score lexical > 0, ordenados desc. */
  search(query: string): ScoredItem[];
}

/**
 * Constrói o índice lexical em memória (barato para ~50 comandos; não é
 * persistido). Campo de palavras: nome + utterances (com stopwords filtradas) +
 * keywords (duplicadas, sem filtro). Campo char: nome + utterances + keywords.
 */
export function buildLexicalIndex(catalog: Catalog): LexicalIndex {
  const ids = catalog.commands.map((c) => c.id);
  const wordDocs: string[][] = [];
  const charDocs: string[][] = [];

  for (const cmd of catalog.commands) {
    const words: string[] = [...filterStopwords(wordTokens(cmd.name))];
    for (const u of cmd.utterances) words.push(...filterStopwords(wordTokens(u)));
    for (const kw of cmd.keywords) {
      const t = wordTokens(kw);
      words.push(...t, ...t); // peso extra: siglas/tickers entram em dobro, sem filtro de stopword
    }
    wordDocs.push(words);

    const charSrc = [cmd.name, ...cmd.utterances, ...cmd.keywords].join(' ');
    charDocs.push(charNgrams(charSrc, 3));
  }

  const wordBm = new BM25(wordDocs);
  const charBm = new BM25(charDocs);

  return {
    search(query: string): ScoredItem[] {
      const qWords = filterStopwords(wordTokens(query));
      const qChars = charNgrams(query, 3);
      const out: ScoredItem[] = [];
      for (const [i, id] of ids.entries()) {
        const score = wordBm.scoreDoc(i, qWords) + charBm.scoreDoc(i, qChars);
        if (score > 0) out.push({ commandId: id, score });
      }
      out.sort((a, b) => b.score - a.score);
      return out;
    },
  };
}
