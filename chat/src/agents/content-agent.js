const { AgentRuntime } = require("../agent-runtime")
const { EnvUtils, Utils } = require("../utils")
const { TraderAgent } = require("./trader-agent")
const { tool, nowTick, DEFAULT_PAGE_SIZE } = require("./base-agent")

class ContentAgent extends TraderAgent {
    /* # COMMAND

    obtem indicadores fundamentalistas e recomendações produzidas pelo time de time de Research.
    
    @note[out] SIGLA de recomendação não deve aparecer. Deve ser reescrito para forma descritiva [B]->Compra ou [S]->Venda ou [N]->Neutro

    @input fields: arr[str] -> [ symbol, marketCapital, enterpriseValue, assets, equity, equityToAssets, currentAssets, netCurrentAssets, liabilities, currentLiabilities, currentRatio, netDebtToEbitda, assetTurnover, priceToCapitalTurnover, capitalTurnover, grossDebt, grossDebtToEquity, netDebt, netDebtToEbit, netDebtToEquity, netRevenue, ebit, ebitda, netIncome, grossMargin, ebitMargin, ebitdaMargin, netMargin, dividendYield, priceToEarnings, priceToEarningsToGrowth, priceToBook, priceToAssets, priceToEbit, priceToEbitda, priceToSales, priceToNetCurrentAsset, enterpriseValueToEbit, enterpriseValueToEbitda, returnOnInvestedCapital, returnOnEquity, returnOnAsset, growthRate, earningsPerShare, bookValuePerShare, dividendPerShare, salesPerShare, earningsDate, hasAnalysis, analysisDate, recommendation, targetPrice, upside ]

    @output symbol:                  string -> código/ticker do ativo
    @output marketCapital:           number -> valor de mercado (Market Cap)
    @output enterpriseValue:         number -> valor da firma (Enterprise Value, EV)
    @output assets:                  number -> ativo total
    @output equity:                  number -> patrimônio líquido
    @output equityToAssets:          number -> patrimônio líquido sobre ativo total, em percentual
    @output currentAssets:           number -> ativo circulante
    @output netCurrentAssets:        number -> ativo circulante líquido (capital de giro)
    @output liabilities:             number -> passivo total
    @output currentLiabilities:      number -> passivo circulante
    @output currentRatio:            number -> liquidez corrente
    @output netDebtToEbitda:         number -> dívida líquida sobre EBITDA
    @output assetTurnover:           number -> giro do ativo
    @output priceToCapitalTurnover:  number -> preço sobre giro do capital
    @output capitalTurnover:         number -> giro do capital
    @output grossDebt:               number -> dívida bruta
    @output grossDebtToEquity:       number -> dívida bruta sobre patrimônio líquido
    @output netDebt:                 number -> dívida líquida
    @output netDebtToEbit:           number -> dívida líquida sobre EBIT
    @output netDebtToEquity:         number -> dívida líquida sobre patrimônio líquido
    @output netRevenue:              number -> receita líquida
    @output ebit:                    number -> lucro antes de juros e impostos (EBIT)
    @output ebitda:                  number -> EBIT antes de depreciação e amortização (EBITDA)
    @output netIncome:               number -> lucro líquido
    @output grossMargin:             number -> margem bruta em percentual
    @output ebitMargin:              number -> margem EBIT em percentual
    @output ebitdaMargin:            number -> margem EBITDA em percentual
    @output netMargin:               number -> margem líquida em percentual
    @output dividendYield:           number -> rendimento de dividendos em percentual
    @output priceToEarnings:         number -> índice Preço/Lucro (P/L)
    @output priceToEarningsToGrowth: number -> índice PEG (P/L sobre crescimento)
    @output priceToBook:             number -> índice Preço/Valor Patrimonial (P/VP)
    @output priceToAssets:           number -> índice Preço/Ativos
    @output priceToEbit:             number -> índice Preço/EBIT (P/EBIT)
    @output priceToEbitda:           number -> índice Preço/EBITDA (P/EBITDA)
    @output priceToSales:            number -> índice Preço/Receita (PSR)
    @output priceToNetCurrentAsset:  number -> índice Preço/Ativo Circulante Líquido
    @output enterpriseValueToEbit:   number -> índice EV/EBIT
    @output enterpriseValueToEbitda: number -> índice EV/EBITDA
    @output returnOnInvestedCapital: number -> retorno sobre capital investido em percentual (ROIC)
    @output returnOnEquity:          number -> retorno sobre patrimônio líquido em percentual (ROE)
    @output returnOnAsset:           number -> retorno sobre ativos em percentual (ROA)
    @output growthRate:              number -> taxa de crescimento em percentual
    @output earningsPerShare:        number -> lucro por ação (LPA)
    @output bookValuePerShare:       number -> valor patrimonial por ação (VPA)
    @output dividendPerShare:        number -> dividendos por ação (DPA)
    @output salesPerShare:           number -> receita por ação
    @output earningsDate:            date   -> data de divulgação dos resultados
    @output hasAnalysis:             bool   -> indica se há análise de Research disponível
    @output analysisDate:            date   -> data de referência da análise
    @output recommendation:          string -> recomendação do analista [B]->Compra [N]->Neutro [S]->Venda
    @output targetPrice:             number -> preço-alvo estimado pelo analista
    @output upside:                  number -> potencial de valorização em percentual

    @example [user] qual o P/L de ABCD11?                  -> { "type": "getFundamentals", "fields": [ "priceToEarnings" ] }
    @example [user] EV/EBITDA e dívida líquida de VALE3    -> { "type": "getFundamentals", "fields": [ "enterpriseValueToEbitda", "netDebt", "netDebtToEbitda" ] }
    @example [user] margens de PETR4                       -> { "type": "getFundamentals", "fields": [ "grossMargin", "ebitMargin", "ebitdaMargin", "netMargin" ] }
    @example [user] qual a recomendação para ABCD11?       -> { "type": "getFundamentals", "fields": [ "recommendation", "targetPrice", "upside" ] }
    @example [user] qual o dividend yield da SampleCorp?   -> { "type": "getFundamentals", "fields": [ "dividendYield" ] }
    @example [user] qual o ROE e ROIC de PETR4?            -> { "type": "getFundamentals", "fields": [ "returnOnEquity", "returnOnInvestedCapital" ] }
    @example [user] múltiplos de VALE3                     -> { "type": "getFundamentals", "fields": [ "priceToEarnings", "priceToBook", "priceToEbit", "dividendYield" ] }
    @example [user] market cap de ITUB4                    -> { "type": "getFundamentals", "fields": [ "marketCapital" ] }

    */
    async getFundamentals({ type, fields }) {

        this.querySymbolCommand = { type, fields }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        const fundamentais = await this.marketDataService.getFundamentals(this.selectedSymbol)
        if (!fundamentais) {
            return AgentRuntime.instruction(type, 'informe que dado não encontrados')
        }

        const fundamentalistFields = [
            'marketCapital', 'enterpriseValue',
            'assets', 'equity', 'equityToAssets',
            'currentAssets', 'netCurrentAssets',
            'liabilities', 'currentLiabilities', 'currentRatio',
            'grossDebt', 'grossDebtToEquity',
            'netDebt', 'netDebtToEbit', 'netDebtToEbitda', 'netDebtToEquity',
            'assetTurnover', 'capitalTurnover', 'priceToCapitalTurnover',
            'netRevenue', 'ebit', 'ebitda', 'netIncome',
            'grossMargin', 'ebitMargin', 'ebitdaMargin', 'netMargin',
            'dividendYield',
            'priceToEarnings', 'priceToEarningsToGrowth', 'priceToBook', 'priceToAssets',
            'priceToEbit', 'priceToEbitda', 'priceToSales', 'priceToNetCurrentAsset',
            'enterpriseValueToEbit', 'enterpriseValueToEbitda',
            'returnOnInvestedCapital', 'returnOnEquity', 'returnOnAsset', 'growthRate',
            'earningsPerShare', 'bookValuePerShare', 'dividendPerShare', 'salesPerShare'
        ]

        const recommendationFields = ['recommendation', 'targetPrice', 'upside']
        const metaFields = ['earningsDate', 'analysisDate']

        const allFields = [...fundamentalistFields, ...recommendationFields, metaFields]

        if (!fields || fields.length == 0) {
            fields = allFields
        }

        let data = {}
        for (let field of fields) {
            data[field] = fundamentais[field]
        }

        if (recommendationFields.some(f => fields.includes(f)) && !fundamentalistFields.some(f => fields.includes(f))) {
            this.outputCard = { type: 'fundamentals_recommendation' }
        } else {
            this.outputCard = { type: 'fundamentals', fields }
        }

        return { type, symbol: this.selectedSymbol, data }
    }

