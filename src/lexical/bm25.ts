/**
 * BM25 do zero, sem dependências.
 *
 * Vários documentos podem compartilhar o mesmo `id` (= commandId): nome, bloco de
 * keywords e cada utterance entram como "field-docs" separados do mesmo comando.
 * O `weight` de cada doc multiplica a contribuição daquele campo (keywords pesam
 * mais que utterances), no espírito de BM25F. O score do comando é a SOMA das
 * contribuições ponderadas de seus field-docs (agregação aditiva por campo, que é
 * o que "o peso multiplica a contribuição do campo" pede); ordena, não tem escala
 * fixa — a normalização é responsabilidade do router.
 *
 * IDF NÃO-NEGATIVO: usamos a variante "Lucene/BM25+ smoothing"
 *   idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
 * O `1 +` interno garante argumento > 1 mesmo quando df = N, então o IDF nunca é
 * negativo — termos muito frequentes contribuem ~0, jamais penalizam.
 *
 * Consulta sem nenhum termo conhecido -> `[]`, nunca NaN.
 */

import { tokenize } from './tokenize.js';

export interface Bm25Doc {
  /** commandId. Repetível: um comando gera vários field-docs. */
  id: string;
  text: string;
  /** Multiplicador da contribuição deste campo. Default 1. */
  weight?: number;
}

export interface Bm25Options {
  /** Saturação de term-frequency. Default 1.2. */
  k1?: number;
  /** Normalização por comprimento. Default 0.75. */
  b?: number;
  /**
   * Tokenizador do índice. Default: `tokenize` (campo de palavras). Passe
   * `charNgrams` para construir o campo BM25 tolerante a typos.
   */
  tokenizer?: (text: string) => string[];
}

export interface Bm25Result {
  commandId: string;
  /** Score bruto de BM25 agregado por comando. */
  score: number;
}

interface Posting {
  docIndex: number;
  /** Frequência do termo neste field-doc. */
  tf: number;
}

export class Bm25Index {
  readonly k1: number;
  readonly b: number;

  private readonly tokenizer: (text: string) => string[];
  private readonly nDocs: number;
  private readonly avgdl: number;
  private readonly docLen: number[];
  private readonly docCommand: string[];
  private readonly docWeight: number[];
  private readonly postings: Map<string, Posting[]>;
  private readonly df: Map<string, number>;

  constructor(docs: Bm25Doc[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.tokenizer = options.tokenizer ?? tokenize;

    this.nDocs = docs.length;
    this.docLen = new Array<number>(this.nDocs).fill(0);
    this.docCommand = new Array<string>(this.nDocs).fill('');
    this.docWeight = new Array<number>(this.nDocs).fill(1);
    this.postings = new Map<string, Posting[]>();
    this.df = new Map<string, number>();

    let totalLen = 0;
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!;
      const toks = this.tokenizer(doc.text);

      this.docCommand[i] = doc.id;
      this.docWeight[i] = doc.weight ?? 1;
      this.docLen[i] = toks.length;
      totalLen += toks.length;

      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);

      for (const [term, freq] of tf) {
        let plist = this.postings.get(term);
        if (!plist) {
          plist = [];
          this.postings.set(term, plist);
        }
        plist.push({ docIndex: i, tf: freq });
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }

    this.avgdl = this.nDocs > 0 ? totalLen / this.nDocs : 0;
  }

  /** Nº de field-docs indexados. */
  get size(): number {
    return this.nDocs;
  }

  /** IDF não-negativo (variante com smoothing; ver cabeçalho). */
  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + (this.nDocs - df + 0.5) / (df + 0.5));
  }

  /** Resultado completo, ordenado por score desc. `[]` se nada casar. */
  searchAll(query: string): Bm25Result[] {
    if (this.nDocs === 0) return [];

    const qtokens = this.tokenizer(query);
    if (qtokens.length === 0) return [];

    const seen = new Set<string>();
    const perCommand = new Map<string, number>();
    let matched = false;

    for (const term of qtokens) {
      if (seen.has(term)) continue; // query-tf ignorado (BM25 padrão)
      seen.add(term);

      const plist = this.postings.get(term);
      if (!plist || plist.length === 0) continue;
      matched = true;

      const idf = this.idf(term);
      for (const p of plist) {
        const dl = this.docLen[p.docIndex]!;
        const denom =
          p.tf + this.k1 * (1 - this.b + this.b * (this.avgdl > 0 ? dl / this.avgdl : 0));
        const contrib = denom > 0 ? (idf * (p.tf * (this.k1 + 1))) / denom : 0;
        const weighted = contrib * this.docWeight[p.docIndex]!;
        const cmd = this.docCommand[p.docIndex]!;
        perCommand.set(cmd, (perCommand.get(cmd) ?? 0) + weighted);
      }
    }

    if (!matched) return [];

    const results: Bm25Result[] = [];
    for (const [commandId, score] of perCommand) results.push({ commandId, score });
    results.sort((a, b) => b.score - a.score || a.commandId.localeCompare(b.commandId));
    return results;
  }

  /** Top-`n` por score. `[]` se nada casar; nunca retorna NaN. */
  search(query: string, n: number): Bm25Result[] {
    const all = this.searchAll(query);
    if (n <= 0) return [];
    return all.slice(0, n);
  }
}
