// MOCK — stand-in para LlmService (etapa 1)
// ATENÇÃO: este mock SERÁ SUBSTITUÍDO. O LLM real vive em ../llm-service.js.
// Aqui não há chamada de rede: a detecção de intenção no modo 'json' é feita
// por roteamento leve por palavra-chave sobre o `# CHAT_INPUT` do prompt.
// A etapa 2 troca esta detecção 'json' por um router determinístico dedicado.
//
// Contrato consumido pelo runtime (agent-runtime.js):
//   - execute(prompt, 'json')  => Array<Array<{ type, ...params }>>  (grupos de comandos;
//                                 o runtime faz mcmds.map(group => group.filter(...)))
//   - execute(prompt, 'text')  => string (resposta final em pt-BR)

const KNOWN_SYMBOLS = ['PETR4', 'VALE3', 'ITUB4', 'BBAS3', 'ABCD11']

class LlmService {

    async execute(prompt, mode, temperature) {

        const modeLower = String(mode || '').toLowerCase()

        if (modeLower === 'json') {
            return this._routeJson(prompt)
        }

        // modo 'text' (ou qualquer outro): resposta livre em pt-BR
        return this._composeText(prompt)
    }

    // --- extração do input do usuário a partir do bloco # CHAT_INPUT ---
    _extractChatInput(prompt) {
        const text = String(prompt || '')
        // pega a ÚLTIMA ocorrência de "[user] ..." (linha do turno atual)
        const matches = [...text.matchAll(/\[user\]\s*(.+)/gi)]
        if (matches.length === 0) {
            return ''
        }
        return matches[matches.length - 1][1].trim()
    }

    _extractRawData(prompt) {
        const text = String(prompt || '')
        const idx = text.indexOf('# INPUT_RAW_DATA')
        if (idx === -1) {
            return ''
        }
        // tudo após o cabeçalho até o próximo bloco "# " (ou fim)
        let rest = text.slice(idx + '# INPUT_RAW_DATA'.length)
        const next = rest.search(/\n#\s/)
        if (next !== -1) {
            rest = rest.slice(0, next)
        }
        return rest.trim()
    }

    // --- roteamento leve por palavra-chave (modo json) ---
    _routeJson(prompt) {
        const input = this._extractChatInput(prompt)
        const upper = input.toUpperCase()
        const lower = input.toLowerCase()

        // 1) ticker conhecido -> seleciona símbolo + cotação
        for (const sym of KNOWN_SYMBOLS) {
            if (upper.includes(sym)) {
                return [[
                    { type: 'selectSymbol', symbol: sym },
                    { type: 'getQuote', fields: ['lastPrice', 'changePercent'] }
                ]]
            }
        }

        // 2) carteira / posição / portfolio -> análise de carteira
        if (/carteira|posi[çc][ãa]o|portf[óo]lio|portfolio/.test(lower)) {
            return [[{ type: 'getPortfolioAnalysis' }]]
        }

        // 3) saudação
        if (/\b(oi|ol[áa]|bom dia|boa tarde|boa noite|e a[íi])\b/.test(lower)) {
            return [[{ type: 'greetings' }]]
        }

        // 4) fallback: intenção não reconhecida
        return [[{ type: 'notFound', description: input || 'intenção não reconhecida' }]]
    }

    // --- síntese de texto (modo text) a partir do # INPUT_RAW_DATA ---
    _composeText(prompt) {
        const raw = this._extractRawData(prompt)

        if (!raw || raw === '[]' || raw === '[[]]') {
            return 'Não encontrei dados para responder a essa solicitação. Posso ajudar com cotações, carteira ou fundamentos de um ativo.'
        }

        // resumo curto e determinístico do payload de resultados
        let summary = raw
        try {
            const parsed = JSON.parse(raw)
            const flat = Array.isArray(parsed) ? parsed.flat(Infinity) : [parsed]
            const parts = flat
                .filter(Boolean)
                .map(item => {
                    if (typeof item === 'string') return item
                    if (item && typeof item === 'object') {
                        return item.instruction || item.description || item.text || item.type || ''
                    }
                    return ''
                })
                .filter(Boolean)
            if (parts.length) {
                summary = parts.join(' ')
            }
        } catch (e) {
            // mantém o raw como fallback
        }

        summary = String(summary).replace(/\s+/g, ' ').trim()
        if (summary.length > 400) {
            summary = summary.slice(0, 397) + '...'
        }

        return `Aqui está o resumo: ${summary}`
    }
}

// exportado sob os dois nomes para casar qualquer destructuring do bootstrap
const MockLlmService = LlmService

module.exports = { LlmService, MockLlmService }
