const { AccountService } = require("./mock/account-service")
const { AlertService } = require("./mock/alert-service")
const { AgentRuntime } = require("./agent-runtime")
require("./trader-agent")
const { AwsSecrets } = require("./mock/aws-secrets")
const { DbClient } = require("./mock/db-client")
const { HttpServer } = require("./mock/http-server")
const { MarketDataService } = require("./mock/marketdata-service")
const { OrderService } = require("./mock/order-service")
const { ProxyUtil } = require("./mock/proxy-util")
const { RedisClient } = require("./mock/redis-client")
const { SubscriptionService } = require("./mock/subscription-service")
const { EnvUtils, DateUtils, Utils } = require("./utils")
const path = require('path')
const fs = require('fs')
const { PositionService } = require("./mock/position-service")
const { PortfolioRecommender } = require("./mock/portfolio-recommender")
const { WriteThroughStore, PgConversationStore, RedisConversationStore, ConversationService } = require("./conversation")
const { PgClient } = require("./mock/postgres-client")
const { PostgresClient } = require("./db/postgres")
const { RedisClient: RealRedisClient } = require("./db/redis")
const { AuditLog, OrderEventLog } = require("./audit")
const { MetricsService } = require("./metrics/metrics-service")

class Application {

    async run() {

        const env = EnvUtils.getInstance('.env')

        const os = require('os')
        const hostname = os.hostname()
        env['PID'] = `${hostname}:${process.pid}`
        env['VERSION'] = '1.0.07.130'

        await AwsSecrets.loadSecretConfigs(env)

        ProxyUtil.initialize()

        const redisWebApi = new RedisClient()
        const redisWebApiEndpoint = env['REDIS_WEBAPI_ENDPOINT']
        await redisWebApi.initialize(redisWebApiEndpoint)
        EnvUtils.setInstance('redisWebApi', redisWebApi)

        const redisOrderStorage = new RedisClient()
        const redisOrderStorageEndpoint = env['REDIS_ORDER_STORAGE_ENDPOINT']
        await redisOrderStorage.initialize(redisOrderStorageEndpoint)
        EnvUtils.setInstance('redisOrderStorage', redisOrderStorage)

        const redisMarketData = new RedisClient()
        const redisMarketDataEndpoint = env['REDIS_MARKET_DATA_ENDPOINT']
        await redisMarketData.initialize(redisMarketDataEndpoint)
        EnvUtils.setInstance('redisMarketData', redisMarketData)

        const dbOrderStorage = new DbClient()
        const dbOrderStorageConnection = env['DB_ORDER_STORAGE_CONNECTION']
        await dbOrderStorage.initialize(dbOrderStorageConnection)
        EnvUtils.setInstance('dbOrderStorage', dbOrderStorage)

        const subscriptionService = new SubscriptionService()
        await subscriptionService.initialize()
        EnvUtils.setInstance('subscriptionService', subscriptionService)

        const httpServer = new HttpServer()
        await httpServer.initialize('connection:http')
        EnvUtils.setInstance('httpServer', httpServer)

        // const wsServer = new WsServer()
        // await wsServer.initialize()
        // EnvUtils.setInstance('wsServer', wsServer)

        // const streamServer = new StreamServer()
        // await streamServer.initialize()
        // EnvUtils.setInstance('streamServer', streamServer)

        const accountService = new AccountService()
        EnvUtils.setInstance('accountService', accountService)

        const alertService = new AlertService()
        EnvUtils.setInstance('alertService', alertService)

        const orderService = new OrderService()
        EnvUtils.setInstance('orderService', orderService)

        const marketDataService = new MarketDataService()
        await marketDataService.initialize()
        EnvUtils.setInstance('marketDataService', marketDataService)

        const positionService = new PositionService()
        EnvUtils.setInstance('positionService', positionService)

        const { LlmService } = env['LLM_ENDPOINT'] ? require('./llm-service') : require('./mock/llm-service')
        const llmService = new LlmService()
        EnvUtils.setInstance('llmService', llmService)

        const portfolioRecommender = new PortfolioRecommender()
        await portfolioRecommender.initialize()
        EnvUtils.setInstance('portfolioRecommender', portfolioRecommender)

        const runtime = new AgentRuntime()
        await runtime.initialize('trader-agent')
        EnvUtils.setInstance('runtime', runtime)

        // (Sem roteador de intenções: agente único trader — todos os comandos do
        // agente vão ao prompt da LLM, sem pré-filtro.)

        // Registro de conversas (config durável: versão + agentes + dono) + KPIs.
        // WRITE-THROUGH: Postgres (fonte da verdade, auditável) + Redis (cache quente).
        // Usa clientes REAIS quando o .env define DB_CONVERSATION_CONNECTION /
        // REDIS_CONVERSATION_ENDPOINT; senão, cai nos mocks in-memory. Os stores não
        // mudam — só o cliente injetado.
        const dbConn = env['DB_CONVERSATION_CONNECTION']
        const redisUrl = env['REDIS_CONVERSATION_ENDPOINT']

        // O schema (DDL) NÃO é criado aqui — vive em chat/schema.sql, aplicado fora da
        // aplicação (docker-compose init do Postgres ou psql -f). A app só faz DML.
        const pgConversations = dbConn ? new PostgresClient() : new PgClient()
        await pgConversations.initialize(dbConn)
        const durableStore = new PgConversationStore(pgConversations)

        const redisConversations = redisUrl ? new RealRedisClient() : new RedisClient()
        await redisConversations.initialize(redisUrl)
        const cacheStore = new RedisConversationStore(redisConversations)

        const conversationStore = new WriteThroughStore({ durable: durableStore, cache: cacheStore })
        const availableAgents = [...new Set(runtime.commandElements.map(c => c.agent))].filter(a => a && a !== 'system')
        const promptVersions = runtime._promptVersions || []
        const defaultVersion = promptVersions[promptVersions.length - 1]
        const conversationService = new ConversationService({ store: conversationStore, availableAgents, defaultVersion })
        EnvUtils.setInstance('conversationService', conversationService)
        EnvUtils.setInstance('conversationPg', pgConversations)
        console.log(`[Conversation] registro pronto (${dbConn ? 'Postgres REAL' : 'pg-mock'} + ${redisUrl ? 'Redis REAL' : 'redis-mock'} write-through) — agentes: ${availableAgents.join('/')} · versão padrão: ${defaultVersion}`)

        // Log de auditoria/KPIs (append-only): turns / command_executions / llm_calls.
        // Reusa o mesmo Postgres. O runtime grava 1 turno por mensagem, best-effort
        // (nunca quebra o chat). Tabelas: chat/schema.sql. (Sem router: nada de routing_*.)
        const auditLog = new AuditLog(pgConversations)
        EnvUtils.setInstance('auditLog', auditLog)
        console.log(`[Audit] log de KPIs pronto (turns/command_executions/llm_calls)`)

        // Eventos de ORDEM (externos): ORDER_SENT / ORDER_CANCELED chegam do backend
        // de ordens por POST /api/trader-chat/event e vão para order_events — a fonte
        // da verdade dos KPIs de execução. Reusa o mesmo Postgres. Best-effort.
        const orderEventLog = new OrderEventLog(pgConversations)
        EnvUtils.setInstance('orderEventLog', orderEventLog)
        console.log(`[OrderEvents] captura pronta (order_events: ORDER_SENT/ORDER_CANCELED)`)

        // Métricas/KPIs sobre o Postgres (frio): 37 KPIs validados + auditoria de conversa.
        // Queries analíticas -> exigem o Postgres REAL (degradam best-effort no mock). Só-leitura.
        const metricsService = new MetricsService(pgConversations)
        EnvUtils.setInstance('metricsService', metricsService)
        console.log(`[Metrics] painel de KPIs pronto (${require('./metrics/catalog').CATALOG.kpis.length} KPIs · GET /api/trader-chat/metrics)`)

        httpServer.use((req, res, next) => {
            req.ack(30_000)
            next()
        })

        httpServer.on('GET:/trader-chat', this.onRequestGetChatHtml.bind(this))

        httpServer.on('api/trader-chat/info', this.onRequestGetInfo.bind(this))

        // Conversa como recurso: create/get/delete. GET e DELETE leem o id do header
        // `conversation-id` (o http-server casa path exato, sem path params).
        httpServer.on('POST:/api/trader-chat/conversation', this.onRequestCreateConversation.bind(this))
        httpServer.on('GET:/api/trader-chat/conversation', this.onRequestGetConversation.bind(this))
        httpServer.on('DELETE:/api/trader-chat/conversation', this.onRequestDeleteConversation.bind(this))

        httpServer.on('POST:/api/trader-chat', this.onRequestPostMessage.bind(this))
        httpServer.on('GET:/api/trader-chat', this.onRequestGetMessage.bind(this))
        httpServer.on('DELETE:/api/trader-chat', this.onRequestDeleteContext.bind(this))
        httpServer.on('GET:/api/trader-chat/history', this.onRequestGetHistory.bind(this))
        httpServer.on('GET:/api/trader-chat/data', this.onRequestGetData.bind(this))

        // Evento EXTERNO de execução (ordem enviada/cancelada) — do backend de ordens.
        httpServer.on('POST:/api/trader-chat/event', this.onRequestPostOrderEvent.bind(this))

        // Painel de KPIs (aba Métricas do chat.html): tudo GET, só-leitura do Postgres.
        httpServer.on('GET:/api/trader-chat/metrics', this.onRequestGetMetrics.bind(this))
        httpServer.on('GET:/api/trader-chat/metrics/conversations', this.onRequestGetMetricsConversations.bind(this))
        httpServer.on('GET:/api/trader-chat/metrics/conversation', this.onRequestGetMetricsConversation.bind(this))
        httpServer.on('GET:/api/trader-chat/metrics/conversation/export', this.onRequestGetMetricsConversationExport.bind(this))

        httpServer.on('GET:/api/trader-chat/portfolio-recommendation', this.onRequestGetPortfolioRecommendation.bind(this))
        httpServer.on('GET:/api/trader-chat/portfolio-analysis', this.onRequestGetPortfolioAnalysis.bind(this))
        httpServer.on('GET:/api/trader-chat/portfolio-analysis/summary', this.onRequestGetPortfolioAnalysisSummary.bind(this))
        httpServer.on('GET:/api/trader-chat/lending-rate', this.onRequestGetLendingRate.bind(this))
    }