    /* # COMMAND

    obtem relatório de análise, avaliação fundamentalista e tese de investimento produzido pelo time de time de Research. Representa a visão estratégica do banco para o ativo.
    
    @note Apresentar relatório como explicação sobre motivo para recomendação NÃO caracteriza questões específicas sobre relatório em si.

    @note[out] 'dataOverlay' representa valores online, mais recentes. Se disponível, sobreescrever valores no texto 'fullSummary'.
    @note[out] SIGLA de recomendação não deve aparecer. Deve ser reescrito para forma descritiva [B]->Compra ou [S]->Venda ou [N]->Neutro
    @note[out] Somente usar questions quando o usuário pedir interpretação do relatório/tese

    @input fields: arr[str] -> [ fullSummary, generationDate ]
    @input questions : arr[str] -> dúvidas de interpretação do conteúdos apresentados no relatório. Exemplo: causa efeito, impactos, etc... Pergunda sobre motivo ou explicação abrangente da recomendação NÂO deve ser incluída neste campo.

    @output text: string -> texto completo do relatório de análise e tese de investimento
    @output analysisDate: date -> data de publicação da análise

    @example [user] quero ver o relatório da SampleCorp -> { "type": "getFundamentalsSummary", fields: [ "fullSummary" ] }
    @example [user] como os analistas enxergam SampleCorp -> { "type": "getFundamentalsSummary", fields: [ "fullSummary" ] }
    @example [user] qual tese de investimentos para a ABCD11 -> { "type": "getFundamentalsSummary", fields: [ "fullSummary" ] }
    @example [user] quando foi a última análise de ABCD11? -> { "type": "getFundamentalsSummary", fields: [ "generationDate" ] }

    */
    async getFundamentalsSummary({ type, fields, questions }) {

        this.querySymbolCommand = { type, fields }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        const summary = await this.marketDataService.getFundamentalsSummary(this.selectedSymbol)
        if (!summary) {
            return AgentRuntime.instruction(type, 'informe que dados não encontrados')
        }

        if (questions?.length > 0) {
            return AgentRuntime.instruction(type, '!!! IMPORTANT - informe que não tem competência para responder ao que foi solicitado. Indique utilização da Plataforma Trader Desktop para acesso completo ao relatório original.')
        }

        if (!fields || fields.length == 0) {
            fields = ['fullSummary', 'generationDate']
        }

        let data = {}
        for (let field of fields) {
            data[field] = summary[field]
        }

        let dataOverlay = undefined
        if (data.fullSummary) {
            const fundamentals = await this.marketDataService.getFundamentals(this.selectedSymbol)
            if (fundamentals) {
                dataOverlay = [
                    { label: 'P/L', value: fundamentals.priceToEarnings },
                    { label: 'P/VP', value: fundamentals.priceToBook },
                    { label: 'Dividend Yield', value: fundamentals.dividendYield },
                    { label: 'Recomendação', value: fundamentals.recommendation },
                    { label: 'Preço-Alvo', value: fundamentals.targetPrice },
                    { label: 'Upside', value: fundamentals.upside },
                ]
            }
        }

        this.outputCard = { type: 'fundamentals_summary', symbol: this.selectedSymbol, data }

        return { type, symbol: this.selectedSymbol, data, dataOverlay }
    }

