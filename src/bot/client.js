import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
} from 'discord.js'
import { env, CONFIG } from '../config/index.js'
import { registerCommands, handleCommand } from './commands/index.js'
import { handleReaction } from './reactions.js'
import { initScheduler } from '../services/scheduler.js'
import { retryFailedSettlements } from '../services/payouts.js'

let client = null

export function getClient() {
  if (!client) {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [
        Partials.Message,
        Partials.Reaction,
        Partials.User,
      ],
    })

    setupEventHandlers(client)
  }
  return client
}

let tradingChannel = null

function setupEventHandlers(client) {
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`)
    await registerCommands()

    const channelId = CONFIG.discord.trading_channel_id

    if (!channelId) {
      throw new Error('Missing discord.trading_channel_id in config.yaml')
    }

    for (const guild of readyClient.guilds.cache.values()) {
      tradingChannel = guild.channels.cache.get(channelId)
      if (tradingChannel) break
    }

    if (!tradingChannel) {
      throw new Error(`Trading channel not found for configured id: ${channelId}`)
    }

    await initScheduler(readyClient, channelId)

    console.log('[STARTUP] Checking for incomplete settlements...')
    await retryFailedSettlements(tradingChannel)

    setInterval(async () => {
      try {
        await retryFailedSettlements(tradingChannel)
      } catch (error) {
        console.error('[PAYOUT RETRY] Error in periodic retry:', error)
      }
    }, 5 * 60 * 1000)

    console.log('[STARTUP] Settlement retry interval configured (5 minutes)')
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return
    await handleCommand(interaction)
  })

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return

    const fetchedReaction = reaction.partial ? await reaction.fetch() : reaction
    const fetchedUser = user.partial ? await user.fetch() : user

    await handleReaction(fetchedReaction, fetchedUser, 'add')
  })

}

export async function startBot() {
  const botClient = getClient()
  await botClient.login(env.DISCORD_BOT_TOKEN)
  return botClient
}
