import { PermissionFlagsBits } from 'discord.js'
import { setEmergencyStop } from '../../services/scheduler.js'

export async function handleEmergencyStop(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: '**Access denied**\n\nOnly administrators can use this command.',
      ephemeral: true,
    })
    return
  }

  setEmergencyStop(true)

  await interaction.reply({
    content: [
      `⛔ **EMERGENCY STOP ACTIVATED**`,
      ``,
      `All trading has been halted.`,
      `Scheduled trades paused.`,
      ``,
      `Use \`/resume\` to restart trading.`,
    ].join('\n'),
  })
}

export async function handleResume(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: '**Access denied**\n\nOnly administrators can use this command.',
      ephemeral: true,
    })
    return
  }

  setEmergencyStop(false)

  await interaction.reply({
    content: [
      `✅ **Trading Resumed**`,
      ``,
      `Bot is back online. Scheduled trades will resume.`,
      `Use \`/propose\` to trigger a trade manually.`,
    ].join('\n'),
  })
}
