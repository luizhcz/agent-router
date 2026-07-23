// MOCK — stand-in para OrderService real (etapa 1)

'use strict'

const data = require('./_data')

class OrderService {

    async getOpenOrder(account, orderId) {
        const byAccount = data.orders[account]
        if (!byAccount) return null
        const order = byAccount[orderId]
        if (!order) return null
        return { ...order }
    }

    async getOpenOrders(account) {
        const byAccount = data.orders[account]
        if (!byAccount) return []
        return Object.values(byAccount)
            .filter(o => (o.pendingQuantity || 0) > 0)
            .map(o => ({ ...o }))
    }
}

module.exports = { OrderService }
