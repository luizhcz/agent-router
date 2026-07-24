/**
 * Normalização e tokenização para o índice BM25.
 *
 * Decisões (§6 do brief técnico, seguidas à risca):
 *  - lowercase: sim.
 *  - remoção de acentos: sim, sempre (NFD + descarte de diacríticos). Usuários
 *    digitam "codigo"/"var"; é barato e claramente positivo em IR pt-BR.
 *  - stopwords: lista mínima pt/en/es (artigos/preposições/conjunções). Consultas
 *    de roteamento carregam pouco sinal em stopwords e o IDF do BM25 já as
 *    des-pondera; remoção agressiva apaga tokens úteis.
 *  - stemming: DESLIGADO por padrão. RSLP/stemming pesado machuca (Orengo, CLEF
 *    2006) e, sob code-switching pt/en/es, regras de sufixo PT sobre tokens
 *    ingleses geram stems-lixo. Só o plural-leve dá ganho, então ele existe como
 *    `lightStem` e como a flag `stem` (default false).
 *  - n-gramas de caractere: SIM, mas como CAMPO SEPARADO (ver `charNgrams`),
 *    tolerante a typos/variantes ("config" ≈ "configuracao"). Por isso o
 *    tokenizer padrão de palavras NÃO injeta n-gramas: manter os dois campos
 *    apartados preserva as estatísticas de IDF/comprimento de cada um. (Estas são
 *    primitivas reutilizáveis do módulo lexical; o índice lexical que o
 *    IntentRouter usa em produção é o interno de `router/lexical.ts`, que combina
 *    BM25 de palavras + char 3-gram por SOMA.)
 *
 * PONTO CENTRAL DO MÓDULO: siglas e tickers (PETR4, VaR, IPO, CVM, PnL, DV01,
 * NTN-B, S&P) são preservados como tokens inteiros — nunca quebrados nem removidos
 * como stopword. A embedding densa dilui essas âncoras lexicais; é o BM25 que as
 * resgata, então não podemos perdê-las aqui.
 */
// ---------------------------------------------------------------------------
// Stopwords — listas mínimas, já em forma normalizada (minúsculas, sem acento).
// Exportadas para os testes. A forma sem acento é obrigatória porque o token que
// chega ao filtro já passou por `stripAccents` (ex.: "não" -> "nao", "é" -> "e").
// ---------------------------------------------------------------------------
/** Português: artigos, preposições, conjunções e pronomes átonos mais comuns. */
export const STOPWORDS_PT = [
    'a', 'o', 'e', 'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas',
    'um', 'uma', 'uns', 'umas', 'para', 'pra', 'por', 'com', 'sem', 'que', 'se',
    'os', 'as', 'ao', 'aos', 'em', 'ou', 'me', 'meu', 'minha', 'seu', 'sua',
    'nao', 'sim', 'ja', 'e',
];
/** Inglês: artigos, preposições, auxiliares e pronomes mais comuns. */
export const STOPWORDS_EN = [
    'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
    'was', 'were', 'be', 'with', 'without', 'at', 'by', 'this', 'that', 'my',
    'our', 'we', 'you', 'it', 'do', 'does', 'please', 'me', 'what', 'whats',
];
/** Espanhol: artigos, preposições, conjunções e pronomes mais comuns. */
export const STOPWORDS_ES = [
    'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o',
    'que', 'en', 'con', 'sin', 'por', 'para', 'se', 'su', 'sus', 'del', 'al',
    'es', 'esta', 'cual', 'cuanta', 'cuanto', 'me', 'muestrame', 'hay',
];
/** União deduplicada das três listas, pronta para lookup O(1). */
export const STOPWORDS = new Set([
    ...STOPWORDS_PT,
    ...STOPWORDS_EN,
    ...STOPWORDS_ES,
]);
/** `true` se o token (forma normalizada) está na lista mínima de stopwords. */
export function isStopword(token) {
    return STOPWORDS.has(token);
}
// ---------------------------------------------------------------------------
// Núcleo de normalização
// ---------------------------------------------------------------------------
/**
 * Um token é uma sequência alfanumérica, com conectores internos (`. - & /`)
 * permitidos apenas quando flanqueados por alfanuméricos — assim "NTN-B", "S&P",
 * "97.5" e "pre-trade" ficam inteiros, mas pontuação de borda é descartada.
 */
