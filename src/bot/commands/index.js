import {
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} from 'discord.js'
import { env } from '../../config/index.js'

import { handleRegister, handleUpdateAddress, handleMyAddress } from './wallet.js'
import { handleMyStats, handleLeaderboard } from './stats.js'
import { handlePool, handleHistory, handleAbout } from './pool.js'
import { handlePropose } from '../../services/scheduler.js'
import { handleEmergencyStop, handleResume } from './admin.js'

const commands = [
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register your Polygon wallet address for payouts')
    .addStringOption(option =>
      option.setName('address')
        .setDescription('Your Polygon wallet address (0x...)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('update-address')
    .setDescription('Update your registered wallet address')
    .addStringOption(option =>
      option.setName('address')
        .setDescription('Your new Polygon wallet address (0x...)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('my-address')
    .setDescription('View your registered wallet address'),

  new SlashCommandBuilder()
    .setName('my-stats')
    .setDescription('View your prediction accuracy, reputation, and streaks'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View top predictors'),

  new SlashCommandBuilder()
    .setName('pool')
    .setDescription('View current pool balance and positions'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('View recent trade history'),

  new SlashCommandBuilder()
    .setName('propose')
    .setDescription('Propose a new trade (Claude analyzes market and picks direction)'),

  new SlashCommandBuilder()
    .setName('emergency-stop')
    .setDescription('Halt all bot trading activity')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume trading after emergency stop')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('about')
    .setDescription('Learn how the trading bot works'),
]

export async function registerCommands() {
  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN)

  try {
    console.log('Registering slash commands...')

    await rest.put(
      Routes.applicationCommands(env.DISCORD_CLIENT_ID),
      { body: commands.map(c => c.toJSON()) }
    )

    console.log('Slash commands registered successfully')
  } catch (error) {
    console.error('Error registering commands:', error)
    throw error
  }
}

export async function handleCommand(interaction) {
  const { commandName } = interaction

  switch (commandName) {
    case 'register':
      await handleRegister(interaction)
      break
    case 'update-address':
      await handleUpdateAddress(interaction)
      break
    case 'my-address':
      await handleMyAddress(interaction)
      break

    case 'my-stats':
      await handleMyStats(interaction)
      break
    case 'leaderboard':
      await handleLeaderboard(interaction)
      break

    case 'pool':
      await handlePool(interaction)
      break
    case 'history':
      await handleHistory(interaction)
      break

    case 'propose':
      await handlePropose(interaction)
      break

    case 'emergency-stop':
      await handleEmergencyStop(interaction)
      break
    case 'resume':
      await handleResume(interaction)
      break

    case 'about':
      await handleAbout(interaction)
      break

    default:
      await interaction.reply({
        content: 'Unknown command. The wizards are confused...',
        ephemeral: true,
      })
  }
}
