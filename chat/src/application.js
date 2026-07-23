const { AccountService } = require("./mock/account-service")
const { AlertService } = require("./mock/alert-service")
const { AgentRuntime } = require("./agent-runtime")
require("./agents")
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
const { ConversationStore, ConversationService } = require("./conversation")

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

        // Router de intenções (embeddings MiniLM offline): pré-filtra os comandos
        // tagueados (trader/content) a um top-8 antes da LLM. Depende dos
        // commandElements do runtime, por isso vem depois do initialize. Falha aqui
        // NÃO é fatal — o chat segue sem pré-filtro (todos os comandos vão à LLM).
        try {
            const { ChatIntentRouter } = require('./router')
            const intentRouter = new ChatIntentRouter({ topK: 8 })
            const info = await intentRouter.initialize(runtime.commandElements)
            EnvUtils.setInstance('intentRouter', intentRouter)
            console.log(`[Router] pronto — ${info.commands} comandos (${info.agents.join('/')}) → top-8 por consulta`)
        } catch (err) {
            console.error('[Router] indisponível, seguindo sem pré-filtro:', err.message)
        }

        // Registro de conversas (config durável: versão + agentes + dono). Store sobre
        // Redis (mock hoje). Agentes disponíveis e versão padrão vêm do runtime.
        const redisConversations = new RedisClient()
        await redisConversations.initialize(env['REDIS_CONVERSATION_ENDPOINT'])
        const conversationStore = new ConversationStore(redisConversations)
        const availableAgents = [...new Set(runtime.commandElements.map(c => c.agent))].filter(a => a && a !== 'system')
        const promptVersions = runtime._promptVersions || []
        const defaultVersion = promptVersions[promptVersions.length - 1]
        const conversationService = new ConversationService({ store: conversationStore, availableAgents, defaultVersion })
        EnvUtils.setInstance('conversationService', conversationService)
        console.log(`[Conversation] registro pronto — agentes: ${availableAgents.join('/')} · versão padrão: ${defaultVersion}`)

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

    onRequestGetChatHtml(req) {
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