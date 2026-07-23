// MOCK — stand-in para PositionService real (etapa 1)

'use strict'

const data = require('./_data')

class PositionService {

    async getPositions(account) {
        const bucket = data.positions[account]
        if (!bucket) return []
        return Object.values(bucket.list).map(p => ({
            symbol: p.symbol,
            totalQuantity: p.totalQuantity,
            volume: p.volume,
            profit: p.profit,
            profitPercent: p.profitPercent,
        }))
    }

    async getPosition(account, symbol) {
        const bucket = data.positions[account]
        if (!bucket) return null
        const p = bucket.list[(symbol || '').toString().toUpperCase()]
        if (!p) return null
        return { ...p }
    }

    async getFinancial(account) {
        const bucket = data.positions[account]
        if (!bucket) return null
        return { ...bucket.financial }
    }

    async getPositionSummary(account) {
        const bucket = data.positions[account]
        if (!bucket) return null
        return { ...bucket.summary }
    }
}

module.exports = { PositionService }