    async getContextId(req) {

        let contextId = req.headers?.['context-id']

        let account = req.headers?.['x-efs-account']
        let userProfileId = req.headers?.['x-efs-user-profile-id']
        let chatId = req.headers?.['x-chat-id']
        let version = req.headers?.['x-version']

        if (account) {
            contextId = `digital:${account}`
        } else if (userProfileId) {
            contextId = `admin:${userProfileId}`
        }

        if (chatId && (account || userProfileId)) {
            contextId = `${contextId}:${chatId}`
        }

        // segmento de versão (isolamento por versão) — só quando semver válido; inválido/ausente => latest
        if (contextId && Utils.isValidVersion(version)) {
            contextId = `${contextId}:v=${version.trim()}`
        }

        return contextId
    }

    /** Identidade autenticada a partir dos headers. Lança 400 se ausente. */
    _authIdentity(req) {
        const account = req.headers?.['x-efs-account']
        const userProfileId = req.headers?.['x-efs-user-profile-id']
        if (account) return { mode: 'digital', account }
        if (userProfileId) return { mode: 'admin', userProfileId }
        const { HttpError } = require('./conversation')
        throw new HttpError(400, 'identidade ausente: informe x-efs-account ou x-efs-user-profile-id')
    }

    /** Converte um HttpError (ou erro qualquer) no envelope de status do http-server. */
    _toHttpError(err) {
        const status = err && err.httpStatus ? err.httpStatus : 500
        return { type: 'http', status, body: { error: (err && err.message) || 'internal error' } }
    }