    /* # COMMAND

    obtem análise consolidada da carteira/portfolio da conta selecionada, produzida pelo time de time de Research

    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note retorna a análise textual da carteira como visão estratégica do banco para o conjunto de posições da conta
    @note[out] apresentar o texto da análise integralmente — NÃO resumir, interpretar, complementar ou emitir opinião própria

    @output text: string -> texto completo da análise de carteira

    @example [isDigitalMode][user] análise da minha carteira -> { "type": "getPortfolioAnalysis" }
    @example [isDigitalMode][user] como está minha carteira segundo o Research -> { "type": "getPortfolioAnalysis" }
    @example [isAdminMode][user] análise da carteira do cliente -> { "type": "getPortfolioAnalysis" }
    @example [isAdminMode][user] análise da carteira da conta 123456 -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "getPortfolioAnalysis" } ]

    */
    async getPortfolioAnalysis({ type }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const analysis = await this.portfolioRecommender.getPortfolioAnalysis(this.selectedAccount)
        if (!analysis) {
            return AgentRuntime.instruction(type, 'informe que a análise da carteira selecionada não está disponível')
        }

        this.outputCard = { type: 'portfolio_analysis' }

        return { type, account: this.selectedAccount, analysis }
    }

    /* # COMMAND
    
    lista os ativos EM CARTEIRA da conta selecionada apontados pela camada recommender do Research — as posições desalinhadas das recomendações, candidatas a VENDA/TROCA
    
    @note esta é a PRIMEIRA FASE de uma operação de TROCA de ativos / otimização de portfolio: identifica O QUE vender antes de definir POR QUAL ativo trocar
    @note intenções de TROCAR ativos, OTIMIZAR/AJUSTAR/REBALANCEAR a carteira, MELHORAR a alocação, "adequar ao Research", "o que devo trocar/vender segundo o Research" são GATILHOS deste comando — mesmo sem citar um ativo específico
    @note fluxo completo da troca: [getPortfolioRecommendationSell] (fase 1 — lista posições a vender) → usuário escolhe o ativo → [executePortfolioRecommendation] (fase 2 — gera o par venda→compra)
    @note NÃO gera boletas nem executa ordens — apenas LISTA as posições candidatas. A geração do par de troca é feita por [executePortfolioRecommendation]
    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note retorna apenas ativos que o cliente JÁ possui em carteira E que constam como posição a ajustar na camada recommender — cruza recomendações com posições vigentes
    @note[out] apresentar a lista de ativos a vender/trocar e sugira que o usuário escolha qual deseja trocar — NÃO emitir opinião, análise ou justificativa própria
    
    @output account:  string -> conta consultada
    @output data:     obj[]  -> posições candidatas a venda/troca — { account, sector, symbol, quantity, volume }
    
    @example [isDigitalMode][user] quero trocar ativos da minha carteira                 -> { "type": "getPortfolioRecommendationSell" }
    @example [isDigitalMode][user] como posso otimizar meu portfolio                      -> { "type": "getPortfolioRecommendationSell" }
    @example [isDigitalMode][user] o que devo trocar/vender segundo o Research        -> { "type": "getPortfolioRecommendationSell" }
    @example [isDigitalMode][user] quero melhorar a alocação da minha carteira            -> { "type": "getPortfolioRecommendationSell" }
    @example [isDigitalMode][user] quais posições estão desalinhadas das recomendações    -> { "type": "getPortfolioRecommendationSell" }
    @example [isAdminMode][user] o que trocar na carteira da conta 123456                 -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "getPortfolioRecommendationSell" } ]
    @example [isAdminMode][user] vamos rebalancear o portfolio do cliente 123456          -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "getPortfolioRecommendationSell" } ]
    
    */
    async getPortfolioRecommendationSell({ type }) {

        this.queryAccountCommand = { type }

        // pré-requisito: conta selecionada
        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        // recomendações do Research (par posição -> recomendação)
        const recommendations = await this.portfolioRecommender.getPortfolioRecommendation(this.selectedAccount)
        if (!Array.isArray(recommendations) || !recommendations.length) {
            return AgentRuntime.instruction(type, 'informe que não há recomendações de venda disponíveis para a carteira no momento')
        }

        // posições vigentes da carteira
        const positions = await this.positionService.getPositions(this.selectedAccount)

        // símbolos indicados como posição a ajustar (lado da venda)
        const sellSymbols = new Set(
            recommendations
                .map(r => r.positionSymbol?.toUpperCase())
                .filter(o => !o.startsWith('BPAC'))
                .filter(Boolean)
        )

        // cruza recomendações com posições realmente existentes em carteira
        const data = (positions || [])
            .filter(p => sellSymbols.has(p.symbol?.toUpperCase()) && Math.abs(p.totalQuantity || 0) > 0)
            .map(p => ({
                account: this.selectedAccount,
                symbol: p.symbol,
                quantity: Math.abs(p.totalQuantity),
                volume: p.volume,
                profit: p.profit,
                profitPercent: p.profitPercent,
            }))

        this.outputCard = { type: 'portfolio_recommendation_sell', data }

        return { type, account: this.selectedAccount, data, state: 'PortfolioRecommendationSell' }
    }

