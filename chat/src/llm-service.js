const { HttpUtils, EnvUtils } = require("./utils")

class LlmService {
    
    constructor() {

        const env = EnvUtils.getInstance('.env')
        this.endpoint = env['LLM_ENDPOINT']
        this.token = env['LLM_TOKEN']
        this.model = env['LLM_MODEL'] || 'gpt-5-mini'
        this.temperature = parseFloat(env['LLM_TEMPERATURE'] || 0.5)

        this.headers = {
            'authorization': `Bearer ${this.token}`
        }
    }

    async execute(prompt, model, temperature) {

        if (!model) {
            model = this.model
        }

        const modelLower = model?.toLowerCase()
        if (modelLower == 'json' || modelLower == 'mini') {
            model = 'gpt-5.4-mini'
        } else if (modelLower == 'text' || modelLower == 'nano') {
            model = 'gpt-5.4-nano'
        }

        if (!temperature) {
            temperature = this.temperature
        }

        const headers = {
            authorization: `Bearer ${this.token}`
        }
    
        const data = {
            model,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature,
        }
        
        let res = await HttpUtils.sendPostRequest(`${this.endpoint}/openai/v1/chat/completions`, data, this.headers)
        res = JSON.parse(res)
        
        res = res.choices?.[0]?.message?.content
    
        let obj = LlmService.extractJsonObject(res)
        if (obj) {
            res = obj
        }
        
        return res
    }
    
    static extractJsonObject(text) {
        let match = text.match(/```json\s*([\s\S]*?)\s*```/i)
        if (match) {
            text = match[1]
        }
    
        if (/(\{[\s\S]*\}|\[[\s\S]*\])/.test(text)) {
            try { return JSON.parse(text) }
            catch (e) { return undefined }
        }
    
        return undefined
    } 
}

module.exports = { LlmService }