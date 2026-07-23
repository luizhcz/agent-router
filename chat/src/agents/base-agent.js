const { AgentRuntime } = require("../agent-runtime")
const { EnvUtils, Utils } = require("../utils")

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

        const contextId = this.context.contextId

        if (contextId.startsWith('admin:')) {
            const userProfileId = contextId.substring(6).split(':')[0]
            const session = await this.accountService.getSessionAdmin(userProfileId)

            this.headers = {
                'app_origin': 'admin',
                'access_token': session?.accessToken
            }

            this.isAdminMode = true
            this.isDigitalMode = false

        } else if (contextId.startsWith('digital:')) {

            const account = contextId.substring(8).split(':')[0]
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

        const vmatch = contextId.match(/(?:^|:)v=([^:]+)/)
        if (vmatch && Utils.isValidVersion(vmatch[1])) {
            this.chatVersion = vmatch[1]
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

module.exports = { BaseAgent, tool, nowTick, DEFAULT_PAGE_SIZE }
