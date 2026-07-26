const { AgentRuntime } = require("./agent-runtime")
const { EnvUtils, Utils } = require("./utils")

// ============================================================================
// AGENTE ÚNICO (trader). Fusão de base-agent + trader-agent + content-agent:
// BaseAgent segue como base de máquina/estado; TODOS os comandos (trader + os
// antigos "content"/Research) vivem em TraderAgent. Sem split, sem router.
// ============================================================================

let tick = 0
const nowTick = () => {
    let ts = Date.now()
    if (ts < tick) {
        ts = tick
    }
    tick = ts + 1
    return tick
}

function tool(meta) {
    return function (target, key) {
        const original = target.prototype[key];
        original.version = meta.version;
        original.toolName = meta.name;
        target.prototype[key] = original;
    };
}

const DEFAULT_PAGE_SIZE = 5

class BaseAgent {
    async initialize() {

        this.isAdminMode = false
        this.isDigitalMode = false

        this.headers = undefined

        this.accountService = EnvUtils.getInstance('accountService')
        this.alertService = EnvUtils.getInstance('alertService')
        this.orderService = EnvUtils.getInstance('orderService')
        this.positionService = EnvUtils.getInstance('positionService')
        this.marketDataService = EnvUtils.getInstance('marketDataService')
        this.portfolioRecommender = EnvUtils.getInstance('portfolioRecommender')

        this.accountSelectionContext = undefined

        this.chatVersion = undefined

        this.llmService = await EnvUtils.getInstance('llmService')

        await this.initializeContext()

        await this.reset()
    }

    async initializeContext() {
        if (!this.context) {
            return
        }

        // Fonte da identidade/versão: o REGISTRO da conversa quando presente
        // (conversa como recurso provisionado); senão, a string contextId
        // (compatibilidade com o modelo antigo derivado de headers).
        let mode, account, userProfileId, version
        const conv = this.context.conversation
        if (conv) {
            mode = conv.owner?.mode
            account = conv.owner?.account
            userProfileId = conv.owner?.userProfileId
            version = conv.version
        } else {
            const contextId = this.context.contextId
            if (contextId.startsWith('admin:')) {
                mode = 'admin'
                userProfileId = contextId.substring(6).split(':')[0]
            } else if (contextId.startsWith('digital:')) {
                mode = 'digital'
                account = contextId.substring(8).split(':')[0]
            }
            const vmatch = contextId.match(/(?:^|:)v=([^:]+)/)
            if (vmatch) version = vmatch[1]
        }

        if (mode === 'admin') {
            const session = await this.accountService.getSessionAdmin(userProfileId)
            this.headers = {
                'app_origin': 'admin',
                'access_token': session?.accessToken
            }
            this.isAdminMode = true
            this.isDigitalMode = false

        } else if (mode === 'digital') {
            const session = await this.accountService.getSessionDigital(account)
            this.headers = {
                'app_origin': 'digital',
                'access_token': session?.accessToken
            }
            this.isAdminMode = false
            this.isDigitalMode = true

            const accountData = await this.accountService.getAccount(account, { headers: this.headers })
            this.selectedAccount = accountData?.account
            this.selectedClientDocument = accountData?.document
            this.selectedClientName = accountData?.clientName
        }

        if (version && Utils.isValidVersion(version)) {
            this.chatVersion = version
        }
    }

    isCommandAvailable(method) {
        if (!this.chatVersion) return true                          // sem versão do chat => latest
        const commandVersion = this[method]?.version ?? '1.0.0'     // sem metadata => baseline
        return Utils.compareVersions(commandVersion, this.chatVersion) <= 0
    }

    async reset() {

        this.outputCard = undefined

        if (this.isAdminMode) {
            this.selectedAccount = undefined
            this.selectedClientDocument = undefined
            this.selectedClientName = undefined
        }

        this.selectedSymbol = undefined
        this.selectedSecurityDescription = undefined
        this.selectedOrderId = undefined
        this.selectedRequestId = undefined
        this.selectedRequestType = undefined
        this.selectedRequestSide = undefined
        this.selectedRequestStatus = undefined

        this.accountContexts = {}
        this.validateSelectedRequest = undefined

        this.queryAccountCommand = undefined
        this.querySymbolCommand = undefined
        this.portfolioRecommendationSellSymbol = undefined
    }

    async onBeforeProcessMessage(msg) {

        this.outputCard = undefined
    }

    async onBeforeProcessCommands(commands, results) {

        this.validateSelectedRequest = undefined
    }

    async onAfterProcessCommands(commands, results) {

        const request = this.getSelectedRequest(false)
        let isComplete = false

        if (request && this.validateSelectedRequest) {

            const validation = this.validateRequestStatus()
            results.push(validation)

            isComplete = validation?.requestStatus?.isComplete
        }

        if (isComplete) {
            const context = this.getAccountContext()

            // seleciona a próxima boleta pendente da conta, se houver — ordem de criação
            if (context) {
                const pending = Object.values(context.requests)
                    .filter(r => r.requestId !== context.selectedRequestId)
                    .filter(r => !this.validateRequestStatus({ request: r })?.requestStatus?.isComplete)
                    .sort((a, b) => (a.selectedTime || 0) - (b.selectedTime || 0))

                if (pending.length) {
                    const next = pending[0]

                    context.selectedRequestId = next.requestId
                    next.selectedTime = nowTick()

                    if (next.symbol && next.symbol !== this.selectedSymbol) {
                        results.push({ type: 'selectSymbol', symbol: next.symbol, instruction: `selecionando ativo ${next.symbol} para próxima boleta pendente` })
                        this.selectedSymbol = next.symbol
                    }

                    this.outputCard = { type: 'requests' }
                }
            }
        }

        await this.updateMemory()
    }

    async updateMemory() {

        if (this.isAdminMode) {
            const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
            this.selectedClientDocument = account?.document
            this.selectedClientName = account?.clientName
        }

        const security = await this.marketDataService.getSecurity(this.selectedSymbol)
        this.selectedSecurityDescription = security?.description

        const context = this.getAccountContext(true)

        const orderId = context?.selectedOrderId
        const order = context?.orders?.[orderId]
        this.selectedOrderId = order?.orderId

        const requestId = context?.selectedRequestId
        const request = context?.requests?.[requestId]
        this.selectedRequestId = request?.requestId
        this.selectedRequestType = request?.requestType
        this.selectedRequestSide = request?.side
        this.selectedRequestStatus = request?.isIncomplete ? 'COMPLETE' : 'PENDING'
    }

    async sendEvent({ type, eventType }) {

        switch (eventType) {
            case 'ORDER_SENT': return await this.onEventOrderSent()
            case 'ORDER_CANCELED': return await this.onEventOrderCanceled()
        }
    }

    async onEventOrderSent() {

        const account = this.selectedAccount
        delete this.accountContexts[account]

        await Utils.sleep(5000)

        if (this.selectedAccount != account) {
            return
        }

        this.loadOrders()
    }

    async onEventOrderCanceled() {

        const account = this.selectedAccount
        delete this.accountContexts[account]
    }

    async resolveQuerySymbolSelection({ type, symbol }) {

        let res = undefined

        if (type == 'selectSymbol' || type == 'querySymbol') {
            if (!symbol) {
                return
            }
            res = await this.querySymbol({ type: 'querySymbol', symbol })
        } else if (type == 'notResolved') {
            return AgentRuntime.instruction('querySymbol', 'informe que não foi possível identificar o ativo para consulta')
        }

        return res
    }

    async resolveSymbolSelection({ type, symbol }) {

        let res = undefined

        if (type == 'selectSymbol') {
            res = await this.selectSymbol({ type: 'selectSymbol', symbol })
        }

        return res
    }

    async resolvePortfolioRecommendationBuy({ type, symbol }) {

        // usuário escolheu o ativo de COMPRA da lista de alternativas apresentadas →
        // segue para a geração do par de boletas (venda da posição → compra do escolhido)
        if (type == 'selectSymbol' && symbol) {

            const symbolSell = this.portfolioRecommendationSellSymbol
            this.portfolioRecommendationSellSymbol = undefined

            return await this.executePortfolioRecommendation({
                type: 'executePortfolioRecommendation',
                symbolSell,
                symbolBuy: symbol
            })
        }

        // fluxo abandonado (nenhum comando resolveu) → limpa o contexto pendente
        if (type == 'notResolved') {
            this.portfolioRecommendationSellSymbol = undefined
        }

        // qualquer outra intenção → não resolve; deixa o fluxo normal seguir
        return undefined
    }

    async resolveTopPicksSector({ type, symbol, sector }) {

        let res = undefined

        if (type == 'getTopPicks') {
            res = await this.getTopPicks({ type: 'getTopPicks', symbol, sector })
        }

        return res
    }

    async resolveQueryAccountSelection({ type, accountId }) {

        let res = undefined

        if (type == 'selectAccount' || type == 'queryAccount') {
            if (!accountId) {
                return
            }
            res = await this.queryAccount({ type: 'queryAccount', accountId })
        } else if (type == 'notResolved') {
            return AgentRuntime.instruction('queryAccount', 'informe que não foi possível identificar a conta para consulta')
        }

        return res
    }

    sanitizeAccountId(accountId) {

        if (accountId === undefined || accountId === null) {
            return accountId
        }

        let value = String(accountId).trim()
        if (!value) {
            return value
        }

        const normalized = this.normalizeText(value)
        const hasDocumentLiteral = /\b(DOCUMENTO|DOCUMENT|DOC|CPF|CNPJ|RG|RNE|PASSAPORTE|PASSPORT)\b/.test(normalized)

        if (!hasDocumentLiteral) {
            return value
        }

        value = value
            .replace(/\b(documento|document|doc|cpf|cnpj|rg|rne|passaporte|passport)\b/gi, ' ')
            .replace(/[:\-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()

        // Se havia marcador de documento e existem dígitos, prioriza apenas os dígitos.
        const digits = value.replace(/\D/g, '')
        if (digits) {
            return digits
        }

        return value
    }

    normalizeText(text) {
        return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim()
    }

    async resolveAccountChange({ type, accountId }) {

        let res = undefined

        if (type == 'selectAccount') {
            await this.cancelRequest({ type: 'cancelRequest' })
            res = await this.selectAccount({ type: 'selectAccount', accountId })
        }

        return res
    }

    // async resolveAccountSelection({ type, accountId }) {

    //     const isNumber = /^\d+$/.test(accountId)

    //     // complemento de nome: tenta combinar com busca anterior
    //     if (!isNumber && this._lastAccountSearch && accountId !== this._lastAccountSearch) {
    //         const combined = `${this._lastAccountSearch} ${accountId}`.trim()
    //         const matches  = await this.accountService.findAccounts(combined)
    //         if (matches?.length > 0) {
    //             this._lastAccountSearch = undefined
    //             return await this.selectAccount({ type: 'selectAccount', accountId: combined })
    //         }
    //     }

    //     this._lastAccountSearch = undefined
    //     return await this.selectAccount({ type: 'selectAccount', accountId })
    // }

    async resolveAccountSelection({ type, accountId, showMoreOptions, optionIndex }) {

        let res = undefined

        if (type == 'selectAccount') {
            res = await this.selectAccount({ type: 'selectAccount', accountId, showMoreOptions, optionIndex })
        }

        return res
    }

    getAccountContext(acceptTemp = false) {

        let selectedAccount = this.selectedAccount

        if (!selectedAccount) {
            if (!acceptTemp) {
                return undefined
            }
            selectedAccount = 'temp'
        }

        let context = this.accountContexts[selectedAccount]
        if (!context) {
            context = {
                account: selectedAccount,
                selectedOrderId: undefined,
                selectedRequestId: undefined,
                orders: undefined,
                requests: {}
            }
            this.accountContexts[selectedAccount] = context
        }

        return context
    }

    getSelectedRequest(createIfNull = false) {

        const accountContext = this.getAccountContext(true)

        const createNew = createIfNull === 'new'

        let request = accountContext.requests[accountContext.selectedRequestId]
        if (createNew && !request?.isNew) {
            accountContext.selectedRequestId = undefined
        }

        request = accountContext.requests[accountContext.selectedRequestId]
        if (!request) {
            if (!createIfNull) {
                return undefined
            }

            const requestId = Utils.getRandomToken(16)
            request = {
                requestId,
                requestType: 'C',
                orderId: undefined,
                account: this.selectedAccount,
                symbol: this.selectedSymbol,
                side: undefined,
                quantity: undefined,
                quantityMin: undefined,
                quantityDisplay: undefined,
                priceType: 'M',
                priceLimit: undefined,
                priceTrigger: undefined,
                expireType: 'DAY',
                expireTime: undefined,
                selectedTime: undefined,
                isNew: true
            }
            accountContext.requests[requestId] = request
            accountContext.selectedRequestId = requestId
            request.selectedTime = nowTick()
        }

        return request
    }

    resolveReusableRequest(symbol, requestType) {

        const accountContext = this.getAccountContext(true)

        // 1) reaproveita a última boleta [C]/[M] do ativo selecionado (nunca [X])
        if (symbol) {
            const reusable = Object.values(accountContext.requests)
                .filter(r => r.symbol === symbol && r.requestType === requestType)
                .sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))[0]

            if (reusable) {
                accountContext.selectedRequestId = reusable.requestId
                reusable.selectedTime = nowTick()
                return reusable
            }
        }

        // 2) reaproveita a boleta em foco apenas se ainda estiver em branco (isNew) ou sem ativo vinculado
        const selected = accountContext.requests[accountContext.selectedRequestId]
        if (selected && (selected.isNew || !selected.symbol)) {
            return selected
        }

        // 3) nenhuma boleta reaproveitável — cria uma nova (não sobrescreve boleta de outro ativo)
        return this.getSelectedRequest('new')
    }

    getEditingRequests() {
        const requests = []
        for (const context of Object.values(this.accountContexts)) {
            for (const request of Object.values(context.requests)) {
                if (request.requestType != 'X') {
                    requests.push(request)
                }
            }
        }
        return requests
    }

    buildRequest({ symbol, side, quantity, volume, priceType = 'M', expireType = 'DAY' }) {
        const requestId = Utils.getRandomToken(16)
        return {
            requestId,
            requestType: 'C',
            orderId: undefined,
            account: this.selectedAccount,
            symbol,
            side,
            quantity: quantity ?? undefined,
            volume: volume ?? undefined,
            quantityMin: undefined,
            quantityDisplay: undefined,
            priceType,
            priceLimit: undefined,
            priceTrigger: undefined,
            expireType,
            expireTime: undefined,
            selectedTime: nowTick(),
            isNew: false
        }
    }

