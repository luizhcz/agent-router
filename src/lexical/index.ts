/** Barrel do módulo lexical (BM25 pt-BR / multilíngue, sem dependências). */

export {
  normalizeText,
  tokenize,
  charNgrams,
  lightStem,
  isStopword,
  STOPWORDS,
  STOPWORDS_PT,
  STOPWORDS_EN,
  STOPWORDS_ES,
} from './tokenize.js';
export type { TokenizeOptions } from './tokenize.js';

export { Bm25Index } from './bm25.js';
export type { Bm25Doc, Bm25Options, Bm25Result } from './bm25.js';