    /**
     * Resolve o contexto de um request de chat. Com header `conversation-id`, busca
     * o registro (com authz do dono) e devolve { contextId, conversationConfig }.
     * Sem ele, cai no `getContextId` de compatibilidade (conversationConfig null).
     * Lança HttpError quando o conversation-id é inválido/expirado/sem acesso.
     */
    async resolveRequestContext(req) {
        const conversationId = req.headers?.['conversation-id']
        if (conversationId) {
            const svc = EnvUtils.getInstance('conversationService')
            const record = await svc.resolve(conversationId, this._authIdentity(req))
            return { contextId: record.id, conversationConfig: record }
        }
        const contextId = await this.getContextId(req)
        return { contextId, conversationConfig: null }
    }

    async onRequestCreateConversation(req) {
        try {
            const svc = EnvUtils.getInstance('conversationService')
            const owner = this._authIdentity(req)
            const record = await svc.create({
                version: req.data?.version,
                agents: req.data?.agents,
                owner
            })
            return {
                type: 'http',
                status: 201,
                body: {
                    conversationId: record.id,
                    version: record.version,
                    agents: record.agents,
                    expiresAt: record.expiresAt
                }
            }
        } catch (err) {
            return this._toHttpError(err)
        }
    }

    async onRequestGetConversation(req) {
        try {
            const svc = EnvUtils.getInstance('conversationService')
            const id = req.headers?.['conversation-id'] || req.data?.id
            const record = await svc.resolve(id, this._authIdentity(req))
            return {
                conversationId: record.id,
                version: record.version,
                agents: record.agents,
                owner: record.owner,
                status: record.status,
                createdAt: record.createdAt,
                expiresAt: record.expiresAt
            }
        } catch (err) {
            return this._toHttpError(err)
        }
    }

