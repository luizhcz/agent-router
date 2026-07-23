// Erro com status HTTP embutido. Os handlers convertem em { type:'http', status, body }.
class HttpError extends Error {
    constructor(httpStatus, message) {
        super(message)
        this.name = 'HttpError'
        this.httpStatus = httpStatus
    }
}

module.exports = { HttpError }
