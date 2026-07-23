// MOCK — stand-in para MarketDataService real (etapa 1)

'use strict'

const data = require('./_data')

class MarketDataService {

    async initialize() {
        // no-op async
    }

    async getSecurity(symbol) {
        const s = data.securities[(symbol || '').toString().toUpperCase()]
        if (!s) return null
        return {
            symbol: s.symbol,
            description: s.description,
            exchange: s.exchange,
            securityType: s.securityType,
            lot: s.lot,
            minPriceIncrement: s.minPriceIncrement,
            priceUnit: s.priceUnit,
        }
    }

    async findSecurities(symbol) {
        const term = (symbol || '').toString().trim().toUpperCase()
        if (!term) return []
        return Object.values(data.securities)
            .filter(s =>
                s.symbol.toUpperCase().includes(term) ||
                (s.description || '').toUpperCase().includes(term))
            .map(s => ({ symbol: s.symbol, description: s.description }))
    }

    async getQuote(symbol) {
        const q = data.quotes[(symbol || '').toString().toUpperCase()]
        if (!q) return null
        return {
            symbol: q.symbol,
            lastPrice: q.lastPrice,
            changePercent: q.changePercent,
            bidPrice: q.bidPrice,
            askPrice: q.askPrice,
        }
    }

    async getFundamentals(symbol) {
        const f = data.fundamentals[(symbol || '').toString().toUpperCase()]
        if (!f) return null
        return { ...f }
    }

    async getFundamentalsSummary(symbol) {
        const f = data.fundamentalsSummary[(symbol || '').toString().toUpperCase()]
        if (!f) return null
        return { ...f }
    }

    async getLendingRate(symbol) {
        const l = data.lendingRates[(symbol || '').toString().toUpperCase()]
        if (!l) return null
        return { fee: l.fee }
    }

    // alias plural — usado por application.js (onRequestGetLendingRate)
    async getLendingRates(symbol) {
        return this.getLendingRate(symbol)
    }

    async getSecuritiesSectors(symbols) {
        const list = Array.isArray(symbols) ? symbols : [symbols]
        const result = {}
        for (const raw of list) {
            const sym = (raw || '').toString().toUpperCase()
            const sector = data.sectors[sym]
            if (sector) {
                result[sym] = { sector }
            }
        }
        return result
    }

    async getRecommendationsRanked(sector) {
        const ranked = data.recommendations[sector]
        if (!ranked) return []
        return ranked.map(r => ({ ...r }))
    }

    async getTopPicks() {
        const out = {}
        for (const [ticker, v] of Object.entries(data.topPicks)) {
            out[ticker] = { ...v }
        }
        return out
    }

    async getIsTopPick(symbol) {
        return data.isTopPickMap[(symbol || '').toString().toUpperCase()] === true
    }
}

module.exports = { MarketDataService }