    async onRequestDeleteConversation(req) {
        try {
            const svc = EnvUtils.getInstance('conversationService')
            const runtime = EnvUtils.getInstance('runtime')
            const id = req.headers?.['conversation-id'] || req.data?.id
            const record = await svc.resolve(id, this._authIdentity(req))
            await runtime.reset(record.id)
            await svc.close(record.id)
            return { status: 'ok' }
        } catch (err) {
            return this._toHttpError(err)
        }
    }

    /**
     * Recebe um evento EXTERNO de execução de ordem (do backend de ordens):
     * ORDER_SENT / ORDER_CANCELED. Grava em `order_events` (KPIs de execução) e
     * dispara o `sendEvent` do agente (invalidação do cache de ordens) nos contextos
     * ativos da conta — fire-and-forget (onEventOrderSent tem sleep de 5s). Best-effort.
     * Payload (JSON): { eventType, account, orderId?, symbol?, side?, quantity?, price?,
     * reason? (só ORDER_CANCELED), conversationId?, contextId?, timestamp? }.
     */
    async onRequestPostOrderEvent(req) {
        try {
            const d = req.data || {}
            const eventType = String(d.eventType || '').toUpperCase()
            if (eventType !== 'ORDER_SENT' && eventType !== 'ORDER_CANCELED') {
                return { type: 'http', status: 400, body: { error: 'eventType inválido: use ORDER_SENT ou ORDER_CANCELED' } }
            }
            if (!d.account) {
                return { type: 'http', status: 400, body: { error: 'account é obrigatório' } }
            }

            const orderEventLog = EnvUtils.getInstance('orderEventLog')
            const id = await orderEventLog.record({
                eventType,
                account: d.account,
                orderId: d.orderId,
                symbol: d.symbol,
                side: d.side,
                quantity: d.quantity,
                price: d.price,
                reason: eventType === 'ORDER_CANCELED' ? (d.reason ?? null) : null, // motivo só faz sentido no cancelamento
                conversationId: d.conversationId,
                contextId: d.contextId,
                timestamp: d.timestamp,
            })

            // Invalidação de cache de ordens nos contextos ativos da conta (comportamento
            // original do sendEvent), fire-and-forget para não bloquear na resposta.
            const runtime = EnvUtils.getInstance('runtime')
            runtime.dispatchAccountEvent?.(d.account, eventType)

            return { type: 'http', status: 201, body: { status: 'ok', id, eventType, account: d.account } }
        } catch (err) {
            return this._toHttpError(err)
        }
    }

    /** Painel de KPIs: roda os 37 KPIs do catálogo e devolve os valores computados. */
    async onRequestGetMetrics(req) {
        try { return await EnvUtils.getInstance('metricsService').all(req.data?.period) }
        catch (err) { return this._toHttpError(err) }
    }

    /** Lista de conversas para o seletor de auditoria. */
    async onRequestGetMetricsConversations(req) {
        try { return await EnvUtils.getInstance('metricsService').listConversations() }
        catch (err) { return this._toHttpError(err) }
    }

    /** Reconstrói UMA conversa por inteiro para auditoria. id via ?id= ou header conversation-id. */
    async onRequestGetMetricsConversation(req) {
        try {
            const id = req.data?.id || req.headers?.['conversation-id']
            return await EnvUtils.getInstance('metricsService').reconstructConversation(id)
        } catch (err) { return this._toHttpError(err) }
    }

    /** Exporta UMA conversa em formato pronto para LLM-as-a-judge. id via ?id= ou header. */
    async onRequestGetMetricsConversationExport(req) {
        try {
            const id = req.data?.id || req.headers?.['conversation-id']
            return await EnvUtils.getInstance('metricsService').exportForJudge(id)
        } catch (err) { return this._toHttpError(err) }
    }

