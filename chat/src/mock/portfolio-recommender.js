// MOCK — stand-in para PortfolioRecommender real (etapa 1)

'use strict'

const data = require('./_data')

class PortfolioRecommender {

    async initialize() {
        // no-op async
    }

    async getPortfolioAnalysis(account) {
        const a = data.portfolioAnalysis[account]
        if (!a) return null
        return { ...a }
    }

    async getPortfolioAnalysisOverview(account) {
        const o = data.portfolioAnalysisOverview[account]
        if (!o) return null
        return {
            ...o,
            bySector: o.bySector.map(s => ({ ...s })),
            suggestions: [...o.suggestions],
        }
    }

    // usado por application.js (onRequestGetPortfolioAnalysisSummary)
    async getPortfolioAnalysisSummary(account) {
        return this.getPortfolioAnalysisOverview(account)
    }

    async getPortfolioRecommendation(account) {
        const rec = data.portfolioRecommendation[account]
        if (!rec) return []
        return rec.map(r => ({
            positionSymbol: (r.positionSymbol || '').toString().toUpperCase(),
        }))
    }

    async validatePortfolioRecommendation(symbolSell, symbolBuy) {
        const sym = (symbolSell || '').toString().toUpperCase()
        const sector = data.sectors[sym]
        if (!sector) return null
        return { sector }
    }
}

module.exports = { PortfolioRecommender }