    async updateTempRequest() {

        const accountContext = this.getAccountContext()
        if (!accountContext) {
            return
        }

        const tempContext = this.accountContexts['temp']
        if (!tempContext) {
            return
        }

        delete this.accountContexts['temp']

        let selectedRequest = accountContext.requests[accountContext.selectedRequestId]

        for (const [requestId, request] of Object.entries(tempContext.requests)) {
            if (request.selectedTime > (selectedRequest?.selectedTime ?? 0)) {
                selectedRequest = request
            }
            request.account = this.selectedAccount
            accountContext.requests[requestId] = request
        }

        accountContext.selectedRequestId = selectedRequest?.requestId

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }
    }

    async resolveRequestCancelAccount({ type, accountId }) {

        let res = undefined

        if (type == 'selectAccount') {
            await this.cancelRequest({ type: 'cancelRequest' })
            res = await this.selectAccount({ type: 'selectAccount', accountId })
        }

        return res
    }

    async resolveRequestCancelType({ type, requestType, newRequest }) {

        let res = undefined

        if (type == 'setRequestType') {
            await this.cancelRequest({ type: 'cancelRequest' })
            res = await this.setRequestType({ type: 'setRequestType', requestType, newRequest })
        }

        return res
    }

    syncSelectedRequestToList() {

        const requests = this.selectedRequests
        if (!requests?.length) {
            return
        }

        // já selecionada e presente na lista → nada a fazer
        if (this.selectedRequestId && requests.some(r => r.requestId === this.selectedRequestId)) {
            return
        }

        const first = requests[0]

        // aponta a seleção para a primeira boleta, no contexto da conta que a contém
        const context = Object.values(this.accountContexts).find(c => c.requests[first.requestId])
        if (context) {
            context.selectedRequestId = first.requestId
            first.selectedTime = nowTick()
        }

        this.selectedRequestId = first.requestId
    }

    applyQuantity(request, quantity, offsetType, offset) {

        let value = quantity

        if (!value && offsetType && offset !== undefined) {
            const base = request.quantity || 0
            if (!base) return false   // sem base própria — pula esta boleta

            if (offsetType == 'U') value = base + offset
            else if (offsetType == 'P') value = base * (1 + offset / 100)

            value = Math.max(0, Math.round(value))
        }

        if (!value || value <= 0) return false

        request.quantity = value
        request.volume = undefined
        request.isNew = false

        return true
    }

    applyVolume(request, volume, offsetType, offset) {

        let value = volume

        if (!value && offsetType && offset !== undefined) {
            const base = request.volume || 0
            if (!base) return false

            if (offsetType === 'U') value = base + offset
            else if (offsetType === 'P') value = base * (1 + offset / 100)

            value = Math.max(0, Math.round(value * 100) / 100)
        }

        if (!value || value <= 0) return false

        request.volume = value
        request.quantity = undefined

        if (!request.priceType && !request.priceLimit) {
            request.priceType = 'M'
            request.priceLimit = undefined
        }

        request.isNew = false

        return true
    }

    async applyPriceType(request, priceType) {

        const oldPriceType = request.priceType

        request.priceType = priceType

        if (priceType == 'M') {
            request.priceLimit = undefined
        } else if (priceType == 'L' && oldPriceType == 'M') {
            // cotação por ativo — cada boleta usa o preço do SEU símbolo
            const quote = await this.marketDataService.getQuote(request.symbol)
            if (quote) {
                request.priceLimit = request.side == 'B' ? quote.askPrice : quote.bidPrice
            }
        }

        request.isNew = false
    }

    async applyPriceLimit(request, priceLimit, reference, offset, offsetType) {

        let value = priceLimit

        if (!value) {

            // referência [T] ao preço GATILHO (stop) da própria boleta — não depende de cotação de mercado
            if (reference == 'T') {
                if (!request.priceTrigger) return false   // sem gatilho definido — não há referência
                value = request.priceTrigger
            } else {
                const quote = await this.marketDataService.getQuote(request.symbol)
                if (!quote) return false   // sem cotação do ativo — não há referência

                value = quote.lastPrice
                if (reference == 'B') value = quote.bidPrice
                else if (reference == 'A') value = quote.askPrice
                else if (reference == 'R') value = request.priceLimit || quote.lastPrice
            }

            let effectiveOffset = offset
            if (reference == 'T' && request.side) {
                effectiveOffset = Math.abs(offset) * (request.side == 'B' ? 1 : -1)
            }

            if (offsetType == 'P') value = value * (1 + effectiveOffset / 100)
            else if (offsetType == 'U') value = value + effectiveOffset
            else if (offsetType == 'T') {
                const security = await this.marketDataService.getSecurity(request.symbol)
                value = value + effectiveOffset * (security?.minPriceIncrement || 0)
            }
        }

        request.priceLimit = value
        request.priceType = 'L'
        request.isNew = false

        return true
    }

    async applyPriceTrigger(request, priceTrigger, reference, offset, offsetType) {

        let value = priceTrigger

        if (!value) {
            const quote = await this.marketDataService.getQuote(request.symbol)
            if (!quote) return false   // sem cotação do ativo — não há referência

            value = quote.lastPrice
            if (reference == 'B') value = quote.bidPrice
            else if (reference == 'A') value = quote.askPrice
            else if (reference == 'R') value = request.priceTrigger || quote.lastPrice

            if (offsetType == 'P') value = value * (1 + offset / 100)
            else if (offsetType == 'U') value = value + offset
            else if (offsetType == 'T') {
                const security = await this.marketDataService.getSecurity(request.symbol)
                value = value + offset * (security?.minPriceIncrement || 0)
            }
        }

        request.priceTrigger = value
        request.isNew = false

        return true
    }

    applyExpireType(request, expireType) {

        if (expireType === 'GTD' && !request.expireTime) {
            const today = new Date()
            today.setHours(23, 59, 59, 0)
            request.expireTime = today.toISOString().split('T')[0]
        }

        request.expireType = expireType

        if (request.expireType !== 'GTD') {
            request.expireTime = undefined
        }

        if (request.expireType !== 'IOC') {
            request.quantityMin = undefined
        }

        request.isNew = false
    }

    applyExpireTime(request, expireTime) {

        request.expireType = 'GTD'
        request.expireTime = expireTime

        request.isNew = false
    }

    getAllRequests(account) {

        const collect = context =>
            context ? Object.values(context.requests) : []

        const allRequests = account
            ? collect(this.accountContexts[account])
            : Object.values(this.accountContexts).flatMap(collect)

        return allRequests.sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))
    }

    async getOrderStatusText(order) {

        if (order.orderStatus === 'XR') {
            // rejeição: o motivo técnico precisa ser traduzido para linguagem de negócio via LLM
            const executed = (order.filledQuantity || 0) > 0
                ? `Já houve execução: ${order.filledQuantity} cotas, volume de ${order.filledVolume ?? 0} e preço médio de ${order.filledAveragePrice ?? 0}. Preserve essa informação. `
                : ''

            const prompt =
                `A ordem do ativo ${order.symbol} (${order.side === 'B' ? 'compra' : 'venda'}) foi REJEITADA. ${executed}` +
                `Traduza o motivo técnico abaixo para uma explicação curta, natural e clara em português, como se falasse com um cliente. ` +
                `NÃO copie o texto literal. NÃO use termos técnicos, nomes de campos, código ou os caracteres [ ] { } ( ) | / " nem a palavra "null". ` +
                `Se indicar campo ausente ou inválido, descreva em linguagem de negócio — ex.: "a quantidade da ordem não foi informada", "o preço limite não foi definido". ` +
                `Motivo técnico: "${order.statusText || 'não informado'}".`

            return await this.llmService.execute(prompt, 'text')
        }

        const parts = []

        if ((order.filledQuantity || 0) > 0) {
            parts.push(`a ordem já teve execução: quantidade executada de ${order.filledQuantity}, volume financeiro executado de ${order.filledVolume ?? 0} e preço médio executado de ${order.filledAveragePrice ?? 0}.`)
        }

        switch (order.orderStatus) {
            case 'F':
                parts.push('a ordem foi executada por completo e está finalizada.')
                break
            case 'X':
                parts.push('a ordem está cancelada.')
                break
            case 'XP':
                parts.push('a ordem expirou.')
                break
            case 'XR':
                parts.push(`a ordem foi rejeitada. Motivo: ${order.statusText || 'não informado'}.`)
                break
            case 'N':
                parts.push('a ordem está aberta e registrada no book, aguardando execução.')
                break
            default:
                if (order.orderStatus) {
                    parts.push(`status atual da ordem: ${order.orderStatus}.`)
                } else {
                    parts.push('status atual da ordem indisponível.')
                }
                break
        }

        return parts.join(' ')
    }

    async loadOrders(accountContext) {

        if (!accountContext) {
            accountContext = await this.getAccountContext()
            if (!accountContext) {
                return
            }
        }

        let orders = accountContext.orders

        if (!orders) {
            orders = await this.orderService.getOpenOrders(accountContext.account)
            orders = orders.sort((a, b) => new Date(a.creationTime).getTime() - new Date(b.creationTime).getTime())
            orders = orders.map((o) => {

                let priceType = o.priceType
                let priceLimit = o.priceLimit
                let priceTrigger = undefined
                if (o.priceTriggerStop) {
                    priceTrigger = o.priceTriggerStop
                    priceLimit = o.priceLimitStop
                }
                if (!priceLimit) {
                    priceType = 'M'
                }

                return {
                    orderId: o.orderId,
                    account: o.account,
                    symbol: o.symbol,
                    side: o.side,

                    quantity: o.quantity,
                    quantityMin: o.quantityMin,
                    quantityDisplay: o.quantityDisplay,
                    priceType,
                    priceLimit,
                    priceTrigger,

                    expireType: o.expireType,
                    expireTime: o.expireTime,
                    creationTime: o.creationTime,

                    orderStatus: o.orderStatus,
                    statusText: o.statusText,
                    requestType: o.requestType,
                    requestStatus: o.requestStatus,

                    pendingQuantity: o.pendingQuantity,
                    filledQuantity: o.filledQuantity,
                    filledAveragePrice: o.filledAveragePrice,
                    filledVolume: o.filledVolume,
                    pendingVolume: o.pendingVolume,

                    selectedTime: nowTick()
                }
            })
            const entries = orders.map(o => [o.orderId, o])
            accountContext.orders = Object.fromEntries(entries)
        }

        orders = Object.values(orders).sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))

        if (!this.selectedOrderId) {
            if (this.selectedSymbol) {
                let sort = false
                for (let order of orders) {
                    if (order.symbol === this.selectedSymbol) {
                        order.selectedTime = nowTick()
                        accountContext.selectedOrderId = order.orderId
                        this.selectedOrderId = accountContext.selectedOrderId
                        sort = true
                        break
                    }
                }

                if (sort) {
                    orders = Object.values(orders).sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))
                }
            } else if (orders.length) {
                accountContext.selectedOrderId = orders[0].orderId
                this.selectedOrderId = accountContext.selectedOrderId
                await this.selectSymbol({ type: 'selectSymbol', symbol: orders[0].symbol })
            }
        }

        return orders
    }

    async getDataAccountSelection() {

        let output = undefined

        const options = this.outputCard?.options
        if (options?.length) {
            output = {
                search: this.outputCard.search,
                results: options.map(o => ({
                    account: o.account,
                    clientName: o.clientName,
                    institution: o.institution,
                    segment: o.segment
                }))
            }
        }

        return {
            output_type: 'selection_card@account',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataSymbolSelection() {

        let output = undefined

        const options = this.outputCard?.options
        if (options?.length) {
            output = {
                search: this.outputCard.search,
                results: options.map(o => ({
                    symbol: o.symbol,
                    description: o.description
                }))
            }
        }

        return {
            output_type: 'selection_card@symbol',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getMessage() {

        if (this.outputCard?.type == 'account_selection') {
            return `Encontrei as seguintes contas para "${this.outputCard.search}".`
        }

        if (this.outputCard?.type == 'symbol_selection') {
            return `Encontrei os seguintes ativos para "${this.outputCard.search}".`
        }

        if (this.outputCard?.type == 'top_picks_sectors') {
            return `Encontrei os seguintes setores para consulta de Top Picks de acordo com o time de analistas do time de Research:`
        }

        if (this.outputCard?.type == 'top_picks') {
            const sector = this.outputCard.sector
            if (sector) {
                return `Aqui estão as Top-Picks para o setor ${sector.sector}, de acordo com o time de analistas do time de Research:`
            }
            return `Aqui estão as Top-Picks, de acordo com o time de analistas do time de Research:`
        }

        if (this.outputCard?.type == 'fundamentals_recommendation') {
            return `Aqui está o resumo de ${this.selectedSymbol}, de acordo com o time de analistas do time de Research:`
        }

        if (this.outputCard?.type == 'fundamentals_summary') {
            return `Aqui está a tese de ${this.selectedSymbol}, de acordo com o time de analistas do time de Research:`
        }

        if (this.outputCard?.type == 'fundamentals') {
            return `Aqui estão os principais indicadores da análise fundamentalista de ${this.selectedSymbol}, de acordo com o time de analistas do time de Research:`
        }

        if (this.outputCard?.type == 'security') {
            return `Aqui estão as principais características de ${this.selectedSymbol}:`
        }

        if (this.outputCard?.type == 'quote') {
            return `Aqui estão os valores atualizados de ${this.selectedSymbol}:`
        }

        if (this.outputCard?.type == 'lending') {
            return `Aqui está a taxa de aluguel de ${this.selectedSymbol}:`
        }

        if (this.outputCard?.type == 'lending_unavailable') {
            return `Não foi possível obter a taxa de aluguel de ${this.selectedSymbol} no momento. Por favor, entre em contato com a mesa de operações.`
        }

        if (this.outputCard?.type == 'portfolio_analysis') {
            return 'De acordo com o conteúdo do time de Research, esta é uma possível leitura para a carteira selecionada:'
        }

        if (this.outputCard?.type == 'portfolio_recommendation_sell') {
            return 'Considerando as análises do time de Research, essas são as posições sem alinhamento com as recomendações:'
        }

        if (this.outputCard?.type == 'portfolio_recommendation_buy') {
            return `Considerando as análises do time de Research, estes são os ativos com recomendação de compra para o mesmo setor de ${this.outputCard.symbol}:`
        }

        if (this.outputCard?.type == 'financial') {
            return `Aqui está um resumo financeiro da conta ${this.selectedAccount}:`
        }

        if (this.outputCard?.type == 'position_summary') {
            return `Aqui está um resumo de posição da conta ${this.selectedAccount}:`
        }

        if (this.outputCard?.type == 'position') {
            return `Aqui está a posição de ${this.selectedSymbol} da conta ${this.selectedAccount}:`
        }

        if (this.outputCard?.type == 'orders') {
            if (this.outputCard.statusText) {
                return this.outputCard.statusText
            }
            return `Aqui estão as ordens vigentes da conta ${this.selectedAccount}:`
        }

        if (this.outputCard?.type == 'requests') {

            const allRequests = this.getAllRequests()

            let validation = this.validateRequestStatus()
            if (validation?.requestStatus?.isComplete) {
                validation = undefined
            }

            if (!validation) {
                for (const request of allRequests) {
                    let rvalidation = await this.validateRequestStatus({ request })
                    if (!rvalidation?.requestStatus?.isComplete) {
                        validation = rvalidation
                        break
                    }
                }
            }

            if (validation?.requestStatus) {

                let pending = []

                for (let field of validation.requestStatus.pendingFields) {
                    switch (field) {
                        case 'requestType': pending.push('- tipo de ordem'); break
                        case 'account': pending.push('- número da conta'); break
                        case 'symbol': pending.push('- código do ativo'); break
                        case 'side': pending.push('- direção (compra ou venda)'); break
                        case 'quantity_or_volume': pending.push('- quantidade ou volume financeiro'); break
                        case 'priceType_or_priceLimit': pending.push('- preço mercado ou limite'); break
                        case 'expireType_or_expireTime': pending.push('- tipo ou data de expieração'); break
                        default: pending.push(field)
                    }
                }

                pending = pending.join('\n')

                let orderSpec = ['a ordem']
                if (allRequests.length > 1) {
                    const request = this.getSelectedRequest()
                    if (request?.side) {
                        orderSpec.push(request.side === 'B' ? 'de compra' : 'de venda')
                    }
                    if (request?.symbol) {
                        orderSpec.push(`de ${request.symbol}`)
                    }
                }
                orderSpec = orderSpec.join(' ')

                return `Para completar ${orderSpec}, preciso das seguintes informações:\n${pending}`
            }

            if (allRequests.length > 1) {
                return `Ok, aqui estão as suas ordens. Confira os dados atentamente antes de enviá-las.`
            } else if (allRequests.length > 0) {
                return `Ok, aqui está a sua ordem. Confira os dados atentamente antes de enviá-la.`
            }
        }

        return undefined
    }

    async getData() {

        if (this.outputCard?.type == 'account_selection') {
            return await this.getDataAccountSelection()
        }

        if (this.outputCard?.type == 'symbol_selection') {
            return await this.getDataSymbolSelection()
        }

        if (this.outputCard?.type == 'top_picks_sectors') {
            return await this.getDataTopPicksSectors()
        }

        if (this.outputCard?.type == 'top_picks') {
            return await this.getDataTopPicks()
        }

        if (this.outputCard?.type == 'fundamentals_recommendation') {
            return await this.getDataFundamentalsRecommendation()
        }

        if (this.outputCard?.type == 'fundamentals_summary') {
            return await this.getDataFundamentalsSummary()
        }

        if (this.outputCard?.type == 'fundamentals') {
            return await this.getDataFundamentals()
        }

        if (this.outputCard?.type == 'orders') {
            return await this.getDataOrders()
        }

        if (this.outputCard?.type == 'security') {
            return await this.getDataSecurity()
        }

        if (this.outputCard?.type == 'lending') {
            return await this.getDataLending()
        }

        if (this.outputCard?.type == 'quote') {
            return await this.getDataQuote()
        }

        if (this.outputCard?.type == 'portfolio_analysis') {
            return await this.getDataPortfolioAnalysis()
        }

        if (this.outputCard?.type == 'portfolio_recommendation_sell') {
            return await this.getDataPortfolioRecommendationSell()
        }

        if (this.outputCard?.type == 'portfolio_recommendation_buy') {
            return await this.getDataPortfolioRecommendationBuy()
        }

        if (this.outputCard?.type == 'financial') {
            return await this.getDataFinancial()
        }

        if (this.outputCard?.type == 'position_summary') {
            return await this.getDataPositionSummary()
        }

        if (this.outputCard?.type == 'position') {
            return await this.getDataPosition()
        }

        if (this.outputCard?.type == 'requests') {
            return this.getDataRequests()
        }
    }

    async getDataFinancial() {

        const data = this.outputCard?.data ?? {}

        const fmtMoney = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

        const allFields = [
            { key: 'balanceD0', name: 'Saldo Inicial (D0)', format: fmtMoney },
            { key: 'balanceProjectedD1', name: 'Saldo Projetado (D+1)', format: fmtMoney },
            { key: 'balanceProjectedD2', name: 'Saldo Projetado (D+2)', format: fmtMoney },
            { key: 'balanceProjected', name: 'Saldo Projetado', format: fmtMoney },
            { key: 'availableBalance', name: 'Limite Operacional', format: fmtMoney },
            { key: 'totalFreeze', name: 'Valores Bloqueados', format: fmtMoney },
            { key: 'totalEquity', name: 'Patrimônio Consolidado', format: fmtMoney },
            { key: 'daytradeAllocatedLimit', name: 'Limite Daytrade Alocado', format: fmtMoney },
            { key: 'daytradeAvailableLimit', name: 'Limite Daytrade Disponível', format: fmtMoney },
            { key: 'profitDaytrade', name: 'Resultado Daytrade', format: fmtMoney },
        ]

        // projeta apenas os campos presentes em card.data
        const visibleFields = allFields.filter(f => data[f.key] !== undefined)

        let output = undefined
        if (visibleFields.length) {
            output = {
                account: this.selectedAccount,
                properties: visibleFields.map(f => ({
                    name: f.name,
                    value: (data[f.key] !== undefined && data[f.key] !== null) ? f.format(data[f.key]) : '-'
                }))
            }
        }

        return {
            output_type: 'financial_card@summary',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataPositionSummary() {

        const data = this.outputCard?.data ?? {}

        const fmtMoney = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
        const fmtPct = v => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
        const fmtInt = v => v.toLocaleString('pt-BR')

        const allFields = [
            { key: 'positionCount', name: 'Ativos em Carteira', format: fmtInt },
            { key: 'volume', name: 'Volume Investido', format: fmtMoney },
            { key: 'profit', name: 'Resultado Acumulado', format: fmtMoney },
            { key: 'profitPercent', name: 'Resultado Acumulado (%)', format: fmtPct },
            { key: 'profitD0', name: 'Resultado do Dia', format: fmtMoney },
            { key: 'profitPercentD0', name: 'Resultado do Dia (%)', format: fmtPct },
        ]

        // projeta apenas os campos presentes em card.data
        const visibleFields = allFields.filter(f => data[f.key] !== undefined)

        let output = undefined
        if (visibleFields.length) {
            output = {
                account: this.selectedAccount,
                properties: visibleFields.map(f => ({
                    name: f.name,
                    value: (data[f.key] !== undefined && data[f.key] !== null) ? f.format(data[f.key]) : '-'
                }))
            }
        }

        return {
            output_type: 'position_card@summary',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataPosition() {

        const data = this.outputCard?.data ?? {}

        const fmtMoney = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
        const fmtShare = v => `R$ ${v.toFixed(2)}`
        const fmtPct = v => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
        // quantidade: inteiro sem casas decimais; fracionário (ex.: cripto) até 8 casas, sem zeros à direita
        const fmtQty = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 8 })
        const fmtText = v => v

        const allFields = [

            { key: 'totalQuantity', name: 'Quantidade Total', format: fmtQty },
            { key: 'blockedQuantity', name: 'Quantidade Bloqueada', format: fmtQty },
            { key: 'availableQuantity', name: 'Quantidade Disponível', format: fmtQty },
            { key: 'quantityD0', name: 'Quantidade (D0)', format: fmtQty },
            { key: 'quantityProjectedD1', name: 'Quantidade Projetada (D+1)', format: fmtQty },
            { key: 'quantityProjectedD2', name: 'Quantidade Projetada (D+2)', format: fmtQty },

            { key: 'volume', name: 'Volume Atual', format: fmtMoney },
            { key: 'investedVolume', name: 'Volume Investido', format: fmtMoney },
            { key: 'investedVolumeAdjusted', name: 'Volume Investido Ajustado', format: fmtMoney },
            { key: 'earningsVolume', name: 'Proventos Recebidos', format: fmtMoney },

            { key: 'avgPrice', name: 'Preço Médio', format: fmtShare },
            { key: 'avgPriceAdjusted', name: 'Preço Médio Ajustado', format: fmtShare },

            { key: 'profit', name: 'Resultado Acumulado', format: fmtMoney },
            { key: 'profitPercent', name: 'Resultado Acumulado (%)', format: fmtPct },
            { key: 'profitD0', name: 'Resultado do Dia', format: fmtMoney },
            { key: 'profitPercentD0', name: 'Resultado do Dia (%)', format: fmtPct },

            { key: 'yieldOnCost', name: 'Yield on Cost (%)', format: fmtPct },
            { key: 'positionWeight', name: 'Peso na Carteira (%)', format: fmtPct },
        ]

        // projeta apenas os campos presentes em card.data
        const visibleFields = allFields.filter(f => data[f.key] !== undefined)

        let output = undefined
        if (visibleFields.length) {
            output = {
                account: this.selectedAccount,
                symbol: this.selectedSymbol,
                properties: visibleFields.map(f => ({
                    name: f.name,
                    value: (data[f.key] !== undefined && data[f.key] !== null) ? f.format(data[f.key]) : '-'
                }))
            }
        }

        return {
            output_type: 'position_card@detail',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataSecurity() {

        const security = await this.marketDataService.getSecurity(this.selectedSymbol)
        const topPick = await this.marketDataService.getIsTopPick(this.selectedSymbol)

        let filters = undefined
        if (this.outputCard?.fields instanceof Array) {
            filters = Object.fromEntries(this.outputCard.fields.map(o => [o, true]))
        }

        let output = undefined
        if (security) {

            const allFields = [
                { key: 'description', name: 'Descrição', format: v => v },
                { key: 'exchange', name: 'Bolsa', format: v => v },
                { key: 'securityType', name: 'Tipo', format: v => v },
                { key: 'lot', name: 'Lote Padrão', format: v => v.toLocaleString('pt-BR') },
                { key: 'minPriceIncrement', name: 'Variação Mínima', format: v => `R$ ${v.toFixed(2)}` },
            ]

            const visibleFields = filters
                ? allFields.filter(f => filters[f.key])
                : allFields

            output = {
                symbol: security.symbol,
                topPick,
                properties: visibleFields.map(f => ({
                    name: f.name,
                    value: (security[f.key] !== undefined && security[f.key] !== null) ? f.format(security[f.key]) : '-'
                }))
            }
        }

        return {
            output_type: 'content_card@security',
            output_status: security ? 'success' : 'not_found',
            output
        }
    }

    async getDataLending() {
        const topPick = await this.marketDataService.getIsTopPick(this.selectedSymbol)
        const fee = this.outputCard?.fee

        let output = undefined
        if (fee != null) {
            const feeText = fee.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            output = {
                symbol: this.selectedSymbol,
                topPick,
                properties: [
                    { name: 'Taxa de aluguel', value: `${feeText}% a.a.` }
                ]
            }
        }

        return {
            output_type: 'content_card@security',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataQuote() {

        const security = await this.marketDataService.getSecurity(this.selectedSymbol)
        const priceUnit = security?.priceUnit

        const quote = await this.marketDataService.getQuote(this.selectedSymbol)
        const topPick = await this.marketDataService.getIsTopPick(this.selectedSymbol)

        let filters = undefined
        if (this.outputCard?.fields instanceof Array) {
            filters = Object.fromEntries(this.outputCard.fields.map(o => [o, true]))
        }

        const fmtMoney = v => {
            const [rawUnit, rawPlaces] = String(priceUnit || 'PTS.0').split('.')
            const unit = (rawUnit || 'PTS').toUpperCase()
            const parsed = parseInt(rawPlaces, 10)
            const decimals = Number.isFinite(parsed) ? parsed : 0

            // pontos: número puro, sem símbolo
            if (unit === 'PTS') {
                return v.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
            }

            // percentual: número seguido de %
            if (unit === 'PCT') {
                return `${v.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`
            }

            // moeda: símbolo da moeda informada (BRL, USD, ...)
            return v.toLocaleString('pt-BR', {
                style: 'currency',
                currency: unit,
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            })
        }

        let output = undefined
        if (quote) {

            const allFields = [
                // { key: 'lastPrice', name: 'Último Preço', format: fmtMoney },
                // { key: 'changePercent', name: 'Variação', format: v => `${v > 0 ? '+' : ''}${v.toFixed(2)}%` },
                { key: 'bidPrice', name: 'Compra (Bid)', format: fmtMoney },
                { key: 'askPrice', name: 'Venda (Ask)', format: fmtMoney },
            ]

            const visibleFields = filters
                ? allFields.filter(f => filters[f.key])
                : allFields

            output = {
                symbol: quote.symbol,
                topPick,
                properties: visibleFields.map(f => ({
                    name: f.name,
                    value: (quote[f.key] !== undefined && quote[f.key] !== null) ? f.format(quote[f.key]) : '-'
                }))
            }
        }

        return {
            output_type: 'content_card@quote',
            output_status: quote ? 'success' : 'not_found',
            output
        }
    }

    async getDataPortfolioAnalysis() {

        const overview = await this.portfolioRecommender.getPortfolioAnalysisOverview(this.selectedAccount)

        return {
            output_type: 'portfolio_card@overview',
            output_status: overview ? 'success' : 'not_found',
            output: overview
        }
    }

    async getDataPortfolioRecommendationSell() {

        let output = undefined

        const items = this.outputCard?.data
        if (items?.length) {
            output = {
                positions: items.map(p => ({
                    sector: p.sector,
                    symbol: p.symbol,
                    quantity: p.quantity,
                    volume: p.volume,
                    profit: p.profit,
                    profitPercent: p.profitPercent
                }))
            }
        }

        return {
            output_type: 'portfolio_card@recommendation_sell',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataPortfolioRecommendationBuy() {

        let output = undefined

        const items = this.outputCard?.data
        if (items?.length) {
            output = {
                symbol: this.outputCard?.symbol,
                recommendations: items.map(p => ({
                    sector: p.sector,
                    symbol: p.symbol,
                    topPick: !!p.topPick,
                    recommendation: p.recommendation,
                    targetPrice: p.targetPrice,
                    upside: p.upside
                }))
            }
        }

        return {
            output_type: 'portfolio_card@recommendation_buy',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataFundamentals() {

        const fundamentals = await this.marketDataService.getFundamentals(this.selectedSymbol)
        const topPick = await this.marketDataService.getIsTopPick(this.selectedSymbol)

        let filters = undefined
        if (this.outputCard?.fields instanceof Array) {
            filters = Object.fromEntries(this.outputCard.fields.map(o => [o, true]))
        }

        let output = undefined
        if (fundamentals) {

            const fmtMoney = v =>
                v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact' })
            const fmtMult = v => `${v.toFixed(2)}x`
            const fmtPct = v => `${v.toFixed(2)}%`
            const fmtNum = v => v.toFixed(2)
            const fmtShare = v => `R$ ${v.toFixed(2)}`
            const fmtDate = v => new Date(v).toLocaleDateString('pt-BR')
            const fmtBool = v => v ? 'Sim' : 'Não'

            const allFields = [
                { key: 'marketCapital', name: 'Market Cap', format: fmtMoney },
                { key: 'enterpriseValue', name: 'Enterprise Value (EV)', format: fmtMoney },

                { key: 'assets', name: 'Ativo Total', format: fmtMoney },
                { key: 'equity', name: 'Patrimônio Líquido', format: fmtMoney },
                { key: 'equityToAssets', name: 'PL / Ativos (%)', format: fmtPct },
                { key: 'currentAssets', name: 'Ativo Circulante', format: fmtMoney },
                { key: 'netCurrentAssets', name: 'Ativo Circ. Líquido', format: fmtMoney },
                { key: 'liabilities', name: 'Passivo Total', format: fmtMoney },
                { key: 'currentLiabilities', name: 'Passivo Circulante', format: fmtMoney },
                { key: 'currentRatio', name: 'Liquidez Corrente', format: fmtNum },

                { key: 'grossDebt', name: 'Dívida Bruta', format: fmtMoney },
                { key: 'grossDebtToEquity', name: 'Dív. Bruta / PL', format: fmtMult },
                { key: 'netDebt', name: 'Dívida Líquida', format: fmtMoney },
                { key: 'netDebtToEbit', name: 'Dív. Líq. / EBIT', format: fmtMult },
                { key: 'netDebtToEbitda', name: 'Dív. Líq. / EBITDA', format: fmtMult },
                { key: 'netDebtToEquity', name: 'Dív. Líq. / PL', format: fmtMult },

                { key: 'assetTurnover', name: 'Giro do Ativo', format: fmtMult },
                { key: 'capitalTurnover', name: 'Giro do Capital', format: fmtMult },
                { key: 'priceToCapitalTurnover', name: 'Preço / Giro do Capital', format: fmtMult },

                { key: 'netRevenue', name: 'Receita Líquida', format: fmtMoney },
                { key: 'ebit', name: 'EBIT', format: fmtMoney },
                { key: 'ebitda', name: 'EBITDA', format: fmtMoney },
                { key: 'netIncome', name: 'Lucro Líquido', format: fmtMoney },

                { key: 'grossMargin', name: 'Margem Bruta (%)', format: fmtPct },
                { key: 'ebitMargin', name: 'Margem EBIT (%)', format: fmtPct },
                { key: 'ebitdaMargin', name: 'Margem EBITDA (%)', format: fmtPct },
                { key: 'netMargin', name: 'Margem Líquida (%)', format: fmtPct },

                { key: 'dividendYield', name: 'Dividend Yield (%)', format: fmtPct },
                { key: 'priceToEarnings', name: 'P/L', format: fmtMult },
                { key: 'priceToEarningsToGrowth', name: 'PEG', format: fmtMult },
                { key: 'priceToBook', name: 'P/VP', format: fmtMult },
                { key: 'priceToAssets', name: 'P/Ativos', format: fmtMult },
                { key: 'priceToEbit', name: 'P/EBIT', format: fmtMult },
                { key: 'priceToEbitda', name: 'P/EBITDA', format: fmtMult },
                { key: 'priceToSales', name: 'P/Receita (PSR)', format: fmtMult },
                { key: 'priceToNetCurrentAsset', name: 'P/Ativo Circ. Líq.', format: fmtMult },
                { key: 'enterpriseValueToEbit', name: 'EV/EBIT', format: fmtMult },
                { key: 'enterpriseValueToEbitda', name: 'EV/EBITDA', format: fmtMult },

                { key: 'returnOnInvestedCapital', name: 'ROIC (%)', format: fmtPct },
                { key: 'returnOnEquity', name: 'ROE (%)', format: fmtPct },
                { key: 'returnOnAsset', name: 'ROA (%)', format: fmtPct },
                { key: 'growthRate', name: 'Taxa de Crescimento (%)', format: fmtPct },

                { key: 'earningsPerShare', name: 'LPA', format: fmtShare },
                { key: 'bookValuePerShare', name: 'VPA', format: fmtShare },
                { key: 'dividendPerShare', name: 'DPA', format: fmtShare },
                { key: 'salesPerShare', name: 'Receita por Ação', format: fmtShare },

                { key: 'earningsDate', name: 'Data dos Resultados', format: fmtDate },
                { key: 'analysisDate', name: 'Data da Análise', format: fmtDate },
                { key: 'hasAnalysis', name: 'Possui Análise', format: fmtBool },
            ]

            const visibleFields = filters
                ? allFields.filter(f => filters[f.key])
                : allFields

            output = {
                symbol: fundamentals.symbol,
                topPick,
                fundamentalist: visibleFields.map(f => ({
                    name: f.name,
                    value: (fundamentals[f.key] !== undefined && fundamentals[f.key] !== null) ? f.format(fundamentals[f.key]) : '-'
                }))
            }
        }

        return {
            output_type: 'content_card@fundamentalist',
            output_status: fundamentals ? 'success' : 'not_found',
            output
        }
    }

    async getDataFundamentalsRecommendation() {

        const fundamentals = await this.marketDataService.getFundamentals(this.selectedSymbol)
        const topPick = await this.marketDataService.getIsTopPick(this.selectedSymbol)

        let output = undefined
        if (fundamentals) {
            output = {
                symbol: fundamentals.symbol,
                topPick
            }
        }

        return {
            output_type: 'content_card@asset_detail',
            output_status: fundamentals ? 'success' : 'not_found',
            output
        }
    }

    async getDataFundamentalsSummary() {

        const data = this.outputCard.data

        let output = undefined
        if (data) {
            output = {
                "symbol": this.selectedSymbol,
                "thesis": data.fullSummary
            }
        }

        return {
            output_type: "content_card@summary",
            output_status: data ? 'success' : 'not_found',
            output
        }
    }

    async getDataTopPicks() {

        const output = this.outputCard.sector

        return {
            output_type: "content_card@top_picks",
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataTopPicksSectors() {

        const sectors = this.outputCard?.sectors

        let output = undefined
        if (sectors?.length) {
            output = { sectors }
        }

        return {
            output_type: 'content_card@top_picks_sectors',
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    async getDataOrders() {

        let output = undefined

        let orders = this.outputCard?.orders
        if (!orders) {
            orders = await this.loadOrders()
        }

        if (orders?.length) {
            output = orders.map(o => {
                return {
                    orderId: o.orderId,
                    account: o.account,
                    symbol: o.symbol,
                    side: o.side,
                    quantity: o.quantity,
                    quantityMin: o.quantityMin,
                    quantityDisplay: o.quantityDisplay,
                    priceType: o.priceType,
                    price: o.priceLimit,
                    trigger: o.priceTrigger,
                    expireType: o.expireType,
                    expireTime: o.expireTime,
                    creationTime: o.creationTime,
                    orderStatus: o.orderStatus,
                    statusText: o.statusText,
                    requestType: o.requestType,
                    requestStatus: o.requestStatus,
                    pendingQuantity: o.pendingQuantity,
                    filledQuantity: o.filledQuantity,
                    filledAveragePrice: o.filledAveragePrice,
                    filledVolume: o.filledVolume,
                    pendingVolume: o.pendingVolume
                }
            })
        }

        return {
            output_type: "open_order_card",
            output_status: output ? 'success' : 'not_found',
            output
        }
    }

    getDataRequests() {

        const allRequests = this.outputCard?.requests ?? this.getAllRequests()

        // verifica se alguma boleta tem pendência
        const isIncomplete = (r) =>
            !r.requestType ||
            !r.account ||
            !r.symbol ||
            !r.side ||
            (!r.quantity && !r.volume) ||
            (r.priceType !== 'M' && !r.priceLimit) ||
            (!r.expireType && !r.expireTime)

        const hasIncomplete = allRequests.some(isIncomplete)

        const output = allRequests.map(r => ({
            requestType: r.requestType || '',
            orderId: r.orderId || '',
            account: r.account || '',
            symbol: r.symbol || '',
            side: r.side || '',
            quantity: r.quantity || 0,
            quantityDisplay: r.quantityDisplay || 0,
            volume: r.volume || 0,
            priceType: r.priceType || '',
            price: r.priceLimit || '',
            trigger: r.priceTrigger || '',
            expireType: r.expireType || '',
            expireDate: r.expireTime ? new Date(r.expireTime).toISOString().split('T')[0] : '',
            strategy: 'P'
        }))

        let output_type = 'order_card'
        if (allRequests.length > 1) {
            output_type = 'basket_card'
        } else if (allRequests.length == 1) {
            if (allRequests[0].requestType == 'M') {
                output_type = 'order_card@modify'
            } else if (allRequests[0].requestType == 'X') {
                output_type = 'order_card@cancel'
            }
        }

        return {
            output_type,
            output_status: hasIncomplete ? 'incomplete' : 'success',
            output
        }
    }
}

class TraderAgent extends BaseAgent {
    /* # COMMAND
    
    representa a intenção de reproduzir uma consulta anterior para um ativo diferente

    @note emitir quando o usuário solicitar para "ver a mesma coisa para outro ativo" ou expressar intenção similar de reutilizar a consulta anterior para um ativo diferente.
    @note se o ativo for citado no mesmo input ("e a VALE3?"), incluir em [symbol]; se não, o sistema questiona e aguarda resposta via [QuerySymbolSelection].
    @note[QuerySymbolSelection] esta é uma RESPOSTA do usuário indicando QUAL ativo deseja conferir — emitir SEMPRE [selectSymbol] com o ativo informado. NÃO re-emitir [querySymbol]. A consulta anterior é reaplicada automaticamente ao novo ativo.

    @input symbol: str (opcional) -> novo ativo a consultar. Se omitido, o sistema solicita ao usuário via [QuerySymbolSelection]

    @example (HIST consultou preço de PETR4) [user] confere outro ativo -> { "type": "querySymbol" }
    @example (HIST consultou preço de PETR4) [user] e a VALE3? -> { "type": "querySymbol", "symbol": "VALE3" }
    @example[QuerySymbolSelection] (HIST consultou preço de PETR4) [user] confere outro ativo -> [agent] qual ativo deseja conferir? -> (INPUT) [user] VALE3 -> { "type": "selectSymbol", "symbol": "VALE3" }
    @example[QuerySymbolSelection] (HIST consultou fundamentos de ITUB4) [user] quero ver outro -> [agent] qual ativo? -> (INPUT) [user] a BBAS3 -> { "type": "selectSymbol", "symbol": "BBAS3" }

    */
    async querySymbol({ type, symbol }) {

        if (!symbol || symbol === this.selectedSymbol) {
            return AgentRuntime.interrupt({ type, symbol },
                `questione qual ativo deseja consultar`,
                'QuerySymbolSelection'
            )
        }

        let res = await this.selectSymbol({ type: 'selectSymbol', symbol })

        if (this.querySymbolCommand) {
            const cmd = this.querySymbolCommand
            if (cmd.symbol) {
                cmd.symbol = this.selectedSymbol
            }

            const fn = this[cmd.type]
            if (fn) {
                res = await fn.call(this, cmd)
            }
        }

        return res
    }

    /* # COMMAND

    seleciona e registra em memória o ativo a ser utilizado como contexto atual e consultas subsequentes.
    
    @note emitir quando necessário alterar o ativo em foco no escopo da memória.
    @note pré-requisito para comandos como [getSecurity] ou [getQuote] ou [getFundamentals] ou [getFundamentalsSummary]
    @note[SymbolSelection] ao selecionar a partir de uma lista de opções apresentadas, utilizar SEMPRE o campo 'symbol' (ticker) da opção escolhida — nunca a descrição ou nome do ativo.

    @input symbol: str -> descreve o código/ticker ou nome do ativo a ser selecionado.
    
    @example [user] quero ver SampleCorp -> { "type": "selectSymbol", "symbol": "SampleCorp" }
    @example [user] vamos comprar ABCD11 -> { "type": "selectSymbol", "symbol": "ABCD11" }
    @example [user] preço do bitcoin -> [ { "type": "selectSymbol", "symbol": "bitcoin" }, { "type": "getQuote", "fields": [ "lastPrice" ] } ]
    @example [user] vamos operar ethereum -> { "type": "selectSymbol", "symbol": "ethereum" }, { "type": "setRequestSymbol" }

    @example[SymbolSelection] (HISTORICO) [user] Petrobras -> [agent] encontrei PETR3 e PETR4, qual deseja? -> (INPUT) [user] a preferencial -> { "type": "selectSymbol", "symbol": "PETR4" }

    */
    async selectSymbol({ type, symbol }) {

        if (!symbol) {
            return AgentRuntime.instruction(type, 'informe o código/ticker ou nome do ativo que deseja consultar ou negociar.')
        }

        symbol = symbol.toUpperCase()

        this.selectedSymbol = undefined
        this.selectedSecurityDescription = undefined

        let security = await this.marketDataService.getSecurity(symbol)
        if (!security) {
            const matches = await this.marketDataService.findSecurities(symbol)
            if (matches?.length > 1) {
                const options = matches.map((o) => {
                    return {
                        symbol: o.symbol,
                        description: o.description
                    }
                })

                this.outputCard = Object.assign({ type: 'symbol_selection' }, { search: symbol, options })

                return AgentRuntime.interrupt({ type, symbol, options },
                    `apresente opções encontradas e sugira refinamento`,
                    'SymbolSelection'
                )
            }
            security = matches?.[0]
        }

        if (security) {
            this.selectedSymbol = security.symbol
            this.selectedSecurityDescription = security.description

            const accountContext = this.getAccountContext()
            if (accountContext) {

                const request = accountContext.requests?.[accountContext.selectedRequestId]
                const updateRequest = !request?.isNew && request?.symbol && request?.symbol !== security.symbol

                if (updateRequest) {
                    accountContext.selectedRequestId = undefined

                    const requests = Object.values(accountContext.requests)
                        .filter(o => o.symbol == symbol)
                        .sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))

                    if (requests?.length) {
                        accountContext.selectedRequestId = requests[0].requestId
                        requests[0].selectedTime = nowTick()
                    }
                }

                const order = accountContext.orders?.[accountContext.selectedOrderId]
                const updateOrder = order?.symbol && order?.symbol !== security.symbol

                if (updateOrder) {
                    accountContext.selectedOrderId = undefined
                    this.selectedOrderId = undefined
                    accountContext.selectedOrders = undefined

                    const orders = Object.values(accountContext.orders)
                        .filter(o => o.symbol == symbol)
                        .sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))

                    if (orders?.length) {
                        accountContext.selectedOrderId = orders[0].orderId
                        this.selectedOrderId = accountContext.selectedOrderId
                        orders[0].selectedTime = nowTick()
                    }
                }
            }

            return AgentRuntime.instruction(type, `ativo ${security.symbol} selecionado.`)
        } else {
            return AgentRuntime.instruction(type, `ativo ${symbol} não encontrado.`)
        }
    }

    /* # COMMAND

    obtem informações cadastrais e especificações técnicas do ativo selecionado.

    @input  fields: arr[str] -> [ symbol, description, exchange, securityType, lot, minPriceIncrement ]

    @output symbol:            string -> código/ticker do ativo
    @output description:       string -> nome ou descrição completa do ativo
    @output exchange:          string -> bolsa ou mercado onde o ativo é negociado
    @output securityType:      string -> tipo/classe do ativo (ex: ação, fundo, bdr, etc)
    @output lot:               number -> tamanho do lote padrão de negociação
    @output minPriceIncrement: number -> variação mínima de preço permitida

    @example [user] que tipo de ativo é ABCD11? -> { "type": "getSecurity", "fields": [ "securityType", "description" ] }
    @example [user] qual o lote mínimo da SampleCorp? -> { "type": "getSecurity", "fields": [ "lot" ] }
    
    */
    async getSecurity({ type, fields }) {

        this.querySymbolCommand = { type, fields }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        const res = await this.marketDataService.getSecurity(this.selectedSymbol)
        if (!res) {
            return AgentRuntime.instruction(type, 'informe que dados do ativo não foram encontrados')
        }

        const allowedFields = ['symbol', 'description', 'exchange', 'securityType', 'lot', 'minPriceIncrement']

        if (!fields || fields.length === 0) {
            fields = allowedFields
        }

        const data = {}
        for (const field of fields.filter(f => allowedFields.includes(f))) {
            data[field] = res[field]
        }

        this.outputCard = { type: 'security', fields }

        return { type, symbol: this.selectedSymbol, data }
    }

    /* # COMMAND
    
    obtem dados de cotação em tempo real do ativo selecionado.

    @note emitir sempre que o usuário solicitar preço, variação ou dados de mercado de um ativo
    @note[out] somente se changePercent percent for 0.00% ou ZERO pode ser expressa na forma 'variação nula' ou 'sem variação'

    @output symbol:        string -> código/ticker do ativo
    @output lastPrice:     number -> último preço negociado
    @output changePercent: number -> variação percentual em relação ao fechamento anterior
    @output bidPrice:      number -> melhor oferta de compra (bid) - quanto estão pagando
    @output askPrice:      number -> melhor oferta de venda (ask) - quanto estão vendendo
    
    @example [user] qual o preço de ABCD11? -> { type: getQuote, fields: [ 'lastPrice' ] }
    @example [user] qual a variação da empresa X -> { type: getQuote, fields: [ 'changePercent' ] }
    */
    async getQuote({ type, fields }) {

        this.querySymbolCommand = { type, fields }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        const quote = await this.marketDataService.getQuote(this.selectedSymbol)
        if (!quote) {
            return AgentRuntime.instruction(type, 'informe que dado não encontrados')
        }

        if (!fields || fields.length == 0) {
            fields = ['symbol', 'lastPrice', 'changePercent', 'bidPrice', 'askPrice']
        }

        let data = {}
        for (let field of fields) {
            data[field] = quote[field]
        }

        this.outputCard = { type: 'quote', fields }

        return { type, symbol: this.selectedSymbol, data }
    }

    /* # COMMAND

    obtem a taxa de aluguel (custo de aluguel de um papel / Banco de Títulos) do ativo selecionado.

    @note emitir quando o usuário perguntar sobre taxa de aluguel, custo de alugar ou Banco de Títulos de um ativo
    @note[out] apresentar a taxa como percentual ao ano (% a.a.)

    @output symbol:        string -> código/ticker do ativo
    @output fee:           number -> taxa de aluguel anual em % (ex.: 8.08 = 8,08% a.a.)

    @example [user] qual a taxa de aluguel da PETR4? -> { type: getLendingRate }
    @example [user] quanto custa alugar VALE3? -> { type: getLendingRate }
    */
    async getLendingRate({ type }) {

        this.querySymbolCommand = { type }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        const res = await this.marketDataService.getLendingRate(this.selectedSymbol)
        if (!res || res.fee == null) {
            this.outputCard = { type: 'lending_unavailable', symbol: this.selectedSymbol }
            return { type, symbol: this.selectedSymbol }
        }

        const data = { fee: res.fee }

        this.outputCard = { type: 'lending', symbol: this.selectedSymbol, fee: res.fee }

        return { type, symbol: this.selectedSymbol, data }
    }

    /* # COMMAND [isAdminMode]

    representa a intenção de reproduzir a última consulta de conta para uma conta diferente

    @note emitir quando o usuário pedir para "ver a mesma coisa para outra conta" ou intenção similar de reaplicar a consulta anterior a outra conta.
    @note se a conta for citada no mesmo input ("e da conta 222?"), incluir em [accountId]; se não, o sistema questiona e aguarda resposta via [QueryAccountSelection].
    @note reaproveita a ÚLTIMA consulta de CONTA (saldo, posição, carteira, recomendação) — para ATIVO usar [querySymbol].
    @note[QueryAccountSelection] esta é uma RESPOSTA do usuário indicando QUAL conta deseja conferir — emitir SEMPRE [selectAccount] com a conta informada. NÃO re-emitir [queryAccount]. A consulta anterior é reaplicada automaticamente à nova conta.

    @input accountId: str (opcional) -> nova conta a consultar (número ou nome). Se omitido, o sistema solicita ao usuário via [QueryAccountSelection]

    @example (HIST saldo da conta 111111) [user] e da conta 222222? -> { "type": "queryAccount", "accountId": "222222" }
    @example (HIST posição em PETR4 da conta 111111) [user] mesma coisa para a 222222 -> { "type": "queryAccount", "accountId": "222222" }
    @example (HIST carteira da conta 111111) [user] confere outra conta -> { "type": "queryAccount" }
    @example[QueryAccountSelection] (HIST saldo da conta 111111) [user] vê outra conta -> [agent] qual conta? -> (INPUT) [user] 222222 -> { "type": "selectAccount", "accountId": "222222" }

    */
    async queryAccount({ type, accountId }) {

        if (!accountId) {
            return AgentRuntime.interrupt({ type, accountId },
                'questione para qual conta deseja reproduzir a última consulta',
                'QueryAccountSelection'
            )
        }

        const previousAccount = this.selectedAccount

        const res = await this.selectAccount({ type: 'selectAccount', accountId })

        // selectAccount pode interromper (AccountSelection / RequestCancelAccount) ou não resolver —
        // só reproduz a consulta quando a conta foi EFETIVAMENTE trocada; caso contrário devolve o
        // resultado nativo (interrupt/instruction) para o fluxo de selectAccount prosseguir
        if (!this.selectedAccount || this.selectedAccount === previousAccount) {
            return res
        }

        let result = res
        if (this.queryAccountCommand) {
            const cmd = this.queryAccountCommand
            const fn = this[cmd.type]
            if (fn) {
                result = await fn.call(this, cmd)
            }
        }

        return result
    }

    /* # COMMAND [isAdminMode]

    seleciona e registra em memória a conta/cliente a ser utilizada como contexto atual e consultas subsequentes.
    
    @note emitir quando necessário alterar a conta/cliente em foco no escopo da memória.
    @note pré-requisito para comandos como [getAccount]
    @note SEMPRE emitir com qualquer identificador disponível — mesmo parcial ou ambíguo. A resolução e busca são responsabilidade do serviço.
    @note nome pode ser somente Nome ou Sobrenome - preferencialmente utilize Nome Completo ( Nome + Sobrenome ) se possível.
    @note[AccountSelection] ao selecionar a partir de uma lista de opções JÁ apresentadas, utilizar SEMPRE o campo 'account' (número da conta) da opção escolhida — nunca o nome do cliente.
    @note[AccountSelection] se o usuário fornecer complemento de nome (ex: sobrenome), combinar com o termo de busca anterior para refinar — não tratar como nova busca independente.

    @input accountId: str -> descreve o identificador ou nome da cliente/conta a ser selecionado. PREFIRA NUMERO DA CONTA EXATA quando disponível
    @input showMoreOptions: bool (opcional) -> se true, solicita apresentação de mais opções de conta. Utilizar se usuário informar "mais opções" ou "nenhuma dessas", "proximo", ou simular...
    @input optionIndex: int (opcional) -> se informado, indica o índice ( ZERO-BASED ) da opção escolhida das apresentadas anteriormente. Primeira = 0, Segunda = 1, ... Penultima = -2, Ultima = -1, ...
    
    @example [user] qual conta do Jose Silva -> { "type": "selectAccount", "accountId": "Jose Silva" }
    @example [user] vamos operar na conta 123456 -> { "type": "selectAccount", "accountId": "123456" }
    @example [user] qual conta do Jose -> { "type": "selectAccount", "accountId": "Jose" }
    @example[AccountSelection] (HISTORICO) [user] conta do jose -> [agent] vários Joses encontrados, qual deseja? -> (INPUT) [user] silva -> { "type": "selectAccount", "accountId": "jose silva" }
    @example[AccountSelection] (HISTORICO) [user] conta do silva -> [agent] múltiplas contas encontradas - escolha uma? -> (INPUT) [user] jose silva -> { "type": "selectAccount", "accountId": "111111" }

    */
    async selectAccount({ type, accountId, showMoreOptions, optionIndex }) {

        if (accountId && accountId !== this.accountSelectionContext?.input) {
            showMoreOptions = undefined
            optionIndex = undefined
        }

        if (optionIndex !== undefined && this.accountSelectionContext?.options?.length) {
            if (optionIndex < 0) {
                optionIndex += this.accountSelectionContext.options.length
            }
            const selectedOption = this.accountSelectionContext.options[optionIndex]
            if (selectedOption) {
                accountId = selectedOption.account
            }
        }

        accountId = this.sanitizeAccountId(accountId)

        if (typeof accountId === 'string' && accountId.indexOf(' ') > -1) {
            let tokens = accountId.split(' ').map(o => o.trim())
            for (let tok of tokens) {
                if (!isNaN(tok) && tok.length <= 9) {
                    accountId = tok
                    break
                }
            }
            if (this.accountSelectionContext && accountId != this.accountSelectionContext.search) {
                delete this.accountSelectionContext
                showMoreOptions = false
            }
        }

        if (!accountId) {
            return AgentRuntime.instruction(type, 'informe o número da conta ou nome do cliente que deseja consultar ou negociar.')
        }

        accountId = accountId.toUpperCase()

        const currentContext = this.getAccountContext()
        const existingRequest = currentContext?.requests[currentContext?.selectedRequestId]
        const existingReal = !!existingRequest?.requestType

        if (existingReal) {
            const validation = this.validateRequestStatus()
            const isComplete = validation?.requestStatus?.isComplete

            if (!isComplete) {
                return AgentRuntime.interrupt(
                    { type, accountId },
                    'há uma boleta em preenchimento não finalizada. Ao trocar de conta, a boleta será descartada. Deseja continuar?',
                    'RequestCancelAccount'
                )
            }
        }

        this.selectedAccount = undefined

        let account = undefined
        if (accountId && !isNaN(accountId)) {
            account = await this.accountService.getAccount(accountId, { headers: this.headers })
        }

        if (!account) {

            let input = accountId?.toUpperCase()
            let search = input
            let offset = 0
            if (this.accountSelectionContext) {
                if (input && input != this.accountSelectionContext.input) {
                    search += ` ${this.accountSelectionContext.input}`
                } else {
                    if (!input) {
                        input = this.accountSelectionContext.input
                        search = this.accountSelectionContext.search
                    }
                    if (showMoreOptions) {
                        offset = this.accountSelectionContext.offset + DEFAULT_PAGE_SIZE
                    }
                }
            }

            const matches = await this.accountService.findAccounts(search, { offset, count: DEFAULT_PAGE_SIZE, headers: this.headers })
            if (matches?.length > 1) {
                const options = matches.map((o) => {
                    return {
                        account: o.account,
                        clientName: o.clientName,
                        institution: o.institution,
                        segment: o.segment
                    }
                })

                this.accountSelectionContext = {
                    input,
                    search,
                    offset,
                    options
                }

                this.outputCard = Object.assign({ type: 'account_selection' }, this.accountSelectionContext)

                return AgentRuntime.interrupt({ type, accountId, options },
                    `apresente opções encontradas e sugira refinamento`,
                    'AccountSelection'
                )
            }
            account = matches?.[0]
        }

        if (account) {
            this.selectedAccount = account.account
            this.updateTempRequest()

            this.accountSelectionContext = undefined

            return AgentRuntime.instruction(type, `conta ${account.account} selecionads.`)
        } else {
            return AgentRuntime.instruction(type, `conta ${accountId} não encontrada.`)
        }
    }

    /* # COMMAND [isAdminMode]
    
    obtem informações de contas de clientes
    
    @note conta deve estar previamente selecionada na memória, ou deve ser emitido um comando selectAccount antes de getAccount

    @input fields: arr[str] -> [ account, clientName, document, institution, segment, suitability, assignedDocuments, isProfessional, isQualified, address ]
    
    @output account:           string   -> identificador / código / número da conta
    @output clientName:        string   -> nome completo do cliente (Nome + Sobrenome)
    @output document:          string   -> documento CPF ou CNPJ
    @output institution:       string   -> instituição responsável I.R. onde a conta está registrada
    @output segment:           string   -> sigla identificadora do segmento de negócio
    @output suitability:       string   -> nível de perfil de risco / conformidade suitability
    @output assignedDocuments: string[] -> lista de documentos de conformidade assinados
    @output isProfessional:    bool     -> indica se o investidor é profissional
    @output isQualified:       bool     -> indica se o investidor é qualificado
    @output address:           string   -> localidade do cliente (país; estado; cidade)
    
    @example [user] qual é a conta do Jose Silva? -> { type: getAccount, fields: [ 'account' ] }
    @example [user] como é nome do cliente 123456? -> { type: getAccount, fields: [ 'clientName' ] }
    @example [user] quero ver I.R. e segmento do cliente Jose Silva -> { type: getAccount, fields: [ 'institution', 'segment' ] }
    @example [user] qual é suitability do Silva -> { type: getAccount, fields: [ 'suitability' ] }

    */
    async getAccount({ type, fields }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'informe que dado não encontrados')
        }

        if (!fields || fields.length == 0) {
            fields = ['account', 'clientName', 'document', 'institution', 'segment', 'suitability', 'assignedDocuments', 'isProfessional', 'isQualified', 'address']
        }

        let data = {}
        for (let field of fields) {
            data[field] = account[field]
        }

        return { type, account: this.selectedAccount, data }
    }

    /* # COMMAND [isAdminMode]

    obtem os alertas de preço cadastrados na conta selecionada.

    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note cada alerta traz o ativo e as condições de disparo já em texto legível
    @note[out] apresente as condições exatamente como recebidas (já estão em texto legível)

    @output alerts: obj[] -> lista de alertas da conta
    @output symbol: string -> ativo do alerta
    @output account: string -> conta do alerta
    @output conditions: arr[str] -> condições de disparo em texto legível (ex.: "Preço atual acima de 170,75")

    @example [isAdminMode][user] quais alertas a conta 2909633 tem -> [ { "type": "selectAccount", "accountId": "2909633" }, { "type": "getAlertList" } ]
    @example [isAdminMode][user] mostra os alertas de preço da conta -> { "type": "getAlertList" }

    */
    async getAlertList({ type }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const alerts = await this.alertService.getAlerts(this.selectedAccount, { headers: this.headers })
        if (!alerts) {
            return AgentRuntime.instruction(type, 'informe erro ao consultar alertas')
        }
        if (!alerts.length) {
            return AgentRuntime.instruction(type, 'informe que não há alertas cadastrados para a conta')
        }

        return { type, account: this.selectedAccount, alerts }
    }

    /* # COMMAND
     
    valida o estado atual da ordem/boleta em preenchimento, verificando se todos os campos obrigatórios foram preenchidos
     
    @note consulta o status do preenchimento de uma boleta para verificar se está pronta para envio
    @note se houver pendências, retorna o primeiro campo pendente para ser solicitado ao usuário — uma pendência por interação
    @note campos obrigatórios: requestType, account, symbol, side, quantity ou volume, priceType ou priceLimit, expireType ou expireTime
     
    @note[out] o campo 'instruction' já representa a única pendência a ser solicitada ao usuário neste turno — NÃO verbalizar 'pendingFields' diretamente
    @note[out] se [INPUT_RAW_DATA] apresentar mais de um resultado para o comando 'validateRequestStatus' - CONSIDERAR SOMENTE O ULTIMO 
     
    @output isComplete:     bool     -> indica se a boleta está completa e pronta para envio
    @output pendingFields:  string[] -> lista de campos ainda não preenchidos: [ requestType, account, symbol, side, quantity_or_volume, priceType_or_priceLimit, expireType_or_expireTime ]
     
    @example [user] a boleta está completa? -> { "type": "validateRequestStatus" }
    @example [user] pode enviar a ordem? -> { "type": "validateRequestStatus" }
    @example [user] o que falta preencher? -> { "type": "validateRequestStatus" }
     
    */
    validateRequestStatus({ type, request } = {}) {

        if (!type) {
            type = 'validateRequestStatus'
        }

        if (!request) {
            request = this.getSelectedRequest()
        }
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        let message = undefined

        const requestStatus = {
            isComplete: false,
            pendingFields: []
        }

        if (!request.requestType) {
            if (!message) {
                message = 'questione qual tipo de requisição - (Nova Ordem, Modificação ou Cancelamento)'
            }
            requestStatus.pendingFields.push('requestType')
        }

        if (!request.account) {
            if (!message) {
                message = 'questione qual conta deve ser utilizada para a boleta'
            }
            requestStatus.pendingFields.push('account')
        }

        if (!request.symbol) {
            if (!message) {
                message = 'questione qual ativo deve ser utilizado para a boleta'
            }
            requestStatus.pendingFields.push('symbol')
        }

        if (!request.side) {
            if (!message) {
                message = 'questione qual lado/direção da boleta - (Compra ou Venda)'
            }
            requestStatus.pendingFields.push('side')
        }

        if (!request.quantity && !request.volume) {
            if (!message) {
                message = 'questione qual quantidade de cotas ou volume financeiro deve ser utilizado ne boleta'
            }
            requestStatus.pendingFields.push('quantity_or_volume')
        }

        if (request.priceType != 'M' && !request.priceLimit) {
            if (!message) {
                if (request.priceType == 'L') {
                    message = 'questione qual valor desejado para o preço limite'
                } else {
                    message = 'questione qual preço deve ser utilizado ne boleta (Limitado ou Mercado)'
                }
            }
            requestStatus.pendingFields.push('priceType_or_priceLimit')
        }

        if (!request.expireType && !request.expireTime) {
            if (!message) {
                message = 'questione qual expiração deve ser utilizada ne boleta (Dia, Até Cancelar, Data Específica, Imediata, etc)'
            }
            requestStatus.pendingFields.push('expireType_or_expireTime')
        }

        if (requestStatus.pendingFields.length == 0) {
            requestStatus.isComplete = true
            message = 'nenhuma pendencia na boleta'
        }

        return AgentRuntime.instruction({ type, requestStatus }, message)
    }

    /* #COMMAND

    obtem dados e informações de contexto da ordem/boleta em preenchimento atualmente selecionada.

    @input fields: arr[str] -> [ requestId, requestType, orderId, account, symbol, side, quantity, quantityMin, quantityDisplay, priceType, priceLimit, expireType, expireTime ]
    
    @output requestId: string -> identificador único da requisição de ordem/boleta em preenchimento
    @output requestType: string -> tipo da requisição, ex: [C]criação, [M]modificação, [X]cancelamento
    @output orderId: string -> identificador da ordem existente, caso seja modificação ou cancelamento
    @output account: string -> conta selecionada para a ordem/boleta
    @output symbol: string -> ativo selecionado para a ordem/boleta
    @output side: string -> direção da ordem, ex: [B]compra ou [S]venda
    @output volume: number -> volume financeiro expresso em montante monetário
    @output quantity: number -> quantidade expressa em número de cotas
    @output quantityMin: number -> quantidade mínima para execução da ordem, em número de cotas. Caso seja ordem Executa ou Cancela ('expireType' = 'IOC')
    @output quantityDisplay: number -> quantidade a ser exibida para o mercado, em número de cotas. Caso seja ordem Iceberg
    @output priceType: string -> tipo de preço, ex: [L]imitado ou [M]ercado
    @output priceLimit: number -> preço limite para execução da ordem, em caso de ordem limitada
    @output expireType: string -> tipo de validade da ordem: [DAY] válida pelo dia, [GTC] válida até cancelar, [GTD] válida até data específica, [IOC] imediata executa ou cancela o saldo, [FOK] imediata tudo ou nada, [MOC] leilão de fechamento, [MOA] leilão de abertura
    @output expireTime: datetime -> data e hora de expiração da ordem, caso seja ordem com validade específica
    
    */
    async getRequest({ type, fields }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const request = this.getSelectedRequest(false)
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        if (!fields || fields.length == 0) {
            fields = ['requestId', 'requestType', 'orderId', 'account', 'symbol', 'side', 'volume', 'quantity', 'quantityMin', 'quantityDisplay', 'priceType', 'priceLimit', 'expireType', 'expireTime']
        }

        let data = {}
        for (let field of fields) {
            data[field] = request[field]
        }

        this.outputCard = { type: 'requests', requests: request ? [request] : undefined }

        return { type, account: this.selectedAccount, data }
    }

    /* # COMMAND

    cancela e descarta uma ou mais boletas em preenchimento.

    @note Se plural, considere todas as boletas [cancelAll: true]. Caso singular, considera boleta atualmente selecionada
    @note para cancelar uma ordem já existente, utilizar comando [selectOrder] seguido por [setRequestType(X)] — este comando NÃO cancela ordens, apenas descarta a boleta local
    @note "cancela a operação", "cancela a edição", "cancela a requisição", "cancela a boleta" → SEMPRE descartam a boleta em preenchimento (este comando)
    @note NÃO confundir com "cancela A ORDEM": se a boleta possui [orderId] (edição de ordem vigente), cancelar A ORDEM é [setRequestType(X)] — NÃO este comando
    @note remove permanentemente a requisição em preenchimento — a ação não pode ser desfeita
    @note após o cancelamento, nenhuma boleta estará em foco — um novo [setRequestType] será necessário para iniciar uma nova requisição
    @note se [cancelAll] for true, descarta as boletas da ÚLTIMA lista apresentada ([getRequestList]/[getRequestListSummary] — pode abranger VÁRIAS contas); se não houver lista apresentada, descarta TODAS as boletas em preenchimento
    @note quando um ativo for mencionado no contexto de cancelamento de boleta, emitir SEMPRE [selectSymbol] antes deste comando se o ativo for diferente do selectedSymbol atual — o cancelamento afetará a boleta do ativo selecionado

    @input cancelAll: bool -> se true, descarta em lote as boletas da última lista apresentada (ou TODAS, se não houver lista) — não apenas a selecionada

    @example [user] cancela a operação -> { "type": "cancelRequest" }
    @example [user] cancela a edição -> { "type": "cancelRequest" }
    @example [user] cancela a requisição -> { "type": "cancelRequest" }
    @example [user] cancela todas as boletas -> { "type": "cancelRequest", "cancelAll": true }
    @example [user] limpa tudo -> { "type": "cancelRequest", "cancelAll": true }
    @example [user] descarta boleta de PETR4 -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "cancelRequest" } ]

    */
    async cancelRequest({ type, cancelAll }) {

        this.outputCard = { type: 'requests' }

        if (cancelAll) {

            // escopo: última lista apresentada (pode abranger várias contas);
            // se vazia/inexistente, TODAS as boletas em preenchimento
            const targets = (this.selectedRequests?.length ? this.selectedRequests : this.getAllRequests()) ?? []

            if (!targets.length) {
                return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
            }

            const targetIds = new Set(targets.map(r => r.requestId))

            // remove as boletas alvo de TODOS os contextos (lista pode abranger várias contas + 'temp')
            for (const context of Object.values(this.accountContexts)) {
                for (const requestId of Object.keys(context.requests)) {
                    if (targetIds.has(requestId)) {
                        delete context.requests[requestId]
                        if (context.selectedRequestId === requestId) {
                            context.selectedRequestId = undefined
                        }
                    }
                }
            }

            // descarta o contexto temporário se ficou vazio
            const tempContext = this.accountContexts['temp']
            if (tempContext && !Object.keys(tempContext.requests).length) {
                delete this.accountContexts['temp']
            }

            // limpa a lista global apresentada
            this.selectedRequests = undefined

            return AgentRuntime.instruction(type, 'informe que todas as boletas foram descartadas e pergunte como deseja prosseguir')
        }

        const accountContext = this.getAccountContext()

        if (accountContext?.selectedRequestId) {
            delete accountContext.requests[accountContext.selectedRequestId]

            const remaining = Object.values(accountContext.requests)
                .sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))
            const next = remaining.find(r => r.symbol === this.selectedSymbol) ?? remaining[0]
            if (next) {
                await this.selectRequest({ type: 'selectRequest', requestId: next.requestId })
            } else {
                accountContext.selectedRequestId = undefined
            }
        } else {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        this.outputCard = { type: 'requests' }

        return AgentRuntime.instruction(type, 'informe que a boleta foi descartada e pergunte como deseja prosseguir')
    }

    /* # COMMAND

    seleciona uma ordem/boleta em preenchimento como contexto ativo para edição subsequente

    @note ao selecionar a boleta, o ativo em memória é sincronizado automaticamente com o ativo da boleta selecionada
    @note a seleção por índice opera sobre a última lista apresentada por [getRequestList]/[getRequestListSummary], que pode conter boletas de múltiplas contas — a conta da boleta escolhida passa a ser a conta selecionada
    @note se [requestId] não for informado, a boleta é localizada por [requestIndex] ou pelo [selectedSymbol] atualmente em memória

    @input requestId: str (opcional) -> identificador da boleta. Se omitido, usa [requestIndex] ou o [selectedSymbol] atual
    @input requestIndex: int (opcional) -> índice ( ZERO-BASED ) da boleta na última lista apresentada. Primeira = 0, Última = -1, Penúltima = -2

    @example [user] editar boleta abc123 -> { "type": "selectRequest", "requestId": "abc123" }
    @example [user] editar minha boleta de PETR4 -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "selectRequest" } ]
    @example [user] quero continuar preenchendo a boleta de VALE3 -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "selectRequest" } ]
    @example [user] editar primeira boleta -> { "type": "selectRequest", "requestIndex": 0 }
    @example [user] editar última boleta -> { "type": "selectRequest", "requestIndex": -1 }

    */
    async selectRequest({ type, requestId, requestIndex }) {

        let request = undefined

        // 1) resolução por índice sobre a última lista GLOBAL apresentada
        //    (fallback: todas as boletas em memória, já ordenadas por selectedTime desc)
        if (!requestId && requestIndex !== undefined) {
            const requests = this.selectedRequests ?? this.getAllRequests()
            if (requests?.length) {
                if (requestIndex < 0) {
                    requestIndex = requests.length + requestIndex
                }
                request = requests[requestIndex]
            }
        }

        // 2) resolução por requestId — procura em todas as contas
        if (!request && requestId) {
            request = this.getAllRequests().find(r => r.requestId === requestId)
        }

        // 3) resolução pelo ativo selecionado — procura em todas as contas
        if (!request && !requestId && this.selectedSymbol) {
            request = this.getAllRequests()
                .filter(r => r.symbol === this.selectedSymbol)
                .sort((a, b) => (b.selectedTime || 0) - (a.selectedTime || 0))[0]
        }

        if (!request) {
            return AgentRuntime.instruction(type, `boleta ${requestId ?? ''} não encontrada`)
        }

        // a boleta pode pertencer a outra conta — sincroniza a conta selecionada
        if (request.account && request.account !== this.selectedAccount) {
            this.selectedAccount = request.account
        }

        const accountContext = this.getAccountContext(true)
        accountContext.selectedRequestId = request.requestId
        request.selectedTime = nowTick()

        // sincroniza selectedSymbol sem chamar selectSymbol() para evitar loop
        if (request.symbol && request.symbol !== this.selectedSymbol) {
            this.selectedSymbol = request.symbol
            this.selectedSecurityDescription = undefined

            const security = await this.marketDataService.getSecurity(request.symbol)
            if (security) {
                this.selectedSecurityDescription = security.description
            }
        }

        // sincroniza selectedOrder sem chamar setRequestOrderId() para evitar loop
        if (request.orderId && request.orderId !== this.selectedOrderId) {
            const order = accountContext.orders?.find(o => o.orderId === request.orderId)
            if (order) {
                this.selectedOrderId = order.orderId
                order.selectedTime = nowTick()
            }
        } else {
            this.selectedOrderId = undefined
        }

        this.outputCard = { type: 'requests', requests: request ? [request] : undefined }

        return AgentRuntime.instruction(type, `boleta ${request.requestId} selecionada — ativo: ${request.symbol ?? 'não definido'}`)
    }

    /* # COMMAND

    determina o tipo de requisição de Ordem/Boleta para objeto request selecionado em foco

    @note quando houver intenção em negociar sem a identificação de uma ordem existente, interpretar como [C]criação de nova ordem
    @note quando houver intenção em modificar, editar ou alterar uma ordem existente, interpretar como [M]modificação
    @note [M]modificação e [X]cancelamento REQUER ordem vigente selecionada ([selectedOrderId] em memória). Ao emitir [setRequestType(M)], os atributos da ordem são copiados para a boleta — emitir em seguida APENAS os parâmetros a alterar, nunca re-emitir os que permanecem iguais.
    @note quando houver intenção em cancelar uma ordem existente, interpretar como [X]cancelamento
    @note se a boleta em preenchimento JÁ possui [orderId] (edição de ordem vigente) e o usuário pedir para CANCELAR A ORDEM, emitir [setRequestType(X)] — reaproveita o [orderId] da boleta, convertendo a edição em cancelamento. NÃO emitir [cancelRequest] (que descartaria a boleta sem cancelar a ordem).
    @note não confunda intenção de Venda com Ação de Cancelamento. Para Vender, é necessário criar uma ordem (de venda no caso)
    @note não confunda RequestId com OrderId. Modificação ou Cancelamento sempre opera sobre ordem já selecionada anteriormente. Não deve informar orderId como requestId
    @note REAPROVEITAMENTO POR ATIVO — sem [newRequest], reaproveita a última boleta [C]/[M] do [selectedSymbol] (ignora [X]); se não houver, inicia uma nova para o ativo. Emitir [selectSymbol] antes de [setRequestType] quando um ativo é nomeado.
    @note [newRequest:true] SOMENTE com pedido explícito de boleta adicional. Criar N ordens no mesmo turno é pedido explícito: da 2ª em diante, [setRequestType(C, newRequest:true)].

    @input newRequest:  bool -> emitir SOMENTE com intenção EXPLÍCITA de boleta ADICIONAL ("outra", "mais uma", "também", "separado", "nova boleta"). Sem [newRequest], o sistema reaproveita a última boleta [C]/[M] do ativo selecionado (nunca [X]); para ativo diferente, emitir [selectSymbol] antes.
    @input newRequest:  bool -> indica intenção explícita de criação de nova requisição, preservando estado de requisição anteriormente selecionada

    @example [user] compra PETR4 e venda VALE3   -> grupo1: [setRequestType(C)] → [selectSymbol(PETR4)] → ... / grupo2: [setRequestType(C, newRequest:true)] → [selectSymbol(VALE3)] → ...
    @example [user] zera PETR4 e VALE3           -> grupo1: [setRequestType(C)] → [selectSymbol(PETR4)] → [setRequestQuantityFromPosition(close)] / grupo2: [setRequestType(C, newRequest:true)] → [selectSymbol(VALE3)] → [setRequestQuantityFromPosition(close)]
    @example [user] compra mais uma boleta de X  -> { "type": "setRequestType", "requestType": "C", "newRequest": true }
    @example [user] (ordem 123 já selecionada) altera o preço para 25,40   -> [ { "type": "setRequestType", "requestType": "M" }, { "type": "setRequestPriceLimit", "priceLimit": 25.40 } ]
    @example [user] muda a quantidade da ordem 789 para 200               -> [ { "type": "selectOrder", "orderId": "789" }, { "type": "setRequestType", "requestType": "M" }, { "type": "setRequestQuantity", "quantity": 200 } ]
    @example [user] modifica a ordem 456: validade até cancelar           -> [ { "type": "selectOrder", "orderId": "456" }, { "type": "setRequestType", "requestType": "M" }, { "type": "setRequestExpireType", "expireType": "GTC" } ]
    @example [user] (editando ordem 123 na boleta) cancela a ordem         -> { "type": "setRequestType", "requestType": "X" }
    @example [user] cancela a ordem 789                                    -> [ { "type": "selectOrder", "orderId": "789" }, { "type": "setRequestType", "requestType": "X" } ]
    @example [user] (boleta compra PETR4 em edição) também compra VALE3 -> [ { "type": "setRequestType", "requestType": "C", "newRequest": true }, { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "setRequestSymbol" }, { "type": "setRequestSide", "side": "B" } ]
    @example [user] (boleta compra PETR4 em edição) compra VALE3 -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "setRequestType", "requestType": "C" }, { "type": "setRequestSymbol" }, { "type": "setRequestSide", "side": "B" } ]
    @example [user] (boleta compra PETR4 em edição) vende PETR4            -> [ { "type": "setRequestType", "requestType": "C", "newRequest": true }, { "type": "setRequestSide", "side": "S" } ]
    @example [user] (boleta compra PETR4 em edição) na verdade é venda     -> { "type": "setRequestSide", "side": "S" }
    @example [user] (boleta compra PETR4 em edição) muda o ativo para VALE3 -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "setRequestSymbol" } ]

    */
    async setRequestType({ type, requestType, newRequest }) {

        if (!requestType) {
            requestType = 'C'
        }

        let request

        if (newRequest) {
            // criação explícita de NOVA boleta — só quando o usuário indica ("outra", "mais uma", "também", "separado", "nova boleta")
            request = this.getSelectedRequest('new')
        } else if (requestType === 'C' || requestType === 'M') {
            // default: reaproveita a última boleta do MESMO ativo (tipo C ou M; ignora X)
            request = this.resolveReusableRequest(this.selectedSymbol, requestType)
        } else {
            // [X] e demais: comportamento atual (cancelamento a partir da ordem selecionada)
            request = this.getSelectedRequest(true)
        }

        if (!request) {
            return AgentRuntime.instruction(type,
                newRequest
                    ? 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida'
                    : 'nenhuma boleta em preenchimento no momento'
            )
        }

        request.requestType = requestType

        if (requestType === 'C') {
            request.orderId = undefined
        }

        // para cancelamento ou modificação, popula automaticamente a partir da ordem selecionada em memória
        if ((requestType === 'X' || requestType === 'M') && this.selectedOrderId && !request.orderId) {

            const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
            if (account) {
                const order = await this.orderService.getOpenOrder(account.account, this.selectedOrderId)
                if (order) {

                    if (!(order.pendingQuantity > 0)) {
                        request.requestType = 'C'   // desfaz a conversão M/X para não deixar boleta órfã
                        request.orderId = undefined
                        return AgentRuntime.instruction(type,
                            `ordem ${order.orderId} finalizada não pode ser ${requestType === 'X' ? 'cancelada' : 'modificada'}`)
                    }

                    let priceType = order.priceType
                    let priceLimit = order.priceLimit
                    let priceTrigger = undefined
                    if (order.priceTriggerStop) {
                        priceTrigger = order.priceTriggerStop
                        priceLimit = order.priceLimitStop
                    }
                    if (!priceLimit) {
                        priceType = 'M'
                    }

                    request.orderId = order.orderId
                    request.symbol = order.symbol
                    request.side = order.side
                    request.quantity = order.quantity
                    request.quantityMin = order.quantityMin
                    request.quantityDisplay = order.quantityDisplay
                    request.priceType = priceType
                    request.priceLimit = priceLimit
                    request.priceTrigger = priceTrigger
                    request.expireType = order.expireType
                    request.expireTime = order.expireTime

                    this.selectedSymbol = order.symbol
                }
            }
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, requestType, status: 'ok' }
    }

    /* # COMMAND

    define o identificador da ordem vigente a ser modificada ou cancelada na ordem/boleta em preenchimento

    @note utilizado exclusivamente em requisições do tipo [M]modificação ou [X]cancelamento
    @note ao localizar a ordem, seus atributos são copiados para a boleta como valores iniciais de referência
    @note se a ordem não for encontrada nas vigentes, a boleta não será atualizada

    @input orderId: str -> identificador da ordem vigente a ser modificada ou cancelada

    @example [user] modificar ordem 123456 -> { "type": "setRequestOrderId", "orderId": "123456" }
    @example [user] cancela a ordem ZSMiwVBS5B -> { "type": "setRequestOrderId", "orderId": "ZSMiwVBS5B" }

    */
    async setRequestOrderId({ type, orderId }) {

        const request = this.getSelectedRequest()
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        if (!orderId) {
            return AgentRuntime.instruction(type, 'informe o identificador da ordem a ser modificada ou cancelada')
        }

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const order = await this.orderService.getOpenOrder(account.account, orderId)
        if (!order) {
            return AgentRuntime.instruction(type, `ordem ${orderId} não encontrada nas ordens vigentes`)
        }

        if (!(order.pendingQuantity > 0)) {
            return AgentRuntime.instruction(type,
                `ordem ${orderId} já finalizada (sem saldo pendente) — não pode ser modificada ou cancelada`)
        }

        // copia atributos da ordem para a boleta como valores iniciais de referência
        request.orderId = order.orderId
        request.symbol = order.symbol
        request.side = order.side
        request.quantity = order.quantity
        request.quantityMin = order.quantityMin
        request.quantityDisplay = order.quantityDisplay
        request.priceType = order.priceType
        request.priceLimit = order.priceLimit
        request.expireType = order.expireType
        request.expireTime = order.expireTime

        // sincroniza símbolo selecionado em memória
        this.selectedSymbol = order.symbol

        request.isNew = false
        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, orderId, status: 'ok' }
    }

    /* # COMMAND

    determina o Ativo a ser negociado para objeto Ordem/Boleta 'request' selecionado em foco

    @note este comando NÃO possui parâmetros — o ativo é obtido diretamente da memória (selectedSymbol)
    @note SEMPRE emitir [selectSymbol] antes deste comando — sem seleção prévia, o comando falha
    @note sequência obrigatória: [selectSymbol] → [setRequestSymbol]

    @example [user] quero comprar PETR4 -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "setRequestSymbol" } ]
    @example [user] boleta para VALE3   -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "setRequestSymbol" } ]

    */
    async setRequestSymbol({ type }) {

        const request = this.getSelectedRequest()
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        request.symbol = this.selectedSymbol

        request.isNew = false
        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, symbol: request.symbol, status: 'ok' }
    }

    /* # COMMAND

    determina o tipo de operação Compra ou Venda para objeto Ordem/Boleta 'request' selecionado em foco

    @note ações como Investir / Aportar / Adquitir / Aplicar -> devem ser interpretadas como intenção de Compra
    @note ações como Desinvestir / Sacar / Resgatar -> devem ser interpretadas como intenção de Venda

    @input side: str -> direção, deve ser mapeado para: [B]<-compra OU [S]<-venda

    */
    async setRequestSide({ type, side }) {

        const request = this.getSelectedRequest()
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        request.side = side

        request.isNew = false
        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, side, status: 'ok' }
    }

    /* # COMMAND

    determina a quantidade de cotas para objeto Ordem/Boleta 'request' selecionado em foco

    @note quantidade expressa em número de cotas a serem negociadas. Para volume financeiro, deve ser utilizado comando 'setRequestVolume'
    @note ao utilizar quantidade relativa por 'offset', o valor é calculado em relação à quantidade atual da boleta (reference = Request)
    @note importante expressar o sinal no offset: positivo para incremento, negativo para decremento
    @note se [batchMode] for true, a quantidade é aplicada a TODAS as boletas — em modo RELATIVO ([offset]), cada boleta calcula sobre a SUA própria quantidade atual
    
    @input quantity:    number -> quantidade absoluta em número de cotas, OU (null) se relativo ao valor atual
    @input offsetType:  str    -> tipo de deslocamento em relação à quantidade atual: [U] unidades/cotas OU [P] percentual OU (null) se Quantidade Absoluta
    @input offset:      number -> (sinal +/-) valor de deslocamento em relação à quantidade atual, expresso em [offsetType] unidades ou percentual
    @input batchMode: bool -> se true, aplica a quantidade a TODAS as boletas em preenchimento, não apenas à selecionada

    @example [user] 100 cotas -> { "type": "setRequestQuantity", "quantity": 100 }
    @example [user] compra 10 mil -> { "type": "setRequestQuantity", "quantity": 10000 }
    @example [user] compra 2 mil de PETR4 -> { "type": "setRequestQuantity", "quantity": 2000 }
    @example [user] aumenta 10 cotas -> { "type": "setRequestQuantity", "quantity": null, "offsetType": "U", "offset": +10 }
    @example [user] reduz 20% -> { "type": "setRequestQuantity", "quantity": null, "offsetType": "P", "offset": -20 }
    @example [user] dobra a quantidade -> { "type": "setRequestQuantity", "quantity": null, "offsetType": "P", "offset": +100 }
    @example [user] 100 cotas para todas -> { "type": "setRequestQuantity", "quantity": 100, "batchMode": true }
    @example [user] aumenta 10% em todas -> { "type": "setRequestQuantity", "quantity": null, "offsetType": "P", "offset": 10, "batchMode": true }

    */
    async setRequestQuantity({ type, quantity, offsetType, offset, batchMode = false }) {

        const selected = this.getSelectedRequest()
        if (!selected) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        const targets = batchMode ? this.getEditingRequests() : [selected]

        const isShort = !offsetType && quantity < 0
        if (isShort) {
            quantity *= -1
        }

        let applied = 0
        for (const request of targets) {

            if (this.applyQuantity(request, quantity, offsetType, offset)) {
                applied++
            }

            if (isShort) {
                request.side = 'S'
            } else if (!request.side) {
                request.side = 'B'
            }
        }

        if (!applied) {
            return AgentRuntime.instruction(type, 'quantidade inválida — informe um valor maior que zero ou verifique o ajuste relativo')
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, quantity: selected.quantity, batchMode, count: applied, status: 'ok' }
    }

    /* # COMMAND

    determina o volume financeiro para objeto Ordem/Boleta 'request' selecionado em foco

    @note volume financeiro expresso em montante monetário. Para quantidade por cota, deve ser utilizado comando 'setRequestQuantity'
    @note REQUER indicador monetário/financeiro explícito (a palavra "volume", R$, reais, em dinheiro, financeiro, de volume). Valor numérico SEM esse indicador ("10 mil", "compra 500") NÃO é volume — interpretar como cotas via [setRequestQuantity].
    @note o FORMATO do número NÃO decide o comando: "volume 500" (inteiro) e "volume 500,00" (decimal) são AMBOS volume. Nunca use presença de casas decimais/centavos como sinal — decida apenas pela palavra "volume"/indicador monetário.
    @note ao utilizar volume relativo por 'offset', o valor é calculado em relação ao volume atual da boleta (reference = Request)
    @note importante expressar o sinal no offset: positivo para incremento, negativo para decremento
    @note se [batchMode] for true, a quantidade é aplicada a TODAS as boletas — em modo RELATIVO ([offset]), cada boleta calcula sobre a SUA própria quantidade atual
    
    @input volume:      number -> volume financeiro absoluto em montante monetário, OU (null) se relativo ao valor atual
    @input offsetType:  str    -> tipo de deslocamento em relação ao volume atual: [U] valor monetário OU [P] percentual OU (null) se Volume Absoluto
    @input offset:      number -> (sinal +/-) valor de deslocamento em relação ao volume atual, expresso em [offsetType] monetário ou percentual
    @input batchMode: bool -> se true, aplica o volume a TODAS as boletas em preenchimento, não apenas à selecionada

    @example [user] R$ 10.000 -> { "type": "setRequestVolume", "volume": 10000 }
    @example [user] 10 mil reais -> { "type": "setRequestVolume", "volume": 10000 }
    @example [user] 10 mil de volume financeiro -> { "type": "setRequestVolume", "volume": 10000 }
    @example [user] compra 10 mil -> NÃO emitir setRequestVolume — sem unidade monetária é COTAS: { "type": "setRequestQuantity", "quantity": 10000 }
    @example [user] aumenta R$ 5.000 no volume -> { "type": "setRequestVolume", "volume": null, "offsetType": "U", "offset": +5000 }
    @example [user] reduz 20% do volume -> { "type": "setRequestVolume", "volume": null, "offsetType": "P", "offset": -20 }
    @example [user] dobra o volume -> { "type": "setRequestVolume", "volume": null, "offsetType": "P", "offset": +100 }
    @example [user] R$ 10.000 em todas -> { "type": "setRequestVolume", "volume": 10000, "batchMode": true }
    @example [user] volume 500 -> { "type": "setRequestVolume", "volume": 500 }
    @example [user] volume de 500,00 -> { "type": "setRequestVolume", "volume": 500 }
    @example [user] volume financeiro de 1500 -> { "type": "setRequestVolume", "volume": 1500 }
    */
    async setRequestVolume({ type, volume, offsetType, offset, batchMode = false }) {

        const selected = this.getSelectedRequest()
        if (!selected) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        const targets = batchMode ? this.getEditingRequests() : [selected]

        const isShort = !offsetType && volume < 0
        if (isShort) {
            volume *= -1
        }

        let applied = 0
        for (const request of targets) {

            if (this.applyVolume(request, volume, offsetType, offset)) {
                applied++
            }

            if (isShort) {
                request.side = 'S'
            } else if (!request.side) {
                request.side = 'B'
            }
        }

        if (!applied) {
            return AgentRuntime.instruction(type, 'volume inválido — informe um valor maior que zero ou verifique o ajuste relativo')
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, volume: selected.volume, batchMode, count: applied, status: 'ok' }
    }

    /* # COMMAND

    determina a quantidade mínima de execução para objeto Ordem/Boleta 'request' selecionado em foco

    @note utilizado exclusivamente em ordens do tipo Executa ou Cancela (IOC), onde a ordem só executa se atingir a quantidade mínima definida
    @note deve ser menor ou igual à quantidade total definida em [setRequestQuantity]

    @input quantityMin: number -> quantidade mínima para execução, expressa em número de cotas

    */
    async setRequestQuantityMin({ type, quantityMin }) {

        const request = this.getSelectedRequest()
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        if (request.expireType && request.expireType !== 'IOC') {
            return AgentRuntime.instruction(type, 'quantidade mínima é aplicável somente em ordens do tipo IOC (Executa ou Cancela)')
        }

        request.quantityMin = quantityMin
        request.expireType = 'IOC'   // garante consistência caso expireType ainda não esteja definido

        request.isNew = false
        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, quantityMin, status: 'ok' }
    }

    /* # COMMAND

    determina a quantidade visível ao mercado para objeto Ordem/Boleta 'request' selecionado em foco

    @note utilizado exclusivamente em ordens do tipo Iceberg, onde apenas parte da quantidade total é exibida ao mercado
    @note deve ser menor que a quantidade total definida em [setRequestQuantity]

    @input quantityDisplay: number -> quantidade a ser exibida ao mercado, expressa em número de cotas

    */
    async setRequestQuantityDisplay({ type, quantityDisplay }) {

        const request = this.getSelectedRequest()
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        request.quantityDisplay = quantityDisplay

        request.isNew = false
        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, quantityDisplay, status: 'ok' }
    }

    /* # COMMAND

    determina o tipo de preço para objeto Ordem/Boleta 'request' selecionado em foco

    @note ordens do tipo Mercado são executadas ao melhor preço disponível, sem restrição de preço
    @note se definido como [L] Limit, o preço limite da ordem deve ser definida no comando [setRequestPriceLimit]. Por padrão, assume-se o preço de mercado no momento da especificação.
    @note se [batchMode] for true, o tipo de preço é aplicado a TODAS as boletas — ao mudar para [L], cada boleta busca a cotação do SEU próprio ativo
    
    @input priceType: str -> tipo de preço, deve ser mapeado para: [L]<-limitado OU [M]<-mercado
    @input batchMode: bool -> se true, aplica o tipo de preço a todas as boletas em preenchimento
    
    @example [user] todas a mercado -> { "type": "setRequestPriceType", "priceType": "M", "batchMode": true }

    */
    async setRequestPriceType({ type, priceType, batchMode = false }) {

        const selected = this.getSelectedRequest()
        if (!selected) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        const targets = batchMode ? this.getEditingRequests() : [selected]

        for (const request of targets) {
            await this.applyPriceType(request, priceType)
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, priceType, batchMode, count: targets.length, status: 'ok' }
    }

    /* # COMMAND

    determina o preço LIMITE para objeto Ordem/Boleta 'request' selecionado em foco. Isto é, preço máximo para compra ou mínimo para venda na EXECUÇÃO da ordem

    @note quando [priceLimit] é definido, a ordem é automaticamente definida como [priceType] = [L] Limit
    @note [priceLimit] é o preço LIMITE de EXECUÇÃO — NÃO confundir com [priceTrigger] (preço GATILHO/stop, definido por [setRequestPriceTrigger]). Em ordens STOP: o GATILHO dispara a ordem; o LIMITE define o teto de compra / piso de venda na execução após o disparo. Definir apenas o gatilho (sem limite) resulta em stop A MERCADO; definir gatilho + limite resulta em stop LIMITADA.
    @note ao utilizar preço relativo por 'reference' e 'offset' importante expressar o sinal no offset. Se for negativo ou positivo ( acima ou abaixo da referência )
    @note preço relativo pode ser Request ([R]). Significa alterar o preço em função de seu valor inicial ([priceLimit] atual).
    @note preço relativo pode ser Trigger ([T]). Significa calcular o LIMITE em função do preço GATILHO ([priceTrigger]) da própria boleta — típico de ordens stop limitadas (limite alguns ticks/percentual acima/abaixo do gatilho). Requer [priceTrigger] previamente definido via [setRequestPriceTrigger].
    @note se [batchMode] for true, o preço é aplicado a TODAS as boletas — RECOMENDADO apenas com preço RELATIVO ([reference]+[offset]): cada boleta calcula sobre a cotação do SEU ativo. Preço ABSOLUTO em lote aplica o MESMO valor a ativos distintos — usar com cautela.
    @note OFFSET / FOLGA / DISTÂNCIA / SPREAD DO STOP/GATILHO — expressões como "offset de stop", "offset do gatilho", "folga do stop", "distância do stop", "spread do gatilho", "limite X acima/abaixo do gatilho" descrevem o PREÇO LIMITE deslocado a partir do GATILHO → emitir [setRequestPriceLimit] com reference:"T" (NUNCA [setRequestPriceTrigger] com reference:"R"). O gatilho DISPARA a ordem; este offset posiciona o LIMITE de execução em relação a ele.
    @note SINAL com reference:"T" — a DIREÇÃO é AUTOMÁTICA pelo lado da ordem: COMPRA ⇒ limite ACIMA do gatilho; VENDA ⇒ limite ABAIXO. Informar apenas a MAGNITUDE do offset (o sinal é ignorado). Ex.: "10 centavos de offset" ⇒ offsetType:"U", offset:0.10 — o sistema soma (compra) ou subtrai (venda) conforme o lado.

    @input priceLimit: number -> preço limite absoluto para execução, expresso em valor monetário por cota, OU (null) se referência relativa
    @input reference: str -> preço limite relativo a referência de preço - [L]LastPrice [B]Bid OU [A]Ask OU [R]Request(limite atual) OU [T]Trigger(preço gatilho da boleta) OU (null) se Preço Absoluto
    @input offsetType: str -> tipo de deslocamento em relação à referência, deve ser mapeado para: [P] percentual OU [U] valor monetário OU [T] ticks OU (null) se Preço Absoluto
    @input offset: number -> (sinal +/-) valor de deslocamento em relação à referência, expresso em [offsetType] percentual, valor monetário ou quantidade de ticks
    @input batchMode: bool -> se true, aplica o preço a todas as boletas em preenchimento

    @example [user] preço 5% abaixo do mercado -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "L", "offsetType": "P", "offset": -5 }
    @example [user] melhora o preço em 10 ticks -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "R", "offsetType": "T", "offset": +10 }
    @example [user] vende por 15 centavos acima do ask -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "A", "offsetType": "U", "offset": +0.15 }
    @example [user] limite 1% acima do gatilho -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "T", "offsetType": "P", "offset": +1 }
    @example [user] stop em 30 com limite 10 centavos acima do gatilho -> [ { "type": "setRequestPriceTrigger", "priceTrigger": 30 }, { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "T", "offsetType": "U", "offset": +0.10 } ]
    @example [user] 5% abaixo do mercado para todas -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "L", "offsetType": "P", "offset": -5, "batchMode": true }
    @example [user] offset de stop 10 cents (stop de venda) -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "T", "offsetType": "U", "offset": -0.10 }
    @example [user] limite 10 centavos abaixo do gatilho -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "T", "offsetType": "U", "offset": -0.10 }
    @example [user] folga de 2% no stop (compra) -> { "type": "setRequestPriceLimit", "priceLimit": null, "reference": "T", "offsetType": "P", "offset": +2 }

    */
    async setRequestPriceLimit({ type, priceLimit, reference, offset, offsetType, batchMode = false }) {

        const selected = this.getSelectedRequest()
        if (!selected) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        const targets = batchMode ? this.getEditingRequests() : [selected]

        let applied = 0
        for (const request of targets) {
            if (await this.applyPriceLimit(request, priceLimit, reference, offset, offsetType)) applied++
        }

        if (!applied) {
            return AgentRuntime.instruction(type, 'não foi possível definir o preço — verifique a cotação ou os parâmetros informados')
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, priceLimit: selected.priceLimit, batchMode, count: applied, status: 'ok' }
    }

    /* # COMMAND

    determina o preço GATILHO (stop) para objeto Ordem/Boleta 'request' selecionado em foco — o preço que, ao ser atingido, DISPARA a ordem

    @note define o preço gatilho de uma ordem STOP. Quando o usuário informa "o preço" de uma ordem stop SEM qualificar, entende-se GATILHO ([priceTrigger]) — este comando.
    @note o LIMITE da ordem stop (preço de execução após o disparo) NÃO é definido aqui — deve ser informado EXPLICITAMENTE via [setRequestPriceLimit]. Sem limite explícito, a stop dispara a MERCADO.
    @note ao definir [priceTrigger], a boleta passa a ser uma ordem STOP; o [priceType] NÃO é alterado — permanece [M] (stop a mercado) até que um limite explícito seja definido por [setRequestPriceLimit] ([L] stop limitada).
    @note ao utilizar preço relativo por 'reference' e 'offset', expressar o sinal no offset (acima ou abaixo da referência).
    @note preço relativo pode ser Request ([R]) — altera o gatilho em função de seu valor inicial.
    @note se [batchMode] for true, o gatilho é aplicado a TODAS as boletas — RECOMENDADO apenas com preço RELATIVO ([reference]+[offset]): cada boleta calcula sobre a cotação do SEU ativo.
    @note NÃO usar este comando para "offset/folga/distância/spread do stop" — essas expressões definem o LIMITE relativo ao gatilho → [setRequestPriceLimit] com reference:"T". Aqui [reference]:"R" ajusta o PRÓPRIO gatilho em função de seu valor anterior (ex.: "sobe o gatilho 10 ticks"), nunca a relação gatilho↔limite.

    @input priceTrigger: number -> preço gatilho absoluto que dispara a ordem stop, expresso em valor monetário por cota, OU (null) se referência relativa
    @input reference: str -> gatilho relativo a referência de preço - [L]LastPrice [B]Bid OU [A]Ask ou [R]Request OU (null) se Preço Absoluto
    @input offsetType: str -> tipo de deslocamento em relação à referência: [P] percentual OU [U] valor monetário OU [T] ticks OU (null) se Preço Absoluto
    @input offset: number -> (sinal +/-) valor de deslocamento em relação à referência, expresso em [offsetType] percentual, valor monetário ou quantidade de ticks
    @input batchMode: bool -> se true, aplica o gatilho a todas as boletas em preenchimento

    @example [user] stop em 30 -> { "type": "setRequestPriceTrigger", "priceTrigger": 30 }
    @example [user] gatilho em 30,50 -> { "type": "setRequestPriceTrigger", "priceTrigger": 30.50 }
    @example [user] ordem stop no preço 25 -> { "type": "setRequestPriceTrigger", "priceTrigger": 25 }
    @example [user] stop 2% abaixo do mercado -> { "type": "setRequestPriceTrigger", "priceTrigger": null, "reference": "L", "offsetType": "P", "offset": -2 }
    @example [user] gatilho 10 ticks acima do último -> { "type": "setRequestPriceTrigger", "priceTrigger": null, "reference": "L", "offsetType": "T", "offset": +10 }
    @example [user] stop em 30 com limite em 29,80 -> [ { "type": "setRequestPriceTrigger", "priceTrigger": 30 }, { "type": "setRequestPriceLimit", "priceLimit": 29.80 } ]

    */
    async setRequestPriceTrigger({ type, priceTrigger, reference, offset, offsetType, batchMode = false }) {

        const selected = this.getSelectedRequest()
        if (!selected) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        const targets = batchMode ? this.getEditingRequests() : [selected]

        let applied = 0
        for (const request of targets) {
            if (await this.applyPriceTrigger(request, priceTrigger, reference, offset, offsetType)) applied++
        }

        if (!applied) {
            return AgentRuntime.instruction(type, 'não foi possível definir o preço gatilho — verifique a cotação ou os parâmetros informados')
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, priceTrigger: selected.priceTrigger, batchMode, count: applied, status: 'ok' }
    }

    /* # COMMAND

    determina o tipo de validade para objeto Ordem/Boleta 'request' selecionado em foco

    // ...existing code...
    @note 'VAC' significa 'Válida Até Cancelar' — refere-se EXCLUSIVAMENTE ao tipo de validade [GTC], nunca ao tipo de preço
    @note se [batchMode] for true, a validade é aplicada a TODAS as boletas em preenchimento (cesta) — usar quando o usuário disser "todas", "para todas as boletas", "toda a cesta"

    @input expireType: str -> tipo de validade, deve ser mapeado para: [DAY]<-válida pelo dia OU [GTC]<-válida até cancelar(VAC) OU [GTD]<-válida até data específica(VAD) OU [IOC]<-imediata executa ou cancela OU [FOK]<-imediata tudo ou nada OU [MOC]<-leilão de fechamento OU [MOA]<-leilão de abertura
    @input batchMode: bool -> se true, aplica a validade a TODAS as boletas em preenchimento, não apenas à selecionada

    @example [user] válido até dia 30 -> NÃO emitir setRequestExpireType=GTD. Emitir apenas: { "type": "setRequestExpireTime", "expireTime": "2026-06-30" }
    @example [user] validade até cancelar -> { "type": "setRequestExpireType", "expireType": "GTC" }
    @example [user] válido para hoje -> { "type": "setRequestExpireType", "expireType": "DAY" }
    @example [user] ordem VAC -> { "type": "setRequestExpireType", "expireType": "GTC" }
    @example [user] quero VAC -> { "type": "setRequestExpireType", "expireType": "GTC" }
    @example [user] validade até cancelar para todas as boletas -> { "type": "setRequestExpireType", "expireType": "GTC", "batchMode": true }
    @example [user] todas as ordens válidas para hoje -> { "type": "setRequestExpireType", "expireType": "DAY", "batchMode": true }

    */
    async setRequestExpireType({ type, expireType, batchMode = false }) {

        const selected = this.getSelectedRequest()
        if (!selected) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        const targets = batchMode ? this.getEditingRequests() : [selected]

        for (const request of targets) {
            this.applyExpireType(request, expireType)
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, expireType, expireTime: selected.expireTime, batchMode, count: targets.length, status: 'ok' }
    }

    /* # COMMAND

    determina a data e hora de expiração para objeto Ordem/Boleta 'request' selecionado em foco

    @note quando [expireTime] é definido, a ordem é automaticamente definida como [expireType] = [GTD] Good Till Date
    @note se [batchMode] for true, a data de expiração é aplicada a TODAS as boletas em preenchimento (cesta)

    @input expireTime: date -> data de expiração da ordem, expressa em formato ISO 'yyyy-MM-dd'
    @input batchMode: bool -> se true, aplica a data de expiração a TODAS as boletas em preenchimento, não apenas à selecionada

    @example [user] válido até 30/06 -> { "type": "setRequestExpireTime", "expireTime": "2026-06-30" }
    @example [user] todas válidas até 30/06 -> { "type": "setRequestExpireTime", "expireTime": "2026-06-30", "batchMode": true }

    */
    async setRequestExpireTime({ type, expireTime, batchMode = false }) {

        const selected = this.getSelectedRequest()
        if (!selected) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        const targets = batchMode ? this.getEditingRequests() : [selected]

        for (const request of targets) {
            this.applyExpireTime(request, expireTime)
        }

        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, expireTime, batchMode, count: targets.length, status: 'ok' }
    }

    /* # COMMAND

    lista as ordens/boletas em preenchimento

    @note retorna apenas requisições locais ainda não submetidas — ordens já enviadas à bolsa devem ser consultadas via [getOrderList]
    @note [filters.account] é opcional e controla o escopo da consulta:
    @note   • conta específica → seleciona a conta via [selectAccount] e lista SOMENTE as boletas dela
    @note   • '*' ou omitido → lista as boletas de TODAS as contas, SEM alterar a conta selecionada
    @note por padrão (sem [filters.account]) o escopo é TODAS as contas — informe uma conta específica para restringir

    @input filters: obj -> { account: str, requestType: str, symbol: str, side: str } -> filtros opcionais. [account]: conta específica (seleciona-a e restringe a ela) ou '*'/omitido (todas as contas, não altera seleção)
    @input fields: arr[str] -> [ requestId, requestType, orderId, account, symbol, side, quantity, quantityMin, quantityDisplay, priceType, priceLimit, expireType, expireTime ]

    @output requestId:       string -> identificador único da requisição
    @output requestType:     string -> tipo da requisição [C]criação, [M]modificação, [X]cancelamento
    @output orderId:         string -> identificador da ordem existente, caso seja modificação ou cancelamento
    @output account:         string -> conta vinculada à requisição
    @output symbol:          string -> ativo vinculado à requisição
    @output side:            string -> direção da ordem [B]compra ou [S]venda
    @output quantity:        number -> quantidade em número de cotas
    @output quantityMin:     number -> quantidade mínima de execução
    @output quantityDisplay: number -> quantidade visível ao mercado
    @output priceType:       string -> tipo de preço [L]imitado ou [M]ercado
    @output priceLimit:      number -> preço limite para execução
    @output expireType:      string -> tipo de validade da ordem
    @output expireTime:      date   -> data de expiração da ordem

    @example [user] minhas boletas em preenchimento          -> { "type": "getRequestList" }
    @example [user] boletas de compra                        -> { "type": "getRequestList", "filters": { "side": "B" } }
    @example [user] boletas de PETR4                          -> { "type": "getRequestList", "filters": { "symbol": "PETR4" } }
    @example [isAdminMode][user] boletas da conta 123456      -> { "type": "getRequestList", "filters": { "account": "123456" } }
    @example [isAdminMode][user] boletas de todas as contas   -> { "type": "getRequestList", "filters": { "account": "*" } }
    @example [isAdminMode][user] boletas de 123456 -> { "type": "getRequestList", "filters": { "account": "123456" } }

    */
    async getRequestList({ type, filters, fields }) {

        const account = filters?.account
        const allAccounts = !account || account === '*'

        // resolução de conta:
        // '*' ou omitido -> todas as contas (não altera selectedAccount)
        // conta específica -> seleciona e restringe a ela
        if (!allAccounts) {
            await this.selectAccount({ type: 'selectAccount', accountId: account })

            if (!this.selectedAccount) {
                return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
            }
        }

        const defaultFields = ['requestId', 'requestType', 'orderId', 'account', 'symbol', 'side', 'quantity', 'quantityMin', 'quantityDisplay', 'priceType', 'priceLimit', 'expireType', 'expireTime']

        if (!fields || fields.length === 0) {
            fields = defaultFields
        }

        // coleta as boletas conforme o escopo — todas as contas ou apenas a selecionada
        let requests = allAccounts
            ? this.getAllRequests()
            : this.getAllRequests(this.selectedAccount)

        if (filters) {
            if (filters.requestType) requests = requests.filter(r => r.requestType === filters.requestType)
            if (filters.symbol) requests = requests.filter(r => r.symbol === filters.symbol.toUpperCase())
            if (filters.side) requests = requests.filter(r => r.side === filters.side)
        }

        // registra a lista apresentada (GLOBAL) para resolução por índice em [selectRequest]
        // independe de conta — pode agregar boletas de várias contas (escopo '*'/omitido)
        this.selectedRequests = requests
        this.syncSelectedRequestToList()

        const data = requests.map(request => {
            const row = {}
            for (const field of fields.filter(f => defaultFields.includes(f))) {
                row[field] = request[field]
            }
            return row
        })

        this.outputCard = { type: 'requests', requests }

        return { type, account: allAccounts ? '*' : this.selectedAccount, data }
    }

    /* # COMMAND

    retorna contadores agregados das ordens/boletas em preenchimento, agrupados por tipo, ativo e direção

    @note retorna apenas requisições locais ainda não submetidas — ordens já enviadas à bolsa devem ser consultadas via [getOrderListSummary]
    @note [filters.account] é opcional e controla o escopo do resumo:
    @note   • conta específica → seleciona a conta via [selectAccount] e resume SOMENTE as boletas dela
    @note   • '*' ou omitido → resume as boletas de TODAS as contas, SEM alterar a conta selecionada
    @note por padrão (sem [filters.account]) o escopo é TODAS as contas — informe uma conta específica para restringir

    @input filters: obj -> { account: str, requestType: str, symbol: str, side: str } -> filtros opcionais. [account]: conta específica (seleciona-a e restringe a ela) ou '*'/omitido (todas as contas, não altera seleção)

    @output total:         number -> total de requisições encontradas
    @output byRequestType: obj    -> contagem agrupada por tipo de requisição [C]criação, [M]modificação, [X]cancelamento
    @output bySymbol:      obj    -> contagem agrupada por ativo
    @output bySide:        obj    -> contagem agrupada por direção [B]compra ou [S]venda

    @example [user] quantas boletas tenho em preenchimento?     -> { "type": "getRequestListSummary" }
    @example [user] resumo das boletas de PETR4                 -> { "type": "getRequestListSummary", "filters": { "symbol": "PETR4" } }
    @example [isAdminMode][user] resumo das boletas da conta 123456    -> { "type": "getRequestListSummary", "filters": { "account": "123456" } }
    @example [isAdminMode][user] resumo das boletas de todas as contas -> { "type": "getRequestListSummary", "filters": { "account": "*" } }

    */
    async getRequestListSummary({ type, filters }) {

        const account = filters?.account
        const allAccounts = !account || account === '*'

        // resolução de conta:
        // '*' ou omitido -> todas as contas (não altera selectedAccount)
        // conta específica -> seleciona e restringe a ela
        if (!allAccounts) {
            await this.selectAccount({ type: 'selectAccount', accountId: account })

            if (!this.selectedAccount) {
                return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
            }
        }

        // coleta as boletas conforme o escopo — todas as contas ou apenas a selecionada
        let requests = allAccounts
            ? this.getAllRequests()
            : this.getAllRequests(this.selectedAccount)

        if (filters) {
            if (filters.requestType) requests = requests.filter(r => r.requestType === filters.requestType)
            if (filters.symbol) requests = requests.filter(r => r.symbol === filters.symbol.toUpperCase())
            if (filters.side) requests = requests.filter(r => r.side === filters.side)
        }

        const byRequestType = {}
        const byAccount = {}
        const bySymbol = {}
        const bySide = {}

        for (const r of requests) {
            const rt = r.requestType || 'unknown'
            const ac = r.account || 'unknown'
            const sy = r.symbol || 'unknown'
            const si = r.side || 'unknown'
            byRequestType[rt] = (byRequestType[rt] || 0) + 1
            byAccount[ac] = (byAccount[ac] || 0) + 1
            bySymbol[sy] = (bySymbol[sy] || 0) + 1
            bySide[si] = (bySide[si] || 0) + 1
        }

        const summary = {
            total: requests.length,
            byRequestType,
            byAccount,
            bySymbol,
            bySide
        }

        this.outputCard = { type: 'requests', requests, summary }

        // registra a lista apresentada (GLOBAL) para resolução por índice em [selectRequest]
        this.selectedRequests = requests
        this.syncSelectedRequestToList()

        return {
            type,
            account: allAccounts ? '*' : this.selectedAccount,
            data: summary
        }
    }

    /* # COMMAND

    seleciona e registra em memória uma ordem vigente a ser utilizada como contexto atual para consultas e operações subsequentes.

    @note pré-requisito para comandos como [getOrder]
    @note[OrderSelection] ao selecionar a partir de uma lista de opções apresentadas, utilizar SEMPRE o campo 'orderId' da opção escolhida — nunca símbolo ou descrição.

    @input orderId: str -> identificador da ordem a ser selecionada
    
    @example [user] ver ordem 123456 -> { "type": "selectOrder", "orderId": "123456" }
    @example [user] detalhes da ordem 789 -> { "type": "selectOrder", "orderId": "789" }
    @example [user] consultar primeira ordem -> { "type": "selectOrder", "orderIndex": 0 }
    @example [user] apresente ultima ordem -> { "type": "selectOrder", "orderIndex": -1 }

    */
    async selectOrder({ type, orderId, orderIndex }) {

        if (!orderId && orderIndex !== undefined) {
            let orders = this.getAccountContext()?.selectedOrders
            if (orders) {
                if (orderIndex < 0) {
                    orderIndex = orders.length + orderIndex
                }
                orderId = orders[orderIndex] ? orders[orderIndex].orderId : undefined
            }
        }

        if (!orderId) {
            return AgentRuntime.instruction(type, 'informe o identificador da ordem que deseja consultar.')
        }

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const order = await this.orderService.getOpenOrder(account.account, orderId)
        if (!order) {
            return AgentRuntime.instruction(type, `ordem ${orderId} não encontrada`)

        }

        await this.selectSymbol({ type: 'selectSymbol', symbol: order.symbol })

        const accountContext = this.getAccountContext()
        order.selectedTime = nowTick()
        accountContext.selectedOrderId = order.orderId
        this.selectedOrderId = accountContext.selectedOrderId

        return AgentRuntime.instruction(type, `ordem ${order.orderId} selecionada.`)
    }

    /* # COMMAND

    obtem dados e informações de uma ordem vigente atualmente selecionada.

    @note pré-requisito: ordem selecionada em memória ([selectedOrderId]) — emitir [selectOrder] antes se necessário, de forma análoga a [selectSymbol] → [getQuote]
    @note sempre que a ordem for identificada por NÚMERO no mesmo input ("ver a ordem 123", "detalhes da ordem 789"), emitir [selectOrder] antes — sequência: [selectOrder] → [getOrder]
    @note sempre que a ordem for referenciada por ATIVO ("ver a ordem de PETR4"), emitir [selectSymbol] antes — o ativo selecionado direciona a ordem vigente correspondente — sequência: [selectSymbol] → [selectOrder] → [getOrder]
    @note sempre que a ordem for referenciada por POSIÇÃO na lista ("primeira ordem", "última ordem"), emitir [selectOrder] com [orderIndex] antes — sequência: [selectOrder] → [getOrder]
    @note se a ordem já estiver selecionada em memória, omitir [selectOrder] e emitir apenas [getOrder]

    @input fields: arr[str] -> [ orderId, account, symbol, side, quantity, quantityMin, quantityDisplay, priceType, priceLimit, expireType, expireTime, creationTime, orderStatus, statusText, requestType, requestStatus, pendingQuantity, filledQuantity, filledAveragePrice, filledVolume, pendingVolume ]
    @input askStatusText: bool (opcional) -> se true, solicita explicação do status e rejeição da ordem descrito em linguagem natural

    @output orderId:             string   -> identificador único da ordem
    @output account:             string   -> conta vinculada à ordem
    @output symbol:              string   -> ativo negociado
    @output side:                string   -> direção [B]compra ou [S]venda
    @output quantity:            number   -> quantidade total em cotas
    @output quantityMin:         number   -> quantidade mínima de execução
    @output quantityDisplay:     number   -> quantidade visível ao mercado (iceberg)
    @output priceType:           string   -> tipo de preço [L]imitado ou [M]ercado
    @output priceLimit:          number   -> preço limite definido para a ordem
    @output expireType:          string   -> tipo de validade [DAY] [GTC] [GTD] [IOC] [FOK] [MOC] [MOA]
    @output expireTime:          datetime -> data de expiração, caso GTD
    @output creationTime:        datetime -> data e hora de criação da ordem
    @output orderStatus:         string   -> status atual da ordem na bolsa
    @output statusText:          string   -> descrição textual do status da ordem ou motivo de rejeição
    @output requestType:         string   -> tipo de requisição [C]criação [M]modificação [X]cancelamento
    @output requestStatus:       string   -> status do processamento da requisição
    @output pendingQuantity:     number   -> quantidade ainda não executada
    @output filledQuantity:      number   -> quantidade já executada
    @output filledAveragePrice:  number   -> preço médio de execução
    @output filledVolume:        number   -> volume financeiro já executado
    @output pendingVolume:       number   -> volume financeiro ainda pendente

    @example [user] detalhes da ordem -> { "type": "getOrder", "fields": [ "orderId", "symbol", "side", "quantity", "orderStatus" ] }
    @example [user] quanto foi executado? -> { "type": "getOrder", "fields": [ "filledQuantity", "filledAveragePrice", "filledVolume" ] }
    @example [user] qual o status/situação da ordem? -> { "type": "getOrder", "fields": [ "orderStatus", "requestStatus" ], "askStatusText": true }
    @example [user] motivo da rejeição da ordem? -> { "type": "getOrder", "fields": [ "orderStatus", "statusText" ], "askStatusText": true }
    @example [user] ver a ordem 123456 -> [ { "type": "selectOrder", "orderId": "123456" }, { "type": "getOrder" } ]
    @example [user] quero ver essa ordem de COIN11 -> [ { "type": "selectSymbol", "symbol": "COIN11" }, { "type": "selectOrder" }, { "type": "getOrder" } ]
    @example [user] detalhes da última ordem -> [ { "type": "selectOrder", "orderIndex": -1 }, { "type": "getOrder" } ]
    @example [user] mostra a primeira ordem -> [ { "type": "selectOrder", "orderIndex": 0 }, { "type": "getOrder" } ]

    */
    async getOrder({ type, fields, askStatusText }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        if (!this.selectedOrderId) {
            return AgentRuntime.instruction(type, 'nenhuma ordem selecionada - solicite ao usuário que informe o número da ordem')
        }

        const accountContext = await this.getAccountContext()
        if (!accountContext) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        await this.loadOrders(accountContext)

        const order = accountContext.orders[this.selectedOrderId]
        if (!order) {
            return AgentRuntime.instruction(type, `ordem ${this.selectedOrderId} não encontrada`)
        }

        accountContext.selectedOrders = [order]

        const allowedFields = [
            'orderId', 'account', 'symbol', 'side',
            'quantity', 'quantityMin', 'quantityDisplay',
            'priceType', 'priceLimit',
            'expireType', 'expireTime', 'creationTime',
            'orderStatus', 'statusText', 'requestType', 'requestStatus',
            'pendingQuantity', 'filledQuantity',
            'filledAveragePrice', 'filledVolume', 'pendingVolume'
        ]

        if (!fields || fields.length === 0) {
            fields = allowedFields
        }

        const data = {}
        for (const field of fields.filter(f => allowedFields.includes(f))) {
            data[field] = order[field]
        }

        let statusText = undefined
        if (askStatusText) {
            statusText = await this.getOrderStatusText(order)
        }

        this.outputCard = { type: 'orders', orders: order ? [order] : undefined, statusText }

        return { type, account: this.selectedAccount, data }
    }

    /* # COMMAND

    lista ordens vigentes da conta selecionada

    @note ordens vigentes são ordens abertas e pendnetes de execução OU ordens criadas ou atualizadas no dia de hoje
    @note retorna ordens vigentes já submetidas à bolsa — boletas em preenchimento ainda não enviadas devem ser consultadas via [getRequestList]
    @note não implica ordem aberta ou status [N] Nova — ordens do dia ou de hoje podem estar em qualquer status

    @input filters: obj -> { symbol: str, side: str, orderStatus: str in (null ou [N] aberta ou [F] executada ou [X] cancelada ou [XP] expirada ou [XR] rejeitada ) } -> filtros opcionais para refinamento da lista - se não informado explicitamente, não infira valores nos filtros
    @input fields: arr[str] -> [ orderId, account, symbol, side, quantity, quantityMin, quantityDisplay, priceType, priceLimit, expireType, expireTime, creationTime, orderStatus, statusText, requestType, requestStatus, pendingQuantity, filledQuantity, filledAveragePrice, filledVolume, pendingVolume ]

    @output orderId:            string   -> identificador único da ordem
    @output account:            string   -> conta vinculada à ordem
    @output symbol:             string   -> ativo negociado
    @output side:               string   -> direção [B]compra ou [S]venda
    @output quantity:           number   -> quantidade total em cotas
    @output quantityMin:        number   -> quantidade mínima de execução
    @output quantityDisplay:    number   -> quantidade visível ao mercado (iceberg)
    @output priceType:          string   -> tipo de preço [L]imitado ou [M]ercado
    @output priceLimit:         number   -> preço limite
    @output expireType:         string   -> tipo de validade
    @output expireTime:         datetime -> data de expiração
    @output creationTime:       datetime -> data de criação
    @output orderStatus:        string   -> status atual da ordem ( ex.: [N] aberta, [F] executada, [X] cancelada, [XP] expirada, [XR] rejeitada )
    @output statusText:          string   -> descrição textual do status da ordem ou motivo de rejeição
    @output requestType:        string   -> tipo de requisição
    @output requestStatus:      string   -> status da requisição
    @output pendingQuantity:    number   -> quantidade pendente
    @output filledQuantity:     number   -> quantidade executada
    @output filledAveragePrice: number   -> preço médio de execução
    @output filledVolume:       number   -> volume executado
    @output pendingVolume:      number   -> volume financeiro ainda pendente

    @example [user] quais ordens estão abertas? -> { "type": "getOrderList" }
    @example [user] ordens de PETR4 -> { "type": "getOrderList", "filters": { "symbol": "PETR4" } }
    @example [user] minhas ordens de compra -> { "type": "getOrderList", "filters": { "side": "B" } }

    */
    async getOrderList({ type, filters, fields }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const accountContext = await this.getAccountContext()
        if (!accountContext) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const allowedFields = [
            'orderId', 'account', 'symbol', 'side',
            'quantity', 'quantityMin', 'quantityDisplay',
            'priceType', 'priceLimit',
            'expireType', 'expireTime', 'creationTime',
            'orderStatus', 'statusText', 'requestType', 'requestStatus',
            'pendingQuantity', 'filledQuantity',
            'filledAveragePrice', 'filledVolume', 'pendingVolume'
        ]

        if (!fields || fields.length === 0) {
            fields = allowedFields
        }

        const orders = await this.loadOrders(accountContext)

        let filtered = (orders || [])

        if (filters) {
            if (filters.symbol) filtered = filtered.filter(o => o.symbol === filters.symbol.toUpperCase())
            if (filters.side) filtered = filtered.filter(o => o.side === filters.side)
            if (filters.orderStatus) filtered = filtered.filter(o => o.orderStatus === filters.orderStatus)
        }

        if (filtered.length) {
            const forder = filtered[0]
            if (forder.orderId != accountContext.selectedOrderId) {
                await this.selectOrder({ type: 'selectOrder', orderId: forder.orderId })
            }
        }

        accountContext.selectedOrders = filtered

        const data = filtered.map(order => {
            const row = {}
            for (const field of fields.filter(f => allowedFields.includes(f))) {
                row[field] = order[field]
            }
            return row
        })

        this.outputCard = { type: 'orders', orders: filtered }

        return { type, account: this.selectedAccount, data }
    }

    /* # COMMAND

    cancela EM LOTE todas as ordens vigentes ABERTAS (com saldo pendente) da conta selecionada, gerando uma boleta de cancelamento [X] para cada ordem

    @note identifica todas as ordens vigentes com [pendingQuantity] > 0 e cria uma boleta de cancelamento por ordem — ordens já finalizadas (sem saldo pendente) são ignoradas
    @note NÃO envia os cancelamentos — apenas GERA as boletas [X] em preenchimento; o envio segue o fluxo normal de submissão
    @note cada boleta gerada preserva o [orderId] da ordem original e herda seus atributos (ativo, lado, quantidade, preço, validade)
    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note ordens que já possuam uma boleta de cancelamento [X] em preenchimento são ignoradas (evita duplicidade)
    @note aceita [filters] opcional para restringir por ativo ou direção — sem filtros, cancela TODAS as ordens abertas
    @note[out] apresentar o total de boletas de cancelamento geradas e os ativos afetados — NÃO emitir opinião

    @input filters: obj -> { symbol: str, side: str } -> filtros opcionais para restringir as ordens a cancelar

    @output account: string -> conta sobre a qual as boletas de cancelamento foram geradas
    @output total:   number -> quantidade de boletas de cancelamento criadas
    @output created: obj[]  -> boletas geradas — { orderId, symbol, side, quantity, requestId }
    @output skipped: obj[]  -> ordens ignoradas — { orderId, symbol, reason }
    @output status:  string -> 'ok' quando pelo menos uma boleta foi gerada

    @example [isDigitalMode][user] cancela todas as minhas ordens abertas        -> { "type": "cancelAllOrders" }
    @example [isDigitalMode][user] cancela todas as ordens de PETR4              -> { "type": "cancelAllOrders", "filters": { "symbol": "PETR4" } }
    @example [isDigitalMode][user] cancela todas as minhas ordens de compra      -> { "type": "cancelAllOrders", "filters": { "side": "B" } }
    @example [isAdminMode][user] cancela todas as ordens abertas da conta 123456 -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "cancelAllOrders" } ]

    */
    async cancelAllOrders({ type, filters }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        let orders = await this.orderService.getOpenOrders(account.account)
        if (!orders?.length) {
            return AgentRuntime.instruction(type, 'nenhuma ordem vigente encontrada para a conta selecionada')
        }

        // apenas ordens abertas (com saldo pendente) podem ser canceladas
        let pending = orders.filter(o => Number(o.pendingQuantity) > 0)

        if (filters?.symbol) {
            pending = pending.filter(o => o.symbol?.toUpperCase() === filters.symbol.toUpperCase())
        }
        if (filters?.side) {
            pending = pending.filter(o => o.side === filters.side)
        }

        if (!pending.length) {
            return AgentRuntime.instruction(type, 'nenhuma ordem aberta (com saldo pendente) encontrada para cancelamento')
        }

        const accountContext = this.getAccountContext()

        // orderIds que já possuem boleta de cancelamento em preenchimento
        const alreadyCancelling = new Set(
            Object.values(accountContext.requests)
                .filter(r => r.requestType === 'X' && r.orderId)
                .map(r => r.orderId)
        )

        const created = []
        const skipped = []

        for (const order of pending) {

            if (alreadyCancelling.has(order.orderId)) {
                skipped.push({ orderId: order.orderId, symbol: order.symbol, reason: 'cancelamento já em preenchimento' })
                continue
            }

            const requestId = Utils.getRandomToken(16)
            const request = {
                requestId,
                requestType: 'X',
                orderId: order.orderId,
                account: this.selectedAccount,
                symbol: order.symbol,
                side: order.side,
                quantity: order.quantity,
                volume: undefined,
                quantityMin: order.quantityMin,
                quantityDisplay: order.quantityDisplay,
                priceType: order.priceType,
                priceLimit: order.priceLimit,
                priceTrigger: order.priceTrigger,
                expireType: order.expireType,
                expireTime: order.expireTime,
                selectedTime: nowTick(),
                isNew: false
            }

            accountContext.requests[requestId] = request
            accountContext.selectedRequestId = requestId

            created.push({ orderId: order.orderId, symbol: order.symbol, side: order.side, quantity: order.quantity, requestId })
        }

        if (!created.length) {
            return AgentRuntime.instruction(type, 'nenhuma boleta de cancelamento gerada — as ordens abertas já possuem cancelamento em preenchimento')
        }

        this.outputCard = { type: 'requests' }

        return { type, account: this.selectedAccount, total: created.length, created, skipped, status: 'ok' }
    }

    /* # COMMAND

    retorna contadores agregados das ordens vigentes da conta selecionada, agrupados por status, ativo e direção

    @note ordens vigentes são ordens abertas e pendnetes de execução OU ordens criadas ou atualizadas no dia de hoje
    @note retorna ordens vigentes já submetidas à bolsa — boletas em preenchimento ainda não enviadas devem ser consultadas via [getRequestList]
    @note não implica ordem aberta ou status [N] Nova — ordens do dia ou de hoje podem estar em qualquer status

    @input filters: obj -> { symbol: str, side: str, orderStatus: str in (null ou [N] aberta ou [F] executada ou [X] cancelada ou [XP] expirada ou [XR] rejeitada ) } -> filtros opcionais para refinamento do resumo - se não informado explicitamente, não infira valores nos filtros
    
    @output total:         number -> total de ordens encontradas
    @output byStatus:      obj    -> contagem agrupada por status da ordem
    @output bySymbol:      obj    -> contagem agrupada por ativo
    @output bySide:        obj    -> contagem agrupada por direção [B]compra ou [S]venda

    @example [user] quantas ordens tenho abertas? -> { "type": "getOrderListSummary" }
    @example [user] resumo das ordens de PETR4 -> { "type": "getOrderListSummary", "filters": { "symbol": "PETR4" } }

    */
    async getOrderListSummary({ type, filters }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const accountContext = await this.getAccountContext()
        if (!accountContext) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        let filtered = accountContext.selectedOrders
        if (!filtered) {

            const orders = await this.loadOrders(accountContext)

            filtered = (orders || [])

            if (filters) {
                if (filters.symbol) filtered = filtered.filter(o => o.symbol === filters.symbol.toUpperCase())
                if (filters.side) filtered = filtered.filter(o => o.side === filters.side)
                if (filters.orderStatus) filtered = filtered.filter(o => o.orderStatus === filters.orderStatus)
            }

            accountContext.selectedOrders = filtered
        }

        const byStatus = {}
        const bySymbol = {}
        const bySide = {}

        for (const o of filtered) {
            const st = o.orderStatus || 'unknown'
            const sy = o.symbol || 'unknown'
            const si = o.side || 'unknown'
            byStatus[st] = (byStatus[st] || 0) + 1
            bySymbol[sy] = (bySymbol[sy] || 0) + 1
            bySide[si] = (bySide[si] || 0) + 1
        }

        const summary = { total: filtered.length, byStatus, bySymbol, bySide }

        this.outputCard = { type: 'orders', orders: filtered, summary }

        return {
            type,
            account: this.selectedAccount,
            data: summary
        }
    }

    /* # COMMAND

    obtem informações financeira da conta: saldos, limites operacionais e patrimônio financeiro (caixa) da conta selecionada

    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note retorna SALDO/CAIXA, limites e patrimônio consolidado — para posições em ATIVOS (renda variável) usar [getPositionSummary]
    
    @input fields: arr[str] -> [ balanceD0, balanceProjectedD1, balanceProjectedD2, balanceProjected, availableBalance, totalFreeze, totalEquity, daytradeAllocatedLimit, daytradeAvailableLimit, profitDaytrade ]

    @output balanceD0:              number -> saldo inicial em conta no dia (D0)
    @output balanceProjectedD1:     number -> saldo líquido de lançamentos projetado para D+1
    @output balanceProjectedD2:     number -> saldo líquido de lançamentos projetado para D+2
    @output balanceProjected:       number -> saldo
    @output availableBalance:       number -> limite operacional (saldo + alavancagem operacional)
    @output totalFreeze:            number -> total de valores bloqueados
    @output totalEquity:            number -> patrimônio online consolidado (saldo + renda fixa + renda variável)
    @output daytradeAllocatedLimit: number -> limite alocado para operações daytrade
    @output daytradeAvailableLimit: number -> limite disponível para operações daytrade
    @output profitDaytrade:         number -> resultado (lucro/prejuízo) de daytrade no dia

    @example [isDigitalMode][user] qual meu saldo disponível?            -> { "type": "getFinancial", "fields": [ "balanceProjected" ] }
    @example [isDigitalMode][user] quanto tenho de patrimônio?           -> { "type": "getFinancial", "fields": [ "totalEquity" ] }
    @example [isDigitalMode][user] meu limite e resultado de daytrade    -> { "type": "getFinancial", "fields": [ "daytradeAvailableLimit", "profitDaytrade" ] }
    @example [isDigitalMode][user] qual meu saldo projetado?             -> { "type": "getFinancial", "fields": [ "balanceProjected", "balanceProjectedD1", "balanceProjectedD2" ] }
    @example [isAdminMode][user] limite l.o. disponível da conta 123456        -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "getFinancial", "fields": [ "availableBalance" ] } ]

    */
    async getFinancial({ type, fields }) {

        this.queryAccountCommand = { type, fields }

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const financial = await this.positionService.getFinancial(account.account)
        if (!financial) {
            return AgentRuntime.instruction(type, 'informe que os dados financeiros da conta não foram encontrados')
        }

        const allowedFields = [
            'balanceD0', 'balanceProjectedD1', 'balanceProjectedD2', 'balanceProjected',
            'availableBalance', 'totalFreeze', 'totalEquity',
            'daytradeAllocatedLimit', 'daytradeAvailableLimit', 'profitDaytrade'
        ]

        if (!fields || fields.length === 0) {
            fields = allowedFields
        }

        const data = {}
        for (const field of fields.filter(f => allowedFields.includes(f))) {
            data[field] = financial[field]
        }

        this.outputCard = { type: 'financial', data }

        return { type, account: this.selectedAccount, data }
    }

    /* # COMMAND

    obtem resumo consolidado da carteira/portfolio da conta selecionada: total de ativos, volume financeiro investido e resultado (lucro/prejuízo)

    @note pré-requisito: conta selecionada em memória — emitir [selectAccount] antes se necessário
    @note retorna TOTALIZADORES agregados da carteira de renda variável — para detalhs financeiros de saldo/caixa/limites usar [getFinancial]
    @note em ambiguidade: "resultado/lucro/investido/carteira" → este comando; "saldo/disponível/limite/caixa" → [getFinancial]

    @input fields: arr[str] -> [ positionCount, volume, profit, profitPercent, profitD0, profitPercentD0 ]

    @output positionCount:   number -> quantidade de ativos distintos em carteira
    @output volume:          number -> volume financeiro total da carteira (posição atual)
    @output profit:          number -> resultado (lucro/prejuízo) consolidado acumulado, em valor monetário
    @output profitPercent:   number -> resultado consolidado acumulado, em percentual
    @output profitD0:        number -> resultado (lucro/prejuízo) do dia (D0), em valor monetário
    @output profitPercentD0: number -> resultado do dia (D0), em percentual

    @example [isDigitalMode][user] qual o resultado da minha carteira?    -> { "type": "getPositionSummary", "fields": [ "profit", "profitPercent" ] }
    @example [isDigitalMode][user] quanto tenho investido?                -> { "type": "getPositionSummary", "fields": [ "volume" ] }
    @example [isDigitalMode][user] quantos ativos tenho em carteira?      -> { "type": "getPositionSummary", "fields": [ "positionCount" ] }
    @example [isDigitalMode][user] como está minha carteira hoje?         -> { "type": "getPositionSummary", "fields": [ "profitD0", "profitPercentD0" ] }
    @example [isAdminMode][user] resultado da carteira da conta 123456    -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "getPositionSummary", "fields": [ "profit", "profitPercent" ] } ]

    */
    async getPositionSummary({ type, fields }) {

        this.queryAccountCommand = { type, fields }

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const summary = await this.positionService.getPositionSummary(account.account)
        if (!summary) {
            return AgentRuntime.instruction(type, 'informe que o resumo da carteira não foi encontrado')
        }

        const allowedFields = ['positionCount', 'volume', 'profit', 'profitPercent', 'profitD0', 'profitPercentD0']

        if (!fields || fields.length === 0) {
            fields = allowedFields
        }

        const data = {}
        for (const field of fields.filter(f => allowedFields.includes(f))) {
            data[field] = summary[field]
        }

        this.outputCard = { type: 'position_summary', data }

        return { type, account: this.selectedAccount, data }
    }

    /* # COMMAND

    obtem a posição em carteira de um ativo específico da conta selecionada: quantidades, preço médio, volume e resultado

    @note pré-requisitos: conta selecionada ([selectAccount]) e ativo selecionado ([selectSymbol]) em memória — emitir ambos antes se necessário
    @note sempre que o ativo for nomeado no input ("posição de PETR4", "quanto tenho de VALE3"), emitir [selectSymbol] antes — sequência: [selectSymbol] → [getPosition]
    @note retorna a posição de UM ativo (renda variável) — para o resumo consolidado da carteira usar [getPositionSummary]; para saldo/caixa/limites usar [getFinancial]
    @note [totalQuantity] representa a posição líquida — positiva se comprada, negativa se vendida

    @input fields: arr[str] -> [ account, symbol, positionType, quantityD0, quantityProjectedD1, quantityProjectedD2, totalQuantity, availableQuantity, blockedQuantity, volume, investedVolume, avgPrice, investedVolumeAdjusted, avgPriceAdjusted, profit, profitPercent, earningsVolume, yieldOnCost, profitD0, profitPercentD0, positionWeight ]

    @output account:                string -> conta vinculada à posição
    @output symbol:                 string -> ativo da posição
    @output positionType:           string -> tipo/natureza da posição
    @output quantityD0:             number -> quantidade em custódia no dia (D0)
    @output quantityProjectedD1:    number -> quantidade projetada para D+1
    @output quantityProjectedD2:    number -> quantidade projetada para D+2
    @output totalQuantity:          number -> quantidade líquida total (positiva comprada, negativa vendida)
    @output availableQuantity:      number -> quantidade disponível para negociação
    @output blockedQuantity:        number -> quantidade bloqueada/indisponível
    @output volume:                 number -> volume financeiro atual da posição (marcado a mercado)
    @output investedVolume:         number -> volume financeiro investido (custo de aquisição)
    @output avgPrice:               number -> preço médio de aquisição
    @output investedVolumeAdjusted: number -> volume investido ajustado por proventos
    @output avgPriceAdjusted:       number -> preço médio ajustado por proventos
    @output profit:                 number -> resultado (lucro/prejuízo) acumulado, em valor monetário
    @output profitPercent:          number -> resultado acumulado, em percentual
    @output earningsVolume:         number -> volume de proventos recebidos
    @output yieldOnCost:            number -> rendimento sobre o custo (yield on cost), em percentual
    @output profitD0:               number -> resultado (lucro/prejuízo) do dia (D0), em valor monetário
    @output profitPercentD0:        number -> resultado do dia (D0), em percentual
    @output positionWeight:         number -> peso da posição na carteira, em percentual

    @example [isDigitalMode][user] qual minha posição em PETR4?            -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "getPosition" } ]
    @example [isDigitalMode][user] quanto tenho de VALE3?                  -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "getPosition", "fields": [ "totalQuantity" ] } ]
    @example [isDigitalMode][user] qual meu preço médio de ITUB4?         -> [ { "type": "selectSymbol", "symbol": "ITUB4" }, { "type": "getPosition", "fields": [ "avgPrice" ] } ]
    @example [isDigitalMode][user] qual o resultado da minha posição em BBAS3? -> [ { "type": "selectSymbol", "symbol": "BBAS3" }, { "type": "getPosition", "fields": [ "profit", "profitPercent" ] } ]
    @example [isDigitalMode][user] quanto tenho disponível de PETR4?      -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "getPosition", "fields": [ "availableQuantity", "blockedQuantity" ] } ]
    @example [isAdminMode][user] posição de PETR4 da conta 123456         -> [ { "type": "selectAccount", "accountId": "123456" }, { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "getPosition" } ]

    */
    async getPosition({ type, fields }) {

        this.queryAccountCommand = { type, fields }

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const position = await this.positionService.getPosition(account.account, this.selectedSymbol)
        if (!position) {
            return AgentRuntime.instruction(type, `informe que não foi encontrada posição para ${this.selectedSymbol}`)
        }

        const allowedFields = [
            'account', 'symbol', 'positionType',
            'quantityD0', 'quantityProjectedD1', 'quantityProjectedD2',
            'totalQuantity', 'availableQuantity', 'blockedQuantity',
            'volume', 'investedVolume', 'avgPrice',
            'investedVolumeAdjusted', 'avgPriceAdjusted',
            'profit', 'profitPercent', 'earningsVolume', 'yieldOnCost',
            'profitD0', 'profitPercentD0', 'positionWeight'
        ]

        if (!fields || fields.length === 0) {
            fields = allowedFields
        }

        const data = {}
        for (const field of fields.filter(f => allowedFields.includes(f))) {
            data[field] = position[field]
        }

        this.outputCard = { type: 'position', account: this.selectedAccount, symbol: this.selectedSymbol, data }

        return { type, account: this.selectedAccount, symbol: this.selectedSymbol, data }
    }

    /* # COMMAND

    define quantidade e direção da boleta em função da posição atual em carteira do ativo selecionado

    @note obtém automaticamente a posição do ativo selecionado e calcula quantidade com base na operação
    @note [increase] abre na MESMA direção da posição — se posição é comprada, compra mais; se vendida, vende mais
    @note [decrease] abre na direção OPOSTA — reduz a posição sem zerá-la
    @note [close] abre na direção oposta com quantidade total — zera a posição completamente
    @note pré-requisito: [selectSymbol] + conta selecionada + boleta em preenchimento
    @note preço é definido como [M]ercado por padrão se não houver preço já definido na boleta — pode ser ajustado via [setRequestPriceType] ou [setRequestPriceLimit]

    @input operation:  str    -> operação em relação à posição: [increase]<-aumentar OU [decrease]<-reduzir OU [close]<-zerar
    @input offsetType: str    -> tipo de deslocamento: [P]percentual OU [U]unidades/cotas — ignorado se [close]
    @input offset:     number -> magnitude do deslocamento (sempre positivo — direção inferida pela operação)

    @example [user] aumenta 10% a posição de PETR4       -> [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "setRequestType" }, { "type": "setRequestQuantityFromPosition", "operation": "increase", "offsetType": "P", "offset": 10 } ]
    @example [user] reduz 30% da posição de VALE3        -> [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "setRequestType" }, { "type": "setRequestQuantityFromPosition", "operation": "decrease", "offsetType": "P", "offset": 30 } ]
    @example [user] zera posição de ITUB4                -> [ { "type": "selectSymbol", "symbol": "ITUB4" }, { "type": "setRequestType" }, { "type": "setRequestQuantityFromPosition", "operation": "close" } ]
    @example [user] aumenta 500 cotas na posição de BBAS3 -> [ { "type": "selectSymbol", "symbol": "BBAS3" }, { "type": "setRequestType" }, { "type": "setRequestQuantityFromPosition", "operation": "increase", "offsetType": "U", "offset": 500 } ]

    */
    async setRequestQuantityFromPosition({ type, operation, offsetType, offset }) {

        const existing = this.getSelectedRequest(false)
        const needsNewRequest = existing && !existing.isNew && existing.symbol && existing.symbol !== this.selectedSymbol

        const request = this.getSelectedRequest(needsNewRequest ? 'new' : true)
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        if (needsNewRequest) {
            request.requestType = 'C'
        }

        if (!this.selectedSymbol) {
            return AgentRuntime.instruction(type, 'nenhum ativo selecionado - solicite ao usuário que informe um ativo válido')
        }

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const position = await this.positionService.getPosition(account.account, this.selectedSymbol)
        if (!position || !position.totalQuantity) {
            return AgentRuntime.instruction(type, `nenhuma posição encontrada para ${this.selectedSymbol} — não há quantidade para referenciar`)
        }

        const totalQuantity = position.totalQuantity
        const positionSide = totalQuantity > 0 ? 'B' : 'S'
        const closeSide = positionSide === 'B' ? 'S' : 'B'
        const absQuantity = Math.abs(totalQuantity)

        let quantity = 0
        let side = undefined

        if (operation === 'increase') {
            side = positionSide
            if (offsetType === 'P') quantity = Math.round(absQuantity * offset / 100)
            else if (offsetType === 'U') quantity = Math.round(offset)
        } else if (operation === 'decrease') {
            side = closeSide
            if (offsetType === 'P') quantity = Math.round(absQuantity * offset / 100)
            else if (offsetType === 'U') quantity = Math.round(Math.min(offset, absQuantity))
        } else if (operation === 'close') {
            side = closeSide
            quantity = absQuantity
        }

        if (!quantity || quantity <= 0) {
            return AgentRuntime.instruction(type, 'quantidade calculada inválida — verifique o offset informado')
        }

        request.symbol = this.selectedSymbol
        request.side = side
        request.quantity = quantity
        request.volume = undefined

        // assume mercado por padrão — posição já conhecida, preço não é restrição
        if (!request.priceType && !request.priceLimit) {
            request.priceType = 'M'
            request.priceLimit = undefined
        }

        request.isNew = false
        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, operation, side, quantity, positionQuantity: totalQuantity, status: 'ok' }
    }

    /* # COMMAND

    define o volume financeiro da boleta em preenchimento a partir do valor de mercado da posição de um ativo de ORIGEM — usado para reaproveitar o financeiro liberado ao zerar/reduzir uma posição numa nova ordem de outro ativo.

    @note obtém automaticamente o valor de mercado (financeiro) da posição do ativo de ORIGEM ([sourceSymbol]) e o aplica como volume da boleta selecionada em foco — o volume NUNCA é informado ou calculado manualmente pelo usuário/modelo.
    @note destina-se a operações de TROCA reaproveitando o financeiro ("zera X e compra Y com o mesmo financeiro", "troca X por Y com o mesmo valor", "vende X e aplica o dinheiro em Y").
    @note o valor de referência é o VALOR DE MERCADO atual da posição de origem (position.volume) — não o volume investido (custo) nem o resultado. Não desconta custos operacionais.
    @note [sourceSymbol] é o ativo VENDIDO/ZERADO (origem do financeiro), NÃO o ativo da boleta em preenchimento (destino). O ativo de destino já está definido na boleta via [setRequestSymbol].
    @note por padrão aplica 100% do financeiro da posição de origem. Para reaproveitar parte, usar [offsetType:"P"] + [offset] (ex: metade do financeiro -> offset:50).
    @note ao definir o volume, a quantidade em cotas previamente definida na boleta é descartada (volume e quantidade são mutuamente exclusivos).
    @note preço é definido como [M]ercado por padrão se não houver preço já definido na boleta — pode ser ajustado via [setRequestPriceType] ou [setRequestPriceLimit].
    @note pré-requisito: conta selecionada + boleta em preenchimento (destino) + posição existente com valor de mercado no ativo de origem.
    @note requer a posição de origem AINDA vigente em carteira — deve ser emitido no MESMO turno da zeragem, antes do envio das ordens, enquanto a posição de origem ainda existe para referência.

    @input sourceSymbol: str    -> código/ticker do ativo de ORIGEM cuja posição financia a nova ordem (o ativo sendo zerado/reduzido)
    @input offsetType:   str    -> tipo de deslocamento sobre o financeiro da posição de origem: [P]percentual — (null) equivale a 100% do financeiro
    @input offset:       number -> (sempre positivo) magnitude do percentual a reaproveitar quando [offsetType:"P"] — ignorado se [offsetType] ausente (assume 100%)

    @example [isDigitalMode][user] zera BTLG11 e compra PETR4 com o mesmo financeiro ->
        grupo1: [ { "type": "selectSymbol", "symbol": "BTLG11" }, { "type": "setRequestType", "requestType": "C" }, { "type": "setRequestQuantityFromPosition", "operation": "close" } ]
        grupo2: [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "setRequestType", "requestType": "C", "newRequest": true }, { "type": "setRequestSymbol" }, { "type": "setRequestSide", "side": "B" }, { "type": "setRequestVolumeFromPosition", "sourceSymbol": "BTLG11" } ]

    @example [isAdminMode][user] na conta 1067470 zere BTLG11 e compre PETR4 o mesmo financeiro ->
        [ { "type": "selectAccount", "accountId": "1067470" } ]
        grupo1: [ { "type": "selectSymbol", "symbol": "BTLG11" }, { "type": "setRequestType", "requestType": "C" }, { "type": "setRequestQuantityFromPosition", "operation": "close" } ]
        grupo2: [ { "type": "selectSymbol", "symbol": "PETR4" }, { "type": "setRequestType", "requestType": "C", "newRequest": true }, { "type": "setRequestSymbol" }, { "type": "setRequestSide", "side": "B" }, { "type": "setRequestVolumeFromPosition", "sourceSymbol": "BTLG11" } ]

    @example [user] troca VALE3 por ITUB4 com o mesmo valor ->
        grupo1: [ { "type": "selectSymbol", "symbol": "VALE3" }, { "type": "setRequestType", "requestType": "C" }, { "type": "setRequestQuantityFromPosition", "operation": "close" } ]
        grupo2: [ { "type": "selectSymbol", "symbol": "ITUB4" }, { "type": "setRequestType", "requestType": "C", "newRequest": true }, { "type": "setRequestSymbol" }, { "type": "setRequestSide", "side": "B" }, { "type": "setRequestVolumeFromPosition", "sourceSymbol": "VALE3" } ]

    @example [user] vende metade de BBAS3 e aplica esse dinheiro em BBDC4 ->
        grupo1: [ { "type": "selectSymbol", "symbol": "BBAS3" }, { "type": "setRequestType", "requestType": "C" }, { "type": "setRequestQuantityFromPosition", "operation": "decrease", "offsetType": "P", "offset": 50 } ]
        grupo2: [ { "type": "selectSymbol", "symbol": "BBDC4" }, { "type": "setRequestType", "requestType": "C", "newRequest": true }, { "type": "setRequestSymbol" }, { "type": "setRequestSide", "side": "B" }, { "type": "setRequestVolumeFromPosition", "sourceSymbol": "BBAS3", "offsetType": "P", "offset": 50 } ]

    */
    async setRequestVolumeFromPosition({ type, sourceSymbol, offsetType, offset }) {

        const request = this.getSelectedRequest()
        if (!request) {
            return AgentRuntime.instruction(type, 'nenhuma boleta em preenchimento no momento')
        }

        if (!sourceSymbol) {
            return AgentRuntime.instruction(type, 'informe o ativo de origem que financia a ordem')
        }

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const position = await this.positionService.getPosition(account.account, sourceSymbol.toUpperCase())
        if (!position || !position.volume) {
            return AgentRuntime.instruction(type, `nenhum valor de mercado encontrado na posição de ${sourceSymbol} — não há financeiro para referenciar`)
        }

        const pct = (offsetType === 'P' && offset) ? offset : 100
        const volume = Math.round(Math.abs(position.volume) * pct / 100 * 100) / 100

        if (!volume || volume <= 0) {
            return AgentRuntime.instruction(type, 'volume calculado inválido — verifique o percentual informado')
        }

        request.volume = volume
        request.quantity = undefined

        // assume mercado por padrão — financeiro já conhecido, preço não é restrição
        if (!request.priceType && !request.priceLimit) {
            request.priceType = 'M'
            request.priceLimit = undefined
        }

        request.isNew = false
        this.validateSelectedRequest = true
        this.outputCard = { type: 'requests' }

        return { type, sourceSymbol: sourceSymbol.toUpperCase(), volume, positionVolume: position.volume, status: 'ok' }
    }

    /* # COMMAND

    cria boletas em lote para múltiplos ativos em carteira da conta selecionada, com base nas posições vigentes

    @note cria uma boleta por ativo encontrado — cada boleta recebe quantidade e direção calculadas automaticamente
    @note ativos com posição zerada (totalQuantity = 0) são ignorados automaticamente
    @note [increase] compra mais de cada ativo com posição comprada / vende mais de cada ativo com posição vendida
    @note [decrease] vende parte de cada posição comprada / compra parte de cada posição vendida
    @note [close]    cria ordens opostas para zerar todas as posições encontradas
    @note preço é definido como [M]ercado por padrão — pode ser ajustado individualmente via [setRequestPriceType] ou [setRequestPriceLimit] após a criação

    @input operation:  str -> [increase]<-aumentar OU [decrease]<-reduzir OU [close]<-zerar
    @input offsetType: str    -> [P]percentual OU [U]unidades/cotas — ignorado se [close]
    @input offset:     number -> magnitude do deslocamento — ignorado se [close]
    @input filters:    obj    -> { symbol: str } -> filtros opcionais

    @example [user] zera todas as posições               -> { "type": "createRequestsFromPositions", "operation": "close" }
    @example [user] reduz 30% de todos os ativos         -> { "type": "createRequestsFromPositions", "operation": "decrease", "offsetType": "P", "offset": 30 }
    @example [user] aumenta 10% em todos os ativos       -> { "type": "createRequestsFromPositions", "operation": "increase", "offsetType": "P", "offset": 10 }

    */
    async createRequestsFromPositions({ type, operation, offsetType, offset, filters }) {

        if (!this.selectedAccount) {
            return AgentRuntime.instruction(type, 'nenhuma conta selecionada - solicite ao usuário que informe uma conta válida')
        }

        const account = await this.accountService.getAccount(this.selectedAccount, { headers: this.headers })
        if (!account) {
            return AgentRuntime.instruction(type, 'conta não encontrada - não foi possível encontrar informações')
        }

        const positions = await this.positionService.getPositions(account.account)
        if (!positions?.length) {
            return AgentRuntime.instruction(type, 'nenhuma posição encontrada para a conta selecionada')
        }

        let filtered = positions.filter(p => (p.totalQuantity || 0) !== 0)

        if (filters?.symbol) {
            filtered = filtered.filter(p => p.symbol === filters.symbol.toUpperCase())
        }

        if (!filtered.length) {
            return AgentRuntime.instruction(type, 'nenhuma posição com quantidade válida encontrada')
        }

        const accountContext = this.getAccountContext()
        const created = []
        const skipped = []

        for (const position of filtered) {

            const totalQuantity = position.totalQuantity
            const positionSide = totalQuantity > 0 ? 'B' : 'S'
            const closeSide = positionSide === 'B' ? 'S' : 'B'
            const absQuantity = Math.abs(totalQuantity)

            let quantity = 0
            let side = undefined

            if (operation === 'increase') {
                side = positionSide
                if (offsetType === 'P') quantity = Math.round(absQuantity * offset / 100)
                else if (offsetType === 'U') quantity = Math.round(offset)
            } else if (operation === 'decrease') {
                side = closeSide
                if (offsetType === 'P') quantity = Math.round(absQuantity * offset / 100)
                else if (offsetType === 'U') quantity = Math.round(Math.min(offset, absQuantity))
            } else if (operation === 'close') {
                side = closeSide
                quantity = absQuantity
            }

            if (!quantity || quantity <= 0) {
                skipped.push(position.symbol)
                continue
            }

            const requestId = Utils.getRandomToken(16)
            const request = {
                requestId,
                requestType: 'C',
                orderId: undefined,
                account: this.selectedAccount,
                symbol: position.symbol,
                side,
                quantity,
                volume: undefined,
                quantityMin: undefined,
                quantityDisplay: undefined,
                priceType: 'M',
                priceLimit: undefined,
                expireType: 'DAY',
                expireTime: undefined,
                selectedTime: nowTick(),
                isNew: false
            }

            accountContext.requests[requestId] = request
            accountContext.selectedRequestId = requestId

            created.push({ symbol: position.symbol, side, quantity, requestId })
        }

        if (!created.length) {
            return AgentRuntime.instruction(type, 'nenhuma boleta criada — verifique os parâmetros informados')
        }

        this.outputCard = { type: 'requests' }

        return { type, operation, total: created.length, created, skipped, status: 'ok' }
    }

    // ===== comandos migrados do antigo content-agent (Research) =====
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

// --- metadados de versão dos comandos (decorators tool) ---
TraderAgent.agentName = 'trader'

tool({ version: '1.0.0', name: 'querySymbol' })(TraderAgent, 'querySymbol')
tool({ version: '1.0.0', name: 'selectSymbol' })(TraderAgent, 'selectSymbol')
tool({ version: '1.0.0', name: 'getSecurity' })(TraderAgent, 'getSecurity')
tool({ version: '1.0.0', name: 'getQuote' })(TraderAgent, 'getQuote')
tool({ version: '1.0.0', name: 'queryAccount' })(TraderAgent, 'queryAccount')
tool({ version: '1.0.0', name: 'selectAccount' })(TraderAgent, 'selectAccount')
tool({ version: '1.0.0', name: 'getAccount' })(TraderAgent, 'getAccount')
tool({ version: '1.0.0', name: 'getAlertList' })(TraderAgent, 'getAlertList')
tool({ version: '1.0.0', name: 'validateRequestStatus' })(TraderAgent, 'validateRequestStatus')
tool({ version: '1.0.0', name: 'getRequest' })(TraderAgent, 'getRequest')
tool({ version: '1.0.0', name: 'cancelRequest' })(TraderAgent, 'cancelRequest')
tool({ version: '1.0.0', name: 'selectRequest' })(TraderAgent, 'selectRequest')
tool({ version: '1.0.0', name: 'setRequestType' })(TraderAgent, 'setRequestType')
tool({ version: '1.0.0', name: 'setRequestOrderId' })(TraderAgent, 'setRequestOrderId')
tool({ version: '1.0.0', name: 'setRequestSymbol' })(TraderAgent, 'setRequestSymbol')
tool({ version: '1.0.0', name: 'setRequestSide' })(TraderAgent, 'setRequestSide')
tool({ version: '1.0.0', name: 'setRequestQuantity' })(TraderAgent, 'setRequestQuantity')
tool({ version: '1.0.0', name: 'setRequestVolume' })(TraderAgent, 'setRequestVolume')
tool({ version: '1.0.0', name: 'setRequestQuantityMin' })(TraderAgent, 'setRequestQuantityMin')
tool({ version: '1.0.0', name: 'setRequestQuantityDisplay' })(TraderAgent, 'setRequestQuantityDisplay')
tool({ version: '1.0.0', name: 'setRequestPriceType' })(TraderAgent, 'setRequestPriceType')
tool({ version: '1.0.0', name: 'setRequestPriceLimit' })(TraderAgent, 'setRequestPriceLimit')
tool({ version: '1.0.0', name: 'setRequestPriceTrigger' })(TraderAgent, 'setRequestPriceTrigger')
tool({ version: '1.0.0', name: 'setRequestExpireType' })(TraderAgent, 'setRequestExpireType')
tool({ version: '1.0.0', name: 'setRequestExpireTime' })(TraderAgent, 'setRequestExpireTime')
tool({ version: '1.0.0', name: 'getRequestList' })(TraderAgent, 'getRequestList')
tool({ version: '1.0.0', name: 'getRequestListSummary' })(TraderAgent, 'getRequestListSummary')
tool({ version: '1.0.0', name: 'selectOrder' })(TraderAgent, 'selectOrder')
tool({ version: '1.0.0', name: 'getOrder' })(TraderAgent, 'getOrder')
tool({ version: '1.0.0', name: 'getOrderList' })(TraderAgent, 'getOrderList')
tool({ version: '1.0.0', name: 'cancelAllOrders' })(TraderAgent, 'cancelAllOrders')
tool({ version: '1.0.0', name: 'getOrderListSummary' })(TraderAgent, 'getOrderListSummary')
tool({ version: '1.0.0', name: 'getFinancial' })(TraderAgent, 'getFinancial')
tool({ version: '1.0.0', name: 'getPositionSummary' })(TraderAgent, 'getPositionSummary')
tool({ version: '1.0.0', name: 'getPosition' })(TraderAgent, 'getPosition')
tool({ version: '1.0.0', name: 'setRequestQuantityFromPosition' })(TraderAgent, 'setRequestQuantityFromPosition')
tool({ version: '1.0.0', name: 'setRequestVolumeFromPosition' })(TraderAgent, 'setRequestVolumeFromPosition')
tool({ version: '1.0.0', name: 'createRequestsFromPositions' })(TraderAgent, 'createRequestsFromPositions')
tool({ version: '1.0.1', name: 'getLendingRate' })(TraderAgent, 'getLendingRate')
tool({ version: '1.0.0', name: 'getFundamentals' })(TraderAgent, 'getFundamentals')
tool({ version: '1.0.0', name: 'getFundamentalsSummary' })(TraderAgent, 'getFundamentalsSummary')
tool({ version: '1.0.0', name: 'getPortfolioAnalysis' })(TraderAgent, 'getPortfolioAnalysis')
tool({ version: '1.0.0', name: 'getPortfolioRecommendationSell' })(TraderAgent, 'getPortfolioRecommendationSell')
tool({ version: '1.0.0', name: 'getPortfolioRecommendationBuy' })(TraderAgent, 'getPortfolioRecommendationBuy')
tool({ version: '1.0.0', name: 'executePortfolioRecommendation' })(TraderAgent, 'executePortfolioRecommendation')
tool({ version: '1.0.0', name: 'getTopPicks' })(TraderAgent, 'getTopPicks')

AgentRuntime.agentClasses['trader-agent'] = TraderAgent
TraderAgent.commandSources = [{ agent: 'trader', class: TraderAgent }]

module.exports = { TraderAgent, BaseAgent, tool, nowTick, DEFAULT_PAGE_SIZE }
