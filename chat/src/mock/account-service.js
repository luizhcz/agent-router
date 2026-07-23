// MOCK — stand-in para AccountService real (etapa 1)

'use strict'

const data = require('./_data')

class AccountService {

    async getSessionAdmin(userProfileId) {
        return { accessToken: data.sessions.admin }
    }

    async getSessionDigital(account) {
        const token = data.sessions.digital[account]
        if (!token) return null
        return { accessToken: token }
    }

    async getAccount(accountId, options) {
        const acc = data.accounts[accountId]
        if (!acc) return null
        return {
            account: acc.account,
            document: acc.document,
            clientName: acc.clientName,
            institution: acc.institution,
            segment: acc.segment,
            suitability: acc.suitability,
            assignedDocuments: [...acc.assignedDocuments],
            isProfessional: acc.isProfessional,
            isQualified: acc.isQualified,
            address: acc.address,
        }
    }

    async findAccounts(search, options) {
        const term = (search || '').toString().trim().toLowerCase()
        const all = Object.values(data.accounts)
        const matched = term
            ? all.filter(a =>
                a.account.toLowerCase().includes(term) ||
                (a.clientName || '').toLowerCase().includes(term) ||
                (a.document || '').toLowerCase().includes(term))
            : all
        return matched.map(a => ({
            account: a.account,
            clientName: a.clientName,
            institution: a.institution,
            segment: a.segment,
        }))
    }
}

module.exports = { AccountService }