    /* # COMMAND [PortfolioRecommendationSell]

    lista os ativos recomendados pelo Research como ALTERNATIVAS DE COMPRA para substituir uma posição desalinhada — a SEGUNDA FASE da operação de TROCA de ativos

    @note esta é a SEGUNDA FASE da troca: após [getPortfolioRecommendationSell] identificar O QUE vender, este comando lista POR QUAL ativo trocar
    @note recebe [symbol] — o ativo em carteira a ser substituído (a posição SEM recomendação apresentada anteriormente). Se omitido, assume o ativo selecionado em memória ([selectedSymbol])
    @note intenções como "o que sugere para trocar XXXX", "o que alocar no lugar de XXXX", "por qual ativo trocar XXXX", "alternativas para substituir XXXX" são GATILHOS deste comando
    @note fluxo completo da troca: [getPortfolioRecommendationSell] (fase 1 — posições a vender) → [getPortfolioRecommendationBuy] (fase 2 — alternativas de compra) → [executePortfolioRecommendation] (fase 3 — gera o par venda→compra)
    @note NÃO gera boletas nem executa ordens — apenas LISTA as alternativas recomendadas. A geração do par de troca é feita por [executePortfolioRecommendation]
    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note cruza as recomendações do Research com a posição informada — retorna os ativos indicados como substitutos ([recommendationSymbol]) para o ativo em carteira ([positionSymbol])
    @note[out] apresentar a lista de ativos recomendados e sugerir que o usuário escolha para qual deseja trocar — NÃO emitir opinião, análise ou justificativa própria

    @input symbol: str -> ativo em carteira a ser substituído na troca. Se omitido, assume [selectedSymbol]

    @output account: string -> conta consultada
    @output symbol:  string -> ativo a ser substituído (posição de origem)
    @output data:    obj[]  -> alternativas de compra recomendadas — { sector, symbol, topPick, recommendation, targetPrice, upside }

    @example [isDigitalMode][user] o que sugere para troca de PETR4         -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "getPortfolioRecommendationBuy", "symbol": "PETR4" } ]
    @example [isDigitalMode][user] o que podemos alocar no lugar de VALE3   -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "getPortfolioRecommendationBuy", "symbol": "VALE3" } ]
    @example [isDigitalMode][user] por qual ativo trocar ITUB4             -> [ { "type": "selectSymbol", "symbol": "ITUB4" }, { "type": "getPortfolioRecommendationBuy", "symbol": "ITUB4" } ]
    @example [isAdminMode][user] alternativas para substituir BBAS3 na conta 123456 -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "selectSymbol", "symbol": "BBAS3" }, { "type": "getPortfolioRecommendationBuy", "symbol": "BBAS3" } ]

    */
    async getPortfolioRecommendationBuy({ type, symbol }) {

        this.queryAccountCommand = { type }

        // pré-requisito: conta selecionada
        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        // ativo a ser substituído (posição de origem) — default selectedSymbol
        symbol = (symbol ?? this.selectedSymbol)?.toUpperCase()
        if (!symbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo informado - solicite ao usuário o ativo a ser trocado')
        }

        // setor do ativo a substituir
        const sectors = await this.marketDataService.getSecuritiesSectors([symbol])
        const sector = sectors?.[symbol]?.sector
        if (!sector) {
            return AgentRuntime.instruction(type, `nenhuma alternativa de troca recomendada para ${symbol}`)
        }

        // todas as recomendações de compra do mesmo setor (ranqueadas)
        const ranked = await this.marketDataService.getRecommendationsRanked(sector)
        if (!Array.isArray(ranked) || !ranked.length) {
            return AgentRuntime.instruction(type, `nenhuma alternativa de troca recomendada para ${symbol}`)
        }

        // exclui o próprio ativo e o que a carteira já possui
        const positions = await this.positionService.getPositions(this.selectedAccount)
        const held = new Set(
            (positions || [])
                .filter(p => Math.abs(p.totalQuantity || 0) > 0)
                .map(p => p.symbol?.toUpperCase())
                .filter(Boolean)
        )

        const candidates = ranked.filter(r => {
            const s = r.symbol?.toUpperCase()
            return s && s !== symbol && !held.has(s)
        })

        if (!candidates.length) {
            return AgentRuntime.instruction(type, `nenhuma alternativa de troca recomendada para ${symbol}`)
        }

        // enriquece com preço-alvo (targetPrice não vem no objeto de recomendação)
        const data = []
        for (const c of candidates) {

            const buySymbol = c.symbol.toUpperCase()
            const fundamentals = await this.marketDataService.getFundamentals(buySymbol)

            data.push({
                sector: c.sector,
                symbol: buySymbol,
                topPick: !!c.isTopPick,
                recommendation: c.recommendation,
                targetPrice: fundamentals?.targetPrice,
                upside: c.upside ?? fundamentals?.upside,
            })
        }

        this.portfolioRecommendationSellSymbol = symbol
        this.outputCard = { type: 'portfolio_recommendation_buy', symbol, data }

        return { type, account: this.selectedAccount, symbol, data, state: 'PortfolioRecommendationBuy' }
    }