    onRequestGetChatHtml(req) {
        // chat.html = o front REAL de produção (2 chats lado a lado) já com as abas
        // Conversas + Métricas integradas. chat-true.html é a variante anterior.
        const file = path.join(__dirname, 'mock', 'chat.html')
        return {
            type: 'file',
            contentType: 'text/html; charset=utf-8',
            stream: fs.createReadStream(file)
        }
    }

    onRequestGetInfo(req) {

        const env = EnvUtils.getInstance('.env')

        return {
            time: new Date().toISOString(),
            timeLocal: DateUtils.toLocalISOString(new Date()),
            env: env['ENV'],
            pid: env['PID'],
            version: env['VERSION'],
        }
    }

    async onRequestPostMessage(req) {

        const runtime = EnvUtils.getInstance('runtime')

        let resolved
        try { resolved = await this.resolveRequestContext(req) }
        catch (err) { return this._toHttpError(err) }
        const { contextId, conversationConfig } = resolved

        const commands = req.data.commands

        let content = req.data.content || req.data.message || req.data.messages
        if (!content && req.data instanceof Array) {
            content = req.data
        }

        if (content instanceof Array) {
            let messages = []
            for (let item of content) {
                if (item?.role == 'agent') {
                    continue
                }
                if (item.content) {
                    messages.push(item.content)
                } else if (typeof item == 'string') {
                    messages.push(item)
                }
            }
            messages = messages.join(';')
            content = messages
        } else if (content?.content) {
            content = content.content
        }

        // Pré-cria o contexto com a config da conversa (aplicada só na criação);
        // send() reusa o contexto cacheado. No caminho de compat, conversationConfig é null.
        await runtime.getContext(contextId, true, conversationConfig)
        const msg = await runtime.send(contextId, content, commands)

        return msg
    }

    async onRequestGetMessage(req) {

        const runtime = EnvUtils.getInstance('runtime')

        let resolved
        try { resolved = await this.resolveRequestContext(req) }
        catch (err) { return this._toHttpError(err) }

        let msg = await runtime.receive(resolved.contextId, 30_000)

        return msg
    }

    async onRequestDeleteContext(req) {

        const runtime = EnvUtils.getInstance('runtime')

        let resolved
        try { resolved = await this.resolveRequestContext(req) }
        catch (err) { return this._toHttpError(err) }

        await runtime.reset(resolved.contextId)

        return { status: 'ok' }
    }

    async onRequestGetHistory(req) {

        const runtime = EnvUtils.getInstance('runtime')

        let resolved
        try { resolved = await this.resolveRequestContext(req) }
        catch (err) { return this._toHttpError(err) }

        const audit = req.data?.audit === 'true'
        const count = req.data?.count ? parseInt(req.data.count) : undefined
        const role = req.data?.role

        return runtime.getMessages(resolved.contextId, { role, count, audit })
    }

    async onRequestGetData(req) {

        const runtime = EnvUtils.getInstance('runtime')

        let resolved
        try { resolved = await this.resolveRequestContext(req) }
        catch (err) { return this._toHttpError(err) }

        return runtime.getData(resolved.contextId)
    }

    async onRequestGetPortfolioRecommendation(req) {

        const account = req.headers?.['x-efs-account'] || req.data?.account

        const portfolioRecommender = EnvUtils.getInstance('portfolioRecommender')

        return await portfolioRecommender.getPortfolioRecommendation(account)
    }

    async onRequestGetPortfolioAnalysis(req) {

        const account = req.headers?.['x-efs-account'] || req.data?.account

        const portfolioRecommender = EnvUtils.getInstance('portfolioRecommender')

        return await portfolioRecommender.getPortfolioAnalysis(account)
    }

    async onRequestGetPortfolioAnalysisSummary(req) {

        const account = req.headers?.['x-efs-account'] || req.data?.account

        const portfolioRecommender = EnvUtils.getInstance('portfolioRecommender')

        return await portfolioRecommender.getPortfolioAnalysisSummary(account)
    }

    async onRequestGetLendingRate(req) {

        const symbol = req.data?.symbol

        const marketDataService = EnvUtils.getInstance('marketDataService')

        return await marketDataService.getLendingRates(symbol)
    }
}

module.exports = { Application }