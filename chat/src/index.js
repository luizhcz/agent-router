const path = require('path')

// Ensure relative '.env' (and any relative paths used downstream) resolve to src/
process.chdir(__dirname)

const { EnvUtils } = require('./utils')
const { Application } = require('./application')

async function main() {
    try {
        // application.js does EnvUtils.getInstance('.env') on line 26, which
        // requires the env to have been initialized under the '.env' key first.
        EnvUtils.initializeEnv('.env')

        await new Application().run()
    } catch (err) {
        console.error('Fatal error while starting application:', err)
        process.exit(1)
    }
}

main()