    /* # COMMAND [PortfolioRecommendationBuy]

    gera o PAR de ordens(boletas) de TROCA de ativo para adequação do portfolio conforme recomendações do time de time de Research

    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note toda troca exige um PAR de ativos: [symbolSell] (posição em carteira a VENDER) → [symbolBuy] (ativo recomendado a COMPRAR). NÃO existe modo em lote/cesta — cada execução gera EXATAMENTE uma troca (uma venda + uma compra)
    @note [symbolBuy] é OBRIGATÓRIO — é o ativo recomendado a ser comprado na troca
    @note se [symbolSell] NÃO for informado, assume o ativo selecionado em memória ([selectedSymbol]) como a posição a vender
    @note o par [symbolSell]→[symbolBuy] é VALIDADO contra as recomendações do Research — se a troca não constar entre as recomendações, a operação NÃO é gerada
    @note a VENDA usa a QUANTIDADE TOTAL da posição de [symbolSell]; a COMPRA usa o VOLUME financeiro liberado pela venda
    @note ao final, [symbolBuy] passa a ser o [selectedSymbol] e a boleta de COMPRA criada passa a ser a boleta selecionada ([selectedRequest])
    @note se [symbolSell] não possuir posição em carteira, a troca não é gerada — não há quantidade a liquidar
    @note boletas criadas como [M]ercado, validade [DAY] — ajustáveis individualmente ou em lote ([batchMode]) antes do envio

    @input symbolSell: str -> ativo JÁ em carteira a ser VENDIDO na troca (posição). Se omitido, assume [selectedSymbol]
    @input symbolBuy:  str -> ativo recomendado a ser COMPRADO na troca — gera ordem de COMPRA pelo VOLUME financeiro liberado. OBRIGATÓRIO

    @output account:    string -> conta sobre a qual as boletas de troca foram geradas
    @output symbolSell: string -> ativo vendido na troca
    @output symbolBuy:  string -> ativo comprado na troca
    @output sector:     string -> setor da troca recomendada
    @output total:      number -> quantidade de boletas criadas (sempre 2: venda + compra)
    @output created:    obj[]  -> boletas geradas — { sector, symbol, side, quantity | volume, requestId }
    @output status:     string -> 'ok' quando o par de boletas foi gerado

    @example [isDigitalMode][user] troca minha PETR4 por VALE3 conforme o Research          -> { "type": "executePortfolioRecommendation", "symbolSell": "PETR4", "symbolBuy": "VALE3" }
    @example [isDigitalMode][user] (PETR4 selecionada) troca pela VALE3 recomendada     -> { "type": "executePortfolioRecommendation", "symbolBuy": "VALE3" }
    @example [isAdminMode][user] troca ITUB4 por BBAS3 na conta 123456                  -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "executePortfolioRecommendation", "symbolSell": "ITUB4", "symbolBuy": "BBAS3" } ]

    */
    async executePortfolioRecommendation({ type, symbolSell, symbolBuy }) {

        // 1) conta selecionada
        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        // 2) par de troca: symbolSell (posição, default selectedSymbol) -> symbolBuy (recomendação, obrigatório)
        symbolSell = (symbolSell ?? this.selectedSymbol)?.toUpperCase()   // sem symbolSell, assume o ativo selecionado
        symbolBuy = symbolBuy?.toUpperCase()

        if (!symbolSell) {
            return AgentRuntime.instruction(type, 'questione qual ativo em carteira deve ser vendido na troca')
        }
        if (!symbolBuy) {
            return AgentRuntime.instruction(type, 'questione qual ativo deve ser comprado na troca')
        }

        // 3) valida o par (venda -> compra) contra as recomendações do Research
        const sector = await this.portfolioRecommender.validatePortfolioRecommendation(symbolSell, symbolBuy)
        if (!sector) {
            return AgentRuntime.instruction(type, `informe que a troca de ${symbolSell} por ${symbolBuy} não consta entre as recomendações do time de Research`)
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        // 4) posição do ativo a vender — base da troca
        const positions = await this.positionService.getPositions(account.account)
        const position = (positions || []).find(p => p.symbol === symbolSell)
        const totalQuantity = position?.totalQuantity || 0

        if (!totalQuantity) {
            return AgentRuntime.instruction(type, `informe que não há posição em ${symbolSell} para vender — a troca não pode ser gerada`)
        }

        const sellQuantity = Math.abs(totalQuantity)
        const swapVolume = position.volume || undefined

        if (!swapVolume) {
            return AgentRuntime.instruction(type, `informe que não foi possível apurar o volume financeiro da posição em ${symbolSell} para a compra de ${symbolBuy}`)
        }

        // 5) gerar o PAR de boletas — VENDA por quantidade / COMPRA por volume financeiro
        const accountContext = this.getAccountContext()
        const created = []

        const sellRequest = this.buildRequest({ symbol: symbolSell, side: 'S', quantity: sellQuantity })
        accountContext.requests[sellRequest.requestId] = sellRequest
        created.push({ sector, symbol: symbolSell, side: 'S', quantity: sellQuantity, requestId: sellRequest.requestId })

        const buyRequest = this.buildRequest({ symbol: symbolBuy, side: 'B', volume: swapVolume })
        accountContext.requests[buyRequest.requestId] = buyRequest
        created.push({ sector, symbol: symbolBuy, side: 'B', volume: swapVolume, requestId: buyRequest.requestId })

        // 6) foco final: ativo comprado como selectedSymbol e boleta de COMPRA como selectedRequest
        accountContext.selectedRequestId = buyRequest.requestId
        buyRequest.selectedTime = nowTick()

        this.selectedSymbol = symbolBuy
        this.selectedSecurityDescription = undefined
        const security = await this.marketDataService.getSecurity(symbolBuy)
        if (security) {
            this.selectedSecurityDescription = security.description
        }

        this.outputCard = { type: 'requests' }

        return { type, account: this.selectedAccount, symbolSell, symbolBuy, sector, total: created.length, created, status: 'ok' }
    }

    /* # COMMAND

    verifica se um ativo é Top Pick do Research, ou lista os Top Picks de um setor específico

    @note Top Pick representa as principais empresas de um setor com melhores avaliações de recomendação de compra do time de Research para um determinado setor
    @note se [symbol] for informado, verifica se o ativo é Top Pick — ignora [sector]
    @note se [sector] for informado sem [symbol], lista todos os Top Picks do setor
    @note se nenhum parâmetro for informado, lista todos os Top Picks de todos os setores

    @input symbol: str (opcional) -> ticker do ativo a verificar. Se informado, retorna status Top Pick do ativo
    @input sector: str (opcional) -> setor para filtrar Top Picks. Valores possíveis: [Agronegócio, Aluguel de Carros & Logística, Construção Civil & Propriedades, Educação, Financeiro, Infraestrutura, Mineração & Siderurgia, Papel & Celulose, Petróleo & Gás, Saúde, Serviços Básicos, Telecom & Tecnologia, Varejo & Consumo]

    @output isTopPick: bool     -> (quando symbol informado) indica se o ativo é Top Pick
    @output symbol:    string   -> (quando symbol informado) ticker consultado
    @output sector:    string   -> (quando symbol informado) setor do ativo, se for Top Pick
    @output sectors:   obj[]    -> (quando sector informado) lista de setores com seus Top Picks — { sector, assets: string[] }

    @example [user] PETR4 é top pick?                          -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "getTopPicks", "symbol": "PETR4" } ]
    @example [user] quais são os top picks de Financeiro?      -> { "type": "getTopPicks", "sector": "Financeiro" }
    @example [user] top picks de Saúde                         -> { "type": "getTopPicks", "sector": "Saúde" }
    @example [user] quais os top picks?                        -> { "type": "getTopPicks" }
    @example [user] VALE3 está entre os top picks?             -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "getTopPicks", "symbol": "VALE3" } ]

    */
    async getTopPicks({ type, symbol, sector }) {

        if (symbol) {
            this.querySymbolCommand = { type, symbol }
        }

        const topPicks = await this.marketDataService.getTopPicks()
        if (!topPicks) {
            return AgentRuntime.instruction(type, 'informe que dados de Top Picks não foram encontrados')
        }

        const allEntries = Object.values(topPicks)

        // agrupa por setor — usado para listar e para validar setores conhecidos
        const grouped = {}
        for (const entry of allEntries) {
            const s = entry.sector || 'Outros'
            if (!grouped[s]) grouped[s] = []
            grouped[s].push(entry.symbol)
        }

        // OBRIGATÓRIO symbol OU sector — sem nenhum, questiona o setor desejado
        if (!symbol && !sector) {
            const knownSectors = Object.keys(grouped).sort((a, b) => a.localeCompare(b))

            if (!knownSectors.length) {
                return AgentRuntime.instruction(type, 'informe que nenhuma Top Pick está disponível no momento')
            }

            this.outputCard = { type: 'top_picks_sectors', sectors: knownSectors }

            return AgentRuntime.interrupt(
                { type, sectors: knownSectors },
                `apresente os setores disponíveis e questione de qual setor o usuário deseja conhecer as Top Picks: ${knownSectors.join(', ')}`,
                'TopPicksSector'
            )
        }

        // modo 1: verificar se ativo específico é top pick (ignora sector)
        if (symbol) {
            const entry = topPicks[symbol.toUpperCase()]
            const isTopPick = !!entry

            this.outputCard = { type: 'fundamentals_recommendation' }

            return {
                type,
                symbol: symbol.toUpperCase(),
                isTopPick,
                sector: entry?.sector ?? null
            }
        }

        // modo 2: listar top picks do setor informado
        const sectors = Object.entries(grouped)
            .filter(([s]) => s === sector)
            .map(([s, assets]) => ({ sector: s, assets }))

        this.outputCard = { type: 'top_picks', sector: sectors?.[0] }

        return {
            type,
            sectors,
            total: sectors.length
        }
    }

}

ContentAgent.agentName = 'content'

tool({ version: '1.0.0', name: 'getFundamentals' })(ContentAgent, 'getFundamentals')
tool({ version: '1.0.0', name: 'getFundamentalsSummary' })(ContentAgent, 'getFundamentalsSummary')
tool({ version: '1.0.0', name: 'getPortfolioAnalysis' })(ContentAgent, 'getPortfolioAnalysis')
tool({ version: '1.0.0', name: 'getPortfolioRecommendationSell' })(ContentAgent, 'getPortfolioRecommendationSell')
tool({ version: '1.0.0', name: 'getPortfolioRecommendationBuy' })(ContentAgent, 'getPortfolioRecommendationBuy')
tool({ version: '1.0.0', name: 'executePortfolioRecommendation' })(ContentAgent, 'executePortfolioRecommendation')
tool({ version: '1.0.0', name: 'getTopPicks' })(ContentAgent, 'getTopPicks')

module.exports = { ContentAgent }
