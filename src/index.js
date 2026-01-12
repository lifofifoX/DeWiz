import 'dotenv/config'
import { startBot } from './bot/client.js'
import { initializeDatabase } from './database/index.js'
import { CONFIG } from './config/index.js'

async function main() {
  console.log('🧙 DegenWizard starting up...')

  console.log(`Bot name: ${CONFIG.discord.bot_name}`)

  initializeDatabase()

  await startBot()

  console.log('🧙 DegenWizard is ready!')
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
