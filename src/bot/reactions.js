import { trades, predictions, users } from '../database/index.js'
import { CONFIG } from '../config/index.js'

const UP_EMOJI = '🟢'
const DOWN_EMOJI = '🔴'

export async function handleReaction(reaction, discordUser, _action) {
  const emoji = reaction.emoji.name
  const messageId = reaction.message.id

  const trade = trades.getByMessageId(messageId)
  if (!trade) return

  const guild = reaction.message.guild
  if (!guild) return

  const member = await guild.members.fetch(discordUser.id).catch(() => null)
  if (!member) return

  const holderRoleId = CONFIG.discord.holder_role_id
  if (holderRoleId && !member.roles.cache.has(holderRoleId)) {
    return
  }

  if (trade.status === 'voting' && (emoji === UP_EMOJI || emoji === DOWN_EMOJI)) {
    const user = users.get(discordUser.id)
    if (!user || !user.wallet_address) {
      await reaction.users.remove(discordUser.id).catch(() => {})
      const notifyMsg = await reaction.message.channel.send(
        `<@${discordUser.id}> You need to register a wallet before voting. Use \`/register <your-polygon-address>\``
      ).catch(() => null)
      if (notifyMsg) {
        setTimeout(() => notifyMsg.delete().catch(() => {}), 10000)
      }
      return
    }

    const prediction = emoji === UP_EMOJI ? 'UP' : 'DOWN'

    if (user.discord_username !== discordUser.username) {
      users.getOrCreate(discordUser.id, discordUser.username)
    }

    predictions.upsert(user.discord_id, trade.id, prediction)

    const oppositeEmoji = emoji === UP_EMOJI ? DOWN_EMOJI : UP_EMOJI
    const oppositeReaction = reaction.message.reactions.cache.find(
      r => r.emoji.name === oppositeEmoji
    )
    if (oppositeReaction) {
      await oppositeReaction.users.remove(discordUser.id).catch(() => {})
    }

    console.log(`[Vote] ${discordUser.username} voted ${prediction} on trade ${trade.id}`)
  }
}

export function getVoteEmojis() {
  return { up: UP_EMOJI, down: DOWN_EMOJI }
}
