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
export class Bm25Index {
    k1;
    b;
    tokenizer;
    nDocs;
    avgdl;
    docLen;
    docCommand;
    docWeight;
    postings;
    df;
    constructor(docs, options = {}) {
        this.k1 = options.k1 ?? 1.2;
        this.b = options.b ?? 0.75;
        this.tokenizer = options.tokenizer ?? tokenize;
        this.nDocs = docs.length;
        this.docLen = new Array(this.nDocs).fill(0);
        this.docCommand = new Array(this.nDocs).fill('');
        this.docWeight = new Array(this.nDocs).fill(1);
        this.postings = new Map();
        this.df = new Map();
        let totalLen = 0;
        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            const toks = this.tokenizer(doc.text);
            this.docCommand[i] = doc.id;
            this.docWeight[i] = doc.weight ?? 1;
            this.docLen[i] = toks.length;
            totalLen += toks.length;
            const tf = new Map();
            for (const t of toks)
                tf.set(t, (tf.get(t) ?? 0) + 1);
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
    get size() {
        return this.nDocs;
    }
    /** IDF não-negativo (variante com smoothing; ver cabeçalho). */
    idf(term) {
        const df = this.df.get(term) ?? 0;
        if (df === 0)
            return 0;
        return Math.log(1 + (this.nDocs - df + 0.5) / (df + 0.5));
    }
    /** Resultado completo, ordenado por score desc. `[]` se nada casar. */
    searchAll(query) {
        if (this.nDocs === 0)
            return [];
        const qtokens = this.tokenizer(query);
        if (qtokens.length === 0)
            return [];
        const seen = new Set();
        const perCommand = new Map();
        let matched = false;
        for (const term of qtokens) {
            if (seen.has(term))
                continue; // query-tf ignorado (BM25 padrão)
            seen.add(term);
            const plist = this.postings.get(term);
            if (!plist || plist.length === 0)
                continue;
            matched = true;
            const idf = this.idf(term);
            for (const p of plist) {
                const dl = this.docLen[p.docIndex];
                const denom = p.tf + this.k1 * (1 - this.b + this.b * (this.avgdl > 0 ? dl / this.avgdl : 0));
                const contrib = denom > 0 ? (idf * (p.tf * (this.k1 + 1))) / denom : 0;
                const weighted = contrib * this.docWeight[p.docIndex];
                const cmd = this.docCommand[p.docIndex];
                perCommand.set(cmd, (perCommand.get(cmd) ?? 0) + weighted);
            }
        }
        if (!matched)
            return [];
        const results = [];
        for (const [commandId, score] of perCommand)
            results.push({ commandId, score });
        results.sort((a, b) => b.score - a.score || a.commandId.localeCompare(b.commandId));
        return results;
    }
    /** Top-`n` por score. `[]` se nada casar; nunca retorna NaN. */
    search(query, n) {
        const all = this.searchAll(query);
        if (n <= 0)
            return [];
        return all.slice(0, n);
    }
}
//# sourceMappingURL=bm25.js.map