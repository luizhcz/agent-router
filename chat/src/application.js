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

        httpServer.use((req, res, next) => {
            req.ack(30_000)
            next()
        })

        httpServer.on('GET:/trader-chat', this.onRequestGetChatHtml.bind(this))

        httpServer.on('api/trader-chat/info', this.onRequestGetInfo.bind(this))

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
        const contextId = await this.getContextId(req)

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

        const msg = await runtime.send(contextId, content, commands)

        return msg
    }

    async onRequestGetMessage(req) {

        const runtime = EnvUtils.getInstance('runtime')
        const contextId = await this.getContextId(req)

        let msg = await runtime.receive(contextId, 30_000)

        return msg
    }

    async onRequestDeleteContext(req) {

        const runtime = EnvUtils.getInstance('runtime')
        const contextId = await this.getContextId(req)

        await runtime.reset(contextId)

        return { status: 'ok' }
    }

    async onRequestGetHistory(req) {

        const runtime = EnvUtils.getInstance('runtime')
        const contextId = await this.getContextId(req)

        const audit = req.data?.audit === 'true'
        const count = req.data?.count ? parseInt(req.data.count) : undefined
        const role = req.data?.role

        return runtime.getMessages(contextId, { role, count, audit })
    }

    async onRequestGetData(req) {

        const runtime = EnvUtils.getInstance('runtime')
        const contextId = await this.getContextId(req)

        return runtime.getData(contextId)
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