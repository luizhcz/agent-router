const fs = require('fs')

const clients = {
    'http': require('http'),
    'https': require('https')
}

class Utils {

    static topicHandlers = {}

    static wait(topic, timeout) {

        return new Promise((resolve) => {

            let timeoutId = undefined
            const handler = (topic, data) => {

                if (!data) {
                    this.unsubscribe(topic, handler)
                }

                if (timeoutId > 0) {
                    clearTimeout(timeoutId)
                }
                timeoutId = -1

                if (resolve) {
                    resolve(data)
                }
                resolve = undefined
            }

            this.subscribe(topic, handler, 1)

            if (timeout !== undefined) {
                timeoutId = setTimeout(handler, timeout, topic, false)
            }
        })
    }

    static subscribe(topic, handler, count) {

        let handlers = Utils.topicHandlers[topic]
        if (!handlers) {
            handlers = []
            Utils.topicHandlers[topic] = handlers
        }

        const index = handlers.indexOf(handler)
        if (index > -1) {
            return
        }

        handlers.push(handler)
        if (count !== undefined) {
            handler.count = count
        }
    }

    static unsubscribe(topic, handler) {

        let handlers = Utils.topicHandlers[topic]
        if (!handlers) {
            return
        }

        if (handler) {
            const index = handlers.indexOf(handler)
            if (index == -1) {
                return
            }
            handlers.splice(index, 1)
        }

        if (!handler || handlers.length == 0) {
            delete Utils.topicHandlers[topic]
        }
    }

    static set(topic) {
        Utils.publish(topic, true)
    }

    static publish(topic, data) {

        let handlers = Utils.topicHandlers[topic]
        if (!handlers) {
            return
        }

        for (let handler of handlers) {
            try {
                handler(topic, data)
                if (handler.count !== undefined) {
                    handler.count--
                    if (handler.count <= 0) {
                        Utils.unsubscribe(topic, handler)
                    }
                }
            }
            catch { }
        }
    }

    static sleep(timeout) {
        return new Promise((resolve) => {
            setTimeout(resolve, timeout)
        })
    }

    static signal(reset = false) {

        const signal = {
            value: undefined,
            reset
        }

        signal.wait = (timeout, callback) => {

            if (signal.value !== undefined) {
                return signal.value
            }

            signal.timeout = setTimeout(signal.set, timeout, false)

            if (callback) {
                signal.callback = callback
                return
            }

            return new Promise((resolve) => {
                signal.callback = resolve
            })
        }

        signal.set = (value) => {

            if (signal.timeout) {
                clearTimeout(signal.timeout)
                signal.timeout = undefined
            }

            if (signal.callback) {
                signal.callback(value)
                signal.callback = undefined
            }

            if (reset) {
                signal.value = undefined
            } else {
                signal.value = value
            }

            return true
        }

        return signal
    }

    static getRandomToken(length) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789wz'
        let token = ''
        let tok = 0
        while (token.length < length) {
            if (tok == 0) {
                tok = Math.floor(100000000 + Math.random() * 899999999)
            }
            const c = tok % 64
            token += chars[c]
            tok -= c
            tok /= 64
        }
        return token
    }

    static parseTokens(input) {

        let tokens = []

        if (!(input instanceof Array)) {
            input = [input]
        }

        for (let text of input) {

            let escape = undefined
            let quote = undefined
            let tok = ''

            for (let i = 0; i < text.length; i++) {

                if (quote) {
                    if (escape) {
                        tok += text[i]
                        escape = false
                    } else if (text[i] == '\\') {
                        escape = true
                    } else if (text[i] == quote) {
                        quote = undefined
                        tokens.push(tok)
                        tok = ''
                    } else {
                        tok += text[i]
                    }
                } else if (text[i] == '\'' || text[i] == '"') {
                    quote = text[i]
                } else if (/\s/.test(text[i])) {
                    if (tok.length > 0) {
                        tokens.push(tok)
                    }
                    tok = ''
                } else {
                    tok += text[i]
                }
            }

            if (tok.length > 0) {
                tokens.push(tok)
            }
        }

        return tokens
    }

    static isValidVersion(str) {
        return typeof str === 'string' && /^\d+(\.\d+){1,3}$/.test(str.trim())
    }

    static parseVersion(str) {
        if (typeof str !== 'string') return null
        const parts = str.trim().split('.').map(n => parseInt(n, 10))
        if (!parts.length || parts.some(n => Number.isNaN(n))) return null
        return parts
    }

    // -1 se a < b ; 0 se iguais ; 1 se a > b (segmentos ausentes contam como 0)
    static compareVersions(a, b) {
        const pa = Utils.parseVersion(a) || []
        const pb = Utils.parseVersion(b) || []
        const len = Math.max(pa.length, pb.length)
        for (let i = 0; i < len; i++) {
            const na = pa[i] ?? 0
            const nb = pb[i] ?? 0
            if (na > nb) return 1
            if (na < nb) return -1
        }
        return 0
    }
}

class HttpUtils {

    static async sendGetRequest(url, headers, data) {

        if (!url) {
            return null
        }

        url = url.trim()

        let protocol = undefined
        let host = undefined
        let port = undefined

        let index = url.indexOf('://')
        if (index > -1) {
            protocol = url.substr(0, index).toLowerCase()
            url = url.substr(index + 3)
        }

        index = url.indexOf('/')
        if (index > -1) {
            host = url.substr(0, index).toLowerCase()
            url = url.substr(index)
        }

        index = host.indexOf(':')
        if (index > -1) {
            port = parseInt(host.substr(index + 1))
            host = host.substr(0, index)
        }

        if (!protocol) {
            protocol = 'http'
        }

        let client = clients[protocol]
        if (!client) {
            throw new Error('Invalid Protocol')
        }

        if (!host) {
            host = '127.0.0.1'
        }

        if (!url) {
            url = '/'
        }

        let promise = new Promise((resolve, reject) => {

            let req = {
                host: host,
                path: url,
                method: 'GET'
            }

            if (headers) {
                req.headers = headers
            }

            if (data) {
                data = JSON.stringify(data)
                if (!req.headers) {
                    req.headers = {}
                }
                req.headers['Content-Type'] = 'application/json'
                req.headers['Content-Length'] = data.length
            }

            if (port) {
                req.port = port
            }

            req = client.request(req, (res) => {

                let data = ''

                res.on('data', (d) => {
                    data += d
                })

                res.on('end', () => {
                    resolve(data)
                })
            })

            req.on('error', (err) => {
                reject(err)
            })

            if (data) {
                req.write(data)
            }

            req.end()
        })

        return promise
    }

    static async sendPostRequest(url, data, headers) {

        if (!url) {
            return null
        }

        url = url.trim()

        let protocol = undefined
        let host = undefined
        let port = undefined

        let index = url.indexOf('://')
        if (index > -1) {
            protocol = url.substr(0, index).toLowerCase()
            url = url.substr(index + 3)
        }

        index = url.indexOf('/')
        if (index > -1) {
            host = url.substr(0, index).toLowerCase()
            url = url.substr(index)
        }

        index = host.indexOf(':')
        if (index > -1) {
            port = parseInt(host.substr(index + 1))
            host = host.substr(0, index)
        }

        if (!protocol) {
            protocol = 'http'
        }

        let client = clients[protocol]
        if (!client) {
            throw new Error('Invalid Protocol')
        }

        if (!host) {
            host = '127.0.0.1'
        }

        if (!url) {
            url = '/'
        }

        let method = 'POST'
        if (headers?.['x-http-method']?.toUpperCase() == 'PUT') {
            delete headers['x-http-method']
            method = 'PUT'
        }

        let promise = new Promise((resolve, reject) => {

            let req = {
                host: host,
                path: url,
                method
            }

            if (headers) {
                req.headers = headers
            }

            if (data) {
                data = JSON.stringify(data)
                if (!req.headers) {
                    req.headers = {}
                }
                req.headers['Content-Type'] = 'application/json'
                //req.headers['Content-Length'] = data.length
            }

            if (port) {
                req.port = port
            }

            req = client.request(req, (res) => {

                let data = ''

                res.on('data', (d) => {
                    data += d
                })

                res.on('end', () => {
                    resolve(data)
                })
            })

            req.on('error', (err) => {
                reject(err)
            })

            if (data) {
                req.write(data)
            }

            req.end()
        })

        return promise
    }

    static async sendDeleteRequest(url, data, headers) {

        if (!url) {
            return null
        }

        url = url.trim()

        let protocol = undefined
        let host = undefined
        let port = undefined

        let index = url.indexOf('://')
        if (index > -1) {
            protocol = url.substr(0, index).toLowerCase()
            url = url.substr(index + 3)
        }

        index = url.indexOf('/')
        if (index > -1) {
            host = url.substr(0, index).toLowerCase()
            url = url.substr(index)
        }

        index = host.indexOf(':')
        if (index > -1) {
            port = parseInt(host.substr(index + 1))
            host = host.substr(0, index)
        }

        if (!protocol) {
            protocol = 'http'
        }

        let client = clients[protocol]
        if (!client) {
            throw new Error('Invalid Protocol')
        }

        if (!host) {
            host = '127.0.0.1'
        }

        if (!url) {
            url = '/'
        }

        let promise = new Promise((resolve, reject) => {

            let req = {
                host: host,
                path: url,
                method: 'DELETE'
            }

            if (headers) {
                req.headers = headers
            }

            if (data) {
                data = JSON.stringify(data)
                if (!req.headers) {
                    req.headers = {}
                }
                req.headers['Content-Type'] = 'application/json'
                //req.headers['Content-Length'] = data.length
            }

            if (port) {
                req.port = port
            }

            req = client.request(req, (res) => {

                let data = ''

                res.on('data', (d) => {
                    data += d
                })

                res.on('end', () => {
                    resolve(data)
                })
            })

            req.on('error', (err) => {
                reject(err)
            })

            if (data) {
                req.write(data)
            }

            req.end()
        })

        return promise
    }

    static async sendProxyRequest(url, method, headers, data, res) {

        if (!url) {
            return null
        }

        url = url.trim()

        let protocol = undefined
        let host = undefined
        let port = undefined

        let index = url.indexOf('://')
        if (index > -1) {
            protocol = url.substr(0, index).toLowerCase()
            url = url.substr(index + 3)
        }

        index = url.indexOf('/')
        if (index > -1) {
            host = url.substr(0, index).toLowerCase()
            url = url.substr(index)
        }

        index = host.indexOf(':')
        if (index > -1) {
            port = parseInt(host.substr(index + 1))
            host = host.substr(0, index)
        }

        if (!protocol) {
            protocol = 'http'
        }

        let client = clients[protocol]
        if (!client) {
            throw new Error('Invalid Protocol')
        }

        if (!host) {
            host = '127.0.0.1'
        }

        if (!url) {
            url = '/'
        }

        let promise = new Promise((resolve, reject) => {

            let req = {
                host: host,
                path: url,
                method: method,
            }

            if (headers) {
                req.headers = headers
            }

            if (data) {
                data = JSON.stringify(data)
                if (!req.headers) {
                    req.headers = {}
                }
                req.headers['Content-Type'] = 'application/json'
                req.headers['Content-Length'] = data.length
            }

            if (port) {
                req.port = port
            }

            req = client.request(req, (pres) => {

                res.statusCode = pres.statusCode
                for (let [key, value] of Object.entries(pres.headers)) {
                    res.setHeader(key, value)
                }

                pres.on('data', (d) => {
                    res.write(d)
                })

                pres.on('end', () => {
                    res.end()
                    resolve(true)
                })
            })

            req.on('error', (err) => {
                reject(err)
            })

            if (data) {
                req.write(data)
            }

            req.end()
        })

        return promise
    }
}

class EnvUtils {
    static instances = {}

    static getInstance(key) {
        return EnvUtils.instances[key]
    }

    static setInstance(key, instance) {
        EnvUtils.instances[key] = instance
        return instance
    }

    static initializeEnv(filename) {

        if (!filename) {
            filename = '.env'
        }

        let env = EnvUtils.getInstance(filename)
        if (env) {
            return env
        }

        if (fs.existsSync(filename)) {
            env = fs.readFileSync(filename).toString().trim()
            env = env.split('\n').map(o => o.split('='))

            if (process.argv.length > 2) {

                let key = undefined

                for (let i = 2; i < process.argv.length; i++) {
                    const arg = process.argv[i]
                    if (key && arg[0] != '-') {
                        env.push([key, arg])
                        key = undefined
                    }
                    else {
                        const match = /^-*(.+)=(.+)$/.exec(arg)
                        if (match) {
                            const [_, key, value] = match
                            env.push([key, value])
                        } else if (arg.startsWith('-')) {
                            if (key) {
                                env.push([key, 'true'])
                            }
                            key = arg.replace(/^\-+/g, '')
                        }
                    }
                }
            }

            for (let [key, value] of env) {
                // pula linhas em branco / sem '=' (value undefined) e comentários
                if (value === undefined || key[0] == '#') {
                    continue
                }
                key = key.trim()
                value = value.trim()
                if (!key) {
                    continue
                }
                process.env[key] = value
            }
        }

        return EnvUtils.setInstance(filename, process.env)
    }
}

class DataUtils {

    static parsePaging(data) {

        let isPageMode = data.pageCount !== undefined || data.pageOffset !== undefined

        if (data.pageCount === undefined && data.count !== undefined) {
            data.pageCount = data.count
        }

        if (data.count === undefined && data.pageCount !== undefined) {
            data.count = data.pageCount
        }

        const paging = {
            count: undefined,
            offset: undefined,
            pageCount: undefined,
            pageOffset: undefined,
            includeHeaders: true
        }

        if (isPageMode && data.pageCount !== undefined) {
            if (data.pageOffset === undefined) {
                data.pageOffset = 0
            }
            paging.pageCount = parseInt(data.pageCount ?? 0)
            paging.pageOffset = parseInt(data.pageOffset ?? 0)
            paging.count = paging.pageCount
            paging.offset = paging.pageOffset * paging.pageCount
        } else if (data.count !== undefined) {
            if (data.offset === undefined) {
                data.offset = 0
            }
            paging.count = parseInt(data.count ?? 0)
            paging.offset = parseInt(data.offset ?? 0)
        } else {
            return null
        }

        if (data.includePagingHeaders !== undefined) {
            paging.includeHeaders = data.includePagingHeaders == 'true'
        }

        return paging
    }

    static parseOrderBy(orderBy) {

        if (!orderBy) {
            return undefined
        }

        let orderByLower = orderBy.toLowerCase()

        orderBy = { field: orderBy, isDescending: false }

        if (orderByLower.endsWith('desc')) {
            orderBy.field = orderBy.field.substr(0, orderBy.field.length - 4)
            orderBy.isDescending = true
        } else if (orderByLower.endsWith('asc')) {
            orderBy.field = orderBy.field.substr(0, orderBy.field.length - 3)
            orderBy.isDescending = false
        }

        if (orderBy.field.endsWith('-')) {
            orderBy.field = orderBy.field.substr(0, orderBy.field.length - 1)
        }

        return orderBy
    }

    static parseFormat(data, requiredFields) {

        let format = data.format
        if (!format) {
            return undefined
        }

        if (typeof format == 'string') {
            format = format.split(',')
        }

        if (!(format instanceof Array)) {
            return undefined
        }

        let formatMap = {}
        for (let key of format) {
            formatMap[key.trim().toLowerCase()] = true
        }

        if (requiredFields) {
            for (let key of requiredFields) {
                formatMap[key.trim().toLowerCase()] = true
            }
        }

        return formatMap
    }

    static parseFilterTags(value) {

        if (!value) {
            return value
        }

        if (value.indexOf(',') == -1) {
            return value
        }

        value = value.split(',').map(o => o.trim())
        return value
    }

    static applyFormat(data, format) {

        if (!data) {
            return data
        }

        if (!format) {
            return data
        }

        let items = data
        if (data.items) {
            items = data.items
        }

        let singleItem = !(items instanceof Array)
        if (singleItem) {
            items = [items]
        }

        const formatCount = Object.entries(format).length

        for (let i = 0; i < items.length; i++) {
            let item = items[i]
            let nItem = {}
            let nItemCount = 0
            for (let [key, value] of Object.entries(item)) {
                if (!format[key.toLowerCase()]) {
                    continue
                }
                nItem[key] = value
                nItemCount++
                if (nItemCount == formatCount) {
                    break
                }
            }
            items[i] = nItem
        }

        if (singleItem) {
            return items[0]
        }

        return items
    }

    static applyFilter(data, filters) {

        if (!data) {
            return data
        }

        if (!filters) {
            return data
        }

        for (let [key, value] of Object.entries(filters)) {
            if (value === undefined) {
                continue
            }

            data = data.filter((o) => {

                let ovalue = o[key]
                if (typeof ovalue == 'function') {
                    ovalue = ovalue.call(o, o)
                }

                if (typeof value == 'function') {
                    return value.call(o, o)
                }

                return ovalue == value
            })
        }

        return data
    }

    static applyOrderBy(data, orderBy) {

        if (!data || !orderBy) {
            return data
        }

        const fields = Array.isArray(orderBy) ? orderBy : [orderBy]

        const comparators = fields.map((field) => {
            let isDescending = false
            if (field.endsWith('Desc')) {
                field = field.substr(0, field.length - 4)
                isDescending = true
            } else if (field.endsWith('Asc')) {
                field = field.substr(0, field.length - 3)
            }
            return { field, isDescending }
        })

        data = data.sort((a, b) => {
            for (const { field, isDescending } of comparators) {
                const diff = isDescending ? b[field] - a[field] : a[field] - b[field]
                if (diff !== 0) return diff
            }
            return 0
        })

        return data
    }

    static applyPaging(data, paging) {

        if (!data) {
            return data
        }

        if (!paging) {
            return data
        }

        if (!paging.totalCount) {
            paging.totalCount = data.totalCount ?? data.length
        }

        if (paging.offset && paging.offset <= 0) {
            paging.offset = 0
        }

        if (paging.count && paging.count <= 0) {
            paging.count = 0
        }

        const count = paging.count ?? 100
        const offset = paging.offset ?? 0

        data = data.slice(offset, offset + count)

        if (paging.includeHeaders) {
            data = {
                totalCount: paging.totalCount,
                count,
                offset,
                items: data
            }
        }

        return data
    }

    static applyPagingHeaders(data, paging) {

        if (!data) {
            return data
        }

        if (!paging) {
            return data
        }

        if (paging.totalCount === undefined) {
            paging.totalCount = data.length
        }

        if (paging.pageOffset !== undefined) {
            let totalPageCount = 0
            if (paging.totalCount > 0) {
                totalPageCount = Math.floor(paging.totalCount / paging.pageCount)
                if (paging.totalCount % paging.pageCount != 0) {
                    totalPageCount++
                }
            }

            return {
                pageOffset: paging.pageOffset,
                pageCount: paging.pageCount,
                totalPageCount,
                totalCount: paging.totalCount,
                items: data
            }
        }

        return {
            offset: paging.offset,
            count: paging.count,
            totalCount: paging.totalCount,
            items: data
        }
    }
}

class DateUtils {

    static toLocalISOString(date) {
        const pad = (n) => String(n).padStart(2, '0')
        const ms = String(date.getMilliseconds()).padStart(3, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${ms}`
    }
}

module.exports = { Utils, HttpUtils, EnvUtils, DataUtils, DateUtils }