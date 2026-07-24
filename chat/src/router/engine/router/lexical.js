/** Lista mínima (~30 termos): artigos/preposições/conjunções mais comuns pt/en/es. */
const STOPWORDS = new Set([
    'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
    'em', 'no', 'na', 'nos', 'nas', 'e', 'ou', 'que', 'para', 'por', 'com', 'sem',
    'ao', 'aos', 'se', 'the', 'of', 'to', 'and', 'la', 'el', 'los', 'las', 'del', 'y',
]);
function stripAccents(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function wordTokens(text) {
    return stripAccents(text.toLowerCase())
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}
function filterStopwords(tokens) {
    return tokens.filter((t) => !STOPWORDS.has(t));
}
/** Char n-grams por palavra (sem cruzar fronteira de palavra); palavras curtas entram inteiras. */
function charNgrams(text, n) {
    const words = stripAccents(text.toLowerCase())
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const grams = [];
    for (const w of words) {
        if (w.length <= n) {
            grams.push(w);
            continue;
        }
        for (let i = 0; i + n <= w.length; i++)
            grams.push(w.slice(i, i + n));
    }
    return grams;
}
/** BM25 clássico (Okapi) sobre documentos já tokenizados. */
class BM25 {
    k1;
    b;
    tf = [];
    df = new Map();
    lengths = [];
    avg;
    n;
    constructor(docs, k1 = 1.5, b = 0.75) {
        this.k1 = k1;
        this.b = b;
        this.n = docs.length;
        let total = 0;
        for (const toks of docs) {
            const counts = new Map();
            for (const t of toks)
                counts.set(t, (counts.get(t) ?? 0) + 1);
            for (const t of counts.keys())
                this.df.set(t, (this.df.get(t) ?? 0) + 1);
            this.tf.push(counts);
            this.lengths.push(toks.length);
            total += toks.length;
        }
        this.avg = this.n > 0 ? total / this.n : 0;
    }
    idf(term) {
        const df = this.df.get(term) ?? 0;
        return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
    }
    scoreDoc(i, queryTerms) {
        const counts = this.tf[i];
        if (!counts)
            return 0;
        const len = this.lengths[i] ?? 0;
        const avg = this.avg || 1;
        let s = 0;
        for (const q of queryTerms) {
            const f = counts.get(q);
            if (!f)
                continue;
            s += this.idf(q) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / avg)));
        }
        return s;
    }
}
/**
 * Constrói o índice lexical em memória (barato para ~50 comandos; não é
 * persistido). Campo de palavras: nome + utterances (com stopwords filtradas) +
 * keywords (duplicadas, sem filtro). Campo char: nome + utterances + keywords.
 */
function buildLexicalIndex(catalog) {
    const ids = catalog.commands.map((c) => c.id);
    const wordDocs = [];
    const charDocs = [];
    for (const cmd of catalog.commands) {
        const words = [...filterStopwords(wordTokens(cmd.name))];
        for (const u of cmd.utterances)
            words.push(...filterStopwords(wordTokens(u)));
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
        search(query) {
            const qWords = filterStopwords(wordTokens(query));
            const qChars = charNgrams(query, 3);
            const out = [];
            for (const [i, id] of ids.entries()) {
                const score = wordBm.scoreDoc(i, qWords) + charBm.scoreDoc(i, qChars);
                if (score > 0)
                    out.push({ commandId: id, score });
            }
            out.sort((a, b) => b.score - a.score);
            return out;
        },
    };
}
module.exports = { buildLexicalIndex };
