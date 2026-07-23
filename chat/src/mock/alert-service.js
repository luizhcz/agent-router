// MOCK — stand-in para AlertService real (etapa 1)

'use strict'

const data = require('./_data')

class AlertService {

    async getAlerts(account, options) {
        const list = data.alerts[account]
        if (!list) return []
        return list.map(a => ({
            symbol: a.symbol,
            account: a.account,
            conditions: [...a.conditions],
        }))
    }
}

module.exports = { AlertService }