const TOKEN_RE = /[a-z0-9]+(?:[.\-&/][a-z0-9]+)*/g;
const TOKEN_RE_ANYCASE = /[a-z0-9]+(?:[.\-&/][a-z0-9]+)*/gi;
function stripAccents(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
/**
 * Detecta siglas/tickers a partir da grafia ORIGINAL (antes do lowercase):
 * qualquer token com dígito, com conector interno, todo em maiúsculas, ou com
 * maiúscula depois do 1º caractere (VaR, PnL). Tokens assim ficam imunes à
 * remoção de stopword e ao stemming.
 */
function isHardToken(raw) {
    if (/[0-9]/.test(raw))
        return true;
    if (/[.\-&/]/.test(raw))
        return true;
    const upper = raw.toUpperCase();
    if (raw === upper && raw !== raw.toLowerCase() && raw.length >= 2)
        return true;
    if (/[A-Z]/.test(raw.slice(1)))
        return true;
    return false;
}
/**
 * Stemming plural-leve, conservador e opcional (default OFF). Só remove um "s"
 * final de tokens longos, sem tocar em "ss". Não é chamado por padrão.
 */
export function lightStem(token) {
    if (token.length <= 3)
        return token;
    if (token.endsWith('ss'))
        return token;
    if (token.endsWith('s'))
        return token.slice(0, -1);
    return token;
}
/**
 * Minúsculas + remoção de acentos + colapso de pontuação/espaço em uma única
 * string de tokens separados por espaço. Conectores internos de siglas/tickers
 * são preservados; qualquer outra pontuação vira separador.
 */
export function normalizeText(s) {
    const deacc = stripAccents(s).toLowerCase();
    const toks = deacc.match(TOKEN_RE);
    return toks ? toks.join(' ') : '';
}
/**
 * Tokenizador de PALAVRAS. Preserva siglas/tickers inteiros, remove stopwords do
 * campo de palavras e (opcionalmente) aplica plural-leve. Retorna `[]` para
 * entrada vazia ou só-pontuação.
 */
export function tokenize(s, options = {}) {
    const removeStopwords = options.removeStopwords ?? true;
    const stem = options.stem ?? false;
    const raws = stripAccents(s).match(TOKEN_RE_ANYCASE);
    if (!raws)
        return [];
    const out = [];
    for (const raw of raws) {
        const hard = isHardToken(raw);
        const lower = raw.toLowerCase();
        if (!hard && removeStopwords && STOPWORDS.has(lower))
            continue;
        out.push(stem && !hard ? lightStem(lower) : lower);
    }
    return out;
}
/**
 * N-gramas de caractere (default 3) com marcadores de borda `#`, para o campo
 * BM25 tolerante a typos. Opera sobre a forma normalizada; cada palavra é
 * envolvida em `#…#` para que prefixo/sufixo virem sinais ("config" ≈
 * "configuracao"). Idioma-agnóstico e sem custo de LLM.
 */
export function charNgrams(s, n = 3) {
    const norm = normalizeText(s);
    if (!norm)
        return [];
    const grams = [];
    for (const word of norm.split(' ')) {
        if (!word)
            continue;
        const padded = `#${word}#`;
        if (padded.length <= n) {
            grams.push(padded);
            continue;
        }
        for (let i = 0; i + n <= padded.length; i++) {
            grams.push(padded.slice(i, i + n));
        }
    }
    return grams;
}
//# sourceMappingURL=tokenize.js.map