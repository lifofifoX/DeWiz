import { users } from '../../database/index.js'

export async function handleMyStats(interaction) {
  const user = users.get(interaction.user.id)

  if (!user) {
    await interaction.reply({
      content: '**No stats yet**\n\nParticipate in a trading session to build your stats!',
      ephemeral: true,
    })
    return
  }

  const stats = users.getStats(user.discord_id)

  const accuracy = stats.totalPredictions > 0
    ? ((stats.correctPredictions / stats.totalPredictions) * 100).toFixed(1)
    : 0

  const streakEmoji = user.current_streak >= 10 ? '🔥🔥🔥'
    : user.current_streak >= 5 ? '🔥🔥'
    : user.current_streak >= 3 ? '🔥'
    : ''

  await interaction.reply({
    content: [
      `📊 **Your Stats**`,
      ``,
      `**Predictions:** ${stats.totalPredictions}`,
      `**Accuracy:** ${accuracy}% (${stats.correctPredictions}/${stats.totalPredictions})`,
      `**Current Streak:** ${user.current_streak} ${streakEmoji}`,
      `**Best Streak:** ${user.best_streak}`,
      `**Reputation Weight:** ${(user.reputation_weight * 100).toFixed(0)}%`,
      ``,
      `**Total Earned:** $${stats.totalEarned.toFixed(2)} USDC`,
    ].join('\n'),
    ephemeral: true,
  })
}

export async function handleLeaderboard(interaction) {
  const topUsers = users.getTopPredictors(10)

  if (topUsers.length === 0) {
    await interaction.reply({
      content: '**No predictions yet**\n\nStart a trading session to build the leaderboard!',
      ephemeral: true,
    })
    return
  }

  const leaderboardLines = topUsers.map((user, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`
    const accuracy = user.total_predictions > 0
      ? ((user.correct_predictions / user.total_predictions) * 100).toFixed(1)
      : 0
    const streakEmoji = user.current_streak >= 5 ? '🔥' : ''

    return `${medal} ${user.discord_username || 'Unknown'} - ${accuracy}% (${user.correct_predictions}/${user.total_predictions}) ${streakEmoji}`
  })

  await interaction.reply({
    content: [
      `🏆 **Top Predictors**`,
      ``,
      ...leaderboardLines,
      ``,
      `_Ranked by accuracy × reputation weight_`,
    ].join('\n'),
  })
}
