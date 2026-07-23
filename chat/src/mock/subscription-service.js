// MOCK — stand-in para SubscriptionService (etapa 1)
// initialize/subscribe/publish/unsubscribe são no-op; os gates de assinatura
// resolvem true por padrão (tudo liberado). Não acessa rede/disco.

class SubscriptionService {

    async initialize() {
        // no-op: sem broker/conexão real
        return this
    }

    async subscribe() {
        // no-op
        return true
    }

    async unsubscribe() {
        // no-op
        return true
    }

    async publish() {
        // no-op
        return true
    }

    // --- gates de assinatura: liberados por padrão ---

    async isSubscribed() {
        return true
    }

    async hasSubscription() {
        return true
    }

    async checkSubscription() {
        return true
    }

    async isAllowed() {
        return true
    }

    async getSubscription() {
        return { active: true }
    }
}

module.exports = { SubscriptionService }
