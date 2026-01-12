import { CONFIG } from '../config/index.js'
import {
  trades,
  predictions,
  users,
  settlements,
  runtimeState,
  getDb,
} from '../database/index.js'
import { analyzeMarket, getCandleParams } from './agents.js'
import {
  executeTrade,
  getMarketResolution,
  find15MinuteMarkets,
  get15MinuteMarket,
  getCurrentPrice,
  getPositionPnl,
  redeemWinnings,
  getRecentCandles,
} from './polymarket.js'
import { runWeeklyPayouts, getPoolBalance, getProfitSinceLastPayout } from './payouts.js'
import { getVoteEmojis } from '../bot/reactions.js'

let tickInterval = null

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins === 0) return `${secs} second${secs !== 1 ? 's' : ''}`
  if (secs === 0) return `${mins} minute${mins !== 1 ? 's' : ''}`
  return `${mins}m ${secs}s`
}

async function cancelVotingTrade(tradeId, channel, reason) {
  trades.deleteTrade(tradeId)
  if (channel) {
    await channel.send(`❌ Trade cancelled: ${reason}`).catch(() => {})
  }
  console.error(`[SCHEDULER] Trade ${tradeId} cancelled: ${reason}`)
}


let tradingChannel = null

export function isEmergencyStopped() {
  return runtimeState.getEmergencyStopped()
}

export function setEmergencyStop(stopped) {
  runtimeState.setEmergencyStopped(stopped)
  console.log(`[SCHEDULER] Emergency stop ${stopped ? 'activated' : 'deactivated'} and persisted to database`)
}

/**
 * Check if a new trade can be started
 * @param {boolean} isUserProposal - Whether this is from /propose command
 * @returns {{ allowed: boolean, reason?: string, waitMs?: number }}
 */
export function canStartTrade(isUserProposal = false) {
  const now = new Date()

  if (isEmergencyStopped()) {
    return { allowed: false, reason: 'Bot is in emergency stop mode.' }
  }

  const activeTrade = trades.getActive()
  if (activeTrade) {
    return { allowed: false, reason: 'A trade is already in progress.' }
  }

  const incompleteSettlements = settlements.getIncomplete()
  if (incompleteSettlements.length > 0) {
    return { allowed: false, reason: 'Payout settlement in progress. Trading will resume after payouts complete.' }
  }

  const lastTrade = trades.getLastResolved()
  if (lastTrade?.resolved_at) {
    const gapMs = now - new Date(lastTrade.resolved_at)
    const minGapMs = CONFIG.scheduling.min_gap_minutes * 60 * 1000
    if (gapMs < minGapMs) {
      const waitMs = minGapMs - gapMs
      const waitMins = Math.ceil(waitMs / 60000)
      return {
        allowed: false,
        reason: `Too soon after last trade. Wait ${waitMins} minute(s).`,
        waitMs,
      }
    }
  }

  if (isUserProposal) {
    const blackoutCheck = isInMorningBlackout(now)
    if (blackoutCheck.inBlackout) {
      return {
        allowed: false,
        reason: `Morning trade blackout. /propose available again at ${blackoutCheck.availableAt}.`,
      }
    }
  }

  return { allowed: true }
}

function getTimeInTimezone(date, timezone) {
  const options = { timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false }
  const timeStr = date.toLocaleString('en-US', options)
  const [hour, minute] = timeStr.split(':').map(Number)
  return { hour, minute }
}

function isInMorningBlackout(now) {
  const [targetHour, targetMinute] = CONFIG.scheduling.morning_trade_time.split(':').map(Number)
  const blackoutMinutes = CONFIG.scheduling.morning_blackout_minutes
  const timezone = CONFIG.scheduling.timezone

  const { hour: currentHour, minute: currentMinute } = getTimeInTimezone(now, timezone)
  const currentTotalMinutes = currentHour * 60 + currentMinute
  const targetTotalMinutes = targetHour * 60 + targetMinute
  const blackoutStartMinutes = targetTotalMinutes - blackoutMinutes

  if (currentTotalMinutes >= blackoutStartMinutes && currentTotalMinutes < targetTotalMinutes) {
    const availableAt = `${targetHour % 12 || 12}:${targetMinute.toString().padStart(2, '0')} ${targetHour >= 12 ? 'PM' : 'AM'}`
    return {
      inBlackout: true,
      availableAt,
    }
  }

  return { inBlackout: false }
}

function isWithinTradingHours(now) {
  const { hour } = getTimeInTimezone(now, CONFIG.scheduling.timezone)
  return hour >= CONFIG.scheduling.trade_hours_start && hour < CONFIG.scheduling.trade_hours_end
}

export async function initScheduler(client, channelId) {
  if (runtimeState.getEmergencyStopped()) {
    console.log('[SCHEDULER] Emergency stop state restored from database')
  }

  if (!channelId) {
    throw new Error('Missing discord.trading_channel_id in config.yaml')
  }

  for (const guild of client.guilds.cache.values()) {
    tradingChannel = guild.channels.cache.get(channelId)
    if (tradingChannel) break
  }

  if (!tradingChannel) {
    throw new Error(`Trading channel not found for configured id: ${channelId}`)
  }

  const tickIntervalMs = CONFIG.scheduling.tick_interval_seconds * 1000
  tickInterval = setInterval(() => tick(), tickIntervalMs)
  tick()

  console.log(`[SCHEDULER] Tick-based scheduler initialized (${CONFIG.scheduling.tick_interval_seconds}s interval)`)
  console.log(`[SCHEDULER] Morning trade: ${CONFIG.scheduling.morning_trade_time} ${CONFIG.scheduling.timezone}`)
  console.log(`[SCHEDULER] Hourly trades: ${CONFIG.scheduling.trade_hours_start}:00-${CONFIG.scheduling.trade_hours_end}:00 ${CONFIG.scheduling.timezone}`)
  console.log(`[SCHEDULER] Weekly payouts: Sundays 18:00 ${CONFIG.scheduling.timezone}`)
}

async function tick() {
  if (isEmergencyStopped()) return

  const now = new Date()
  await checkVotingWindows(now)
  await checkMorningTrade(now)
  await checkHourlyTrade(now)
  await checkWeeklyPayout(now)
  await checkPendingResolutions()
}

function getDateInTimezone(date, timezone) {
  return date.toLocaleDateString('en-CA', { timeZone: timezone }) // YYYY-MM-DD format
}

async function checkVotingWindows(now) {
  const votingTrades = trades.getVotingTrades()

  for (const trade of votingTrades) {
    const endTime = new Date(trade.voting_ends_at)
    if (now >= endTime) {
      console.log(`[SCHEDULER] Voting window closed for trade ${trade.id}`)
      await closeVotingFromTick(trade)
    }
  }
}

async function checkMorningTrade(now) {
  const [targetHour, targetMinute] = CONFIG.scheduling.morning_trade_time.split(':').map(Number)
  const timezone = CONFIG.scheduling.timezone

  const { hour: currentHour, minute: currentMinute } = getTimeInTimezone(now, timezone)
  const todayDate = getDateInTimezone(now, timezone)

  const state = runtimeState.getScheduleState()
  if (state.last_morning_trade_date === todayDate) return

  const currentTotalMinutes = currentHour * 60 + currentMinute
  const targetTotalMinutes = targetHour * 60 + targetMinute

  if (currentTotalMinutes >= targetTotalMinutes) {
    runtimeState.setLastMorningTradeDate(todayDate)
    await handleScheduledTrade('morning')
  }
}

async function checkHourlyTrade(now) {
  const timezone = CONFIG.scheduling.timezone
  const { hour: currentHour } = getTimeInTimezone(now, timezone)
  const [morningHour] = CONFIG.scheduling.morning_trade_time.split(':').map(Number)

  if (currentHour === morningHour) return
  if (!isWithinTradingHours(now)) return

  const state = runtimeState.getScheduleState()
  const nextTradeTime = new Date(
    state.next_hourly_trade_at
  )

  if (nextTradeTime.getTime() === 0) {
    scheduleNextHourlyTrade(now)
    return
  }

  if (now >= nextTradeTime) {
    scheduleNextHourlyTrade(now)
    await handleScheduledTrade('hourly')
  }
}

function scheduleNextHourlyTrade(now) {
  const timezone = CONFIG.scheduling.timezone
  const { minute: currentMinute } = getTimeInTimezone(now, timezone)

  // Calculate ms until next hour boundary in configured timezone
  // Duration is timezone-independent: if it's XX:42:15, we need 17m45s until XX+1:00:00
  const secondsIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds()
  const msUntilNextHour = (60 - currentMinute) * 60 * 1000 - secondsIntoMinute
  const nextHour = new Date(now.getTime() + msUntilNextHour)

  const variance = CONFIG.scheduling.interval_variance_minutes * 60 * 1000
  const randomOffset = Math.floor(Math.random() * variance * 2) - variance
  const scheduledTime = new Date(nextHour.getTime() + randomOffset)

  if (scheduledTime <= now) {
    scheduledTime.setTime(now.getTime() + 60000) // 1 minute from now
  }

  runtimeState.setNextHourlyTradeAt(scheduledTime.toISOString())
  console.log(`[SCHEDULER] Next hourly trade scheduled at ${scheduledTime.toISOString()}`)
}

async function checkWeeklyPayout(now) {
  const timezone = CONFIG.scheduling.timezone
  const { hour: currentHour } = getTimeInTimezone(now, timezone)

  const dayOptions = { timeZone: timezone, weekday: 'short' }
  const dayOfWeek = now.toLocaleDateString('en-US', dayOptions)

  if (dayOfWeek !== 'Sun') return
  if (currentHour < 18) return

  const todayDate = getDateInTimezone(now, timezone)
  const state = runtimeState.getScheduleState()
  if (state.last_weekly_payout_date === todayDate) return

  runtimeState.setLastWeeklyPayoutDate(todayDate)
  await handleWeeklyPayout()
}

async function handleWeeklyPayout() {
  if (!tradingChannel) {
    console.error('[SCHEDULER] No trading channel available for weekly payout')
    return
  }

  if (isEmergencyStopped()) {
    console.log('[SCHEDULER] Skipping weekly payout: emergency stop active')
    return
  }

  const incompleteSettlements = settlements.getIncomplete()
  if (incompleteSettlements.length > 0) {
    console.log('[SCHEDULER] Skipping weekly payout: settlement already in progress')
    return
  }

  console.log('[SCHEDULER] Running weekly payout check')
  try {
    await runWeeklyPayouts(tradingChannel)
  } catch (error) {
    console.error('[SCHEDULER] Weekly payout error:', error)
  }
}

// Track trades currently being resolved to avoid duplicate resolution attempts
const resolvingTrades = new Set()

async function checkPendingResolutions() {
  if (!tradingChannel) return
  if (isEmergencyStopped()) return

  const readyTrades = trades.getReadyForResolution()

  for (const trade of readyTrades) {
    if (resolvingTrades.has(trade.id)) continue

    resolvingTrades.add(trade.id)
    console.log(`[RESOLUTION] Trade ${trade.id} (${trade.asset}) is ready for resolution`)

    resolveRound(trade.id, tradingChannel)
      .catch(err => console.error(`[RESOLUTION] Error resolving trade ${trade.id}:`, err))
      .finally(() => resolvingTrades.delete(trade.id))
  }
}

async function handleScheduledTrade(type) {
  if (!tradingChannel) {
    console.error('[SCHEDULER] No trading channel available')
    return
  }

  const check = canStartTrade(false)

  if (!check.allowed && check.waitMs) {
    console.log(`[SCHEDULER] Delaying ${type} trade by ${Math.ceil(check.waitMs / 60000)} min due to gap enforcement`)
    setTimeout(() => handleScheduledTrade(type), check.waitMs)
    return
  }

  if (!check.allowed) {
    console.log(`[SCHEDULER] Skipping ${type} trade: ${check.reason}`)
    return
  }

  console.log(`[SCHEDULER] Starting ${type} trade`)
  await startTrade(tradingChannel, 'cron')
}

export async function handlePropose(interaction) {
  const holderRoleId = CONFIG.discord.holder_role_id
  if (holderRoleId) {
    const member = await interaction.guild?.members.fetch(interaction.user.id)
    if (!member?.roles.cache.has(holderRoleId)) {
      await interaction.reply({
        content: '**Access denied**\n\nOnly verified holders can propose trades.',
        ephemeral: true,
      })
      return
    }
  }

  const check = canStartTrade(true)
  if (!check.allowed) {
    await interaction.reply({
      content: `**Cannot start trade**\n\n${check.reason}`,
      ephemeral: true,
    })
    return
  }

  const channelId = CONFIG.discord.trading_channel_id
  if (!channelId) {
    throw new Error('Missing discord.trading_channel_id in config.yaml')
  }

  const channel = interaction.guild?.channels.cache.get(channelId)
  if (!channel) {
    throw new Error(`Trading channel not found for configured id: ${channelId}`)
  }

  await interaction.reply({
    content: '⚡ **Proposing trade...**',
    ephemeral: true,
  })

  try {
    await startTrade(channel, `user:${interaction.user.id}`)
  } catch (error) {
    console.error('Failed to start trade:', error)
    await interaction.followUp({
      content: '❌ Failed to start trade. Try again later.',
      ephemeral: true,
    })
  }
}

export async function startTrade(channel, triggeredBy) {
  if (isEmergencyStopped()) {
    await channel.send('⛔ Trade cancelled - emergency stop activated.')
    return
  }

  const incompleteSettlements = settlements.getIncomplete()
  if (incompleteSettlements.length > 0) {
    await channel.send('⏳ Trade delayed - payout settlement in progress.')
    return
  }

  // Early check to avoid duplicate market fetches from concurrent calls
  const activeTrade = trades.getActive()
  if (activeTrade) {
    console.log(`[SCHEDULER] Trade already active (${activeTrade.id}), skipping`)
    return
  }

  const assets = ['BTC', 'ETH', 'SOL', 'XRP']
  const { candleInterval, candleLimit } = getCandleParams()

  // Fetch markets and candles in parallel for speed
  const [allMarkets, ...candleResults] = await Promise.all([
    find15MinuteMarkets(),
    ...assets.map(asset => getRecentCandles(asset, candleInterval, candleLimit)),
  ])

  const marketsByAsset = {}
  for (const asset of assets) {
    marketsByAsset[asset] = allMarkets.find(m => m.asset === asset) || null
  }

  const candlesByAsset = {}
  for (let i = 0; i < assets.length; i++) {
    candlesByAsset[assets[i]] = candleResults[i]
  }

  let analysis
  try {
    analysis = await analyzeMarket({ marketsByAsset, candlesByAsset })
  } catch (error) {
    console.error('Market analysis failed:', error)
    await channel.send('❌ Market analysis failed. Trade cancelled.')
    return
  }

  let market = marketsByAsset[analysis.asset] || await get15MinuteMarket(analysis.asset)
  if (!market) {
    await channel.send(`❌ No active 15M market found for ${analysis.asset}. Trying another asset...`)
    for (const fallbackAsset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      if (fallbackAsset !== analysis.asset) {
        const fallbackMarket = marketsByAsset[fallbackAsset] || await get15MinuteMarket(fallbackAsset)
        if (fallbackMarket) {
          analysis.asset = fallbackAsset
          analysis.current_price = await getCurrentPrice(fallbackAsset)
          market = fallbackMarket
          break
        }
      }
    }
    if (!market) {
      await channel.send('❌ No active 15M crypto markets available. Try again later.')
      return
    }
  }

  const votingEndsAt = new Date(Date.now() + CONFIG.trading.voting_window_seconds * 1000).toISOString()
  const trade = trades.createIfNoActive({
    asset: analysis.asset,
    polymarket_market_id: market.id,
    resolution_time: market.resolution_time.toISOString(),
    voting_ends_at: votingEndsAt,
  })

  if (!trade) {
    const pendingSettlements = settlements.getIncomplete()
    if (pendingSettlements.length > 0) {
      await channel.send('⚠️ Trade skipped - payout settlement in progress.')
    } else {
      await channel.send('⚠️ Another trade started. This proposal was skipped.')
    }
    return
  }

  const { up: UP_EMOJI, down: DOWN_EMOJI } = getVoteEmojis()

  const triggerText = triggeredBy === 'cron'
    ? 'Scheduled trade'
    : `Proposed by <@${triggeredBy.replace('user:', '')}>`

  let proposalMessage = null
  try {
    proposalMessage = await channel.send({
      content: [
        `⚡ **${analysis.asset} 15-Minute Prediction**`,
        ``,
        `📊 **Quick Analysis:**`,
        analysis.reasoning,
        ``,
        `Current price: $${analysis.current_price.toLocaleString()}`,
        `Question: Will ${analysis.asset} be **UP** or **DOWN** in 15 minutes?`,
        ``,
        `⏰ Voting closes in ${formatDuration(CONFIG.trading.voting_window_seconds)}`,
        `React: ${UP_EMOJI} UP | ${DOWN_EMOJI} DOWN`,
        ``,
        `Minimum ${CONFIG.trading.min_votes} votes to execute`,
        `[View on Polymarket](https://polymarket.com/event/${market.slug})`,
        ``,
        `_${triggerText}_`,
      ].join('\n'),
    })
  } catch (error) {
    console.error(`[SCHEDULER] Failed to post proposal for trade ${trade.id}:`, error.message)
    trades.deleteTrade(trade.id)
    return
  }

  trades.updateMessageId(trade.id, proposalMessage.id)

  try {
    await proposalMessage.react(UP_EMOJI)
  } catch (error) {
    console.error(`[SCHEDULER] Failed to add UP reaction for trade ${trade.id}:`, error.message)
  }

  try {
    await proposalMessage.react(DOWN_EMOJI)
  } catch (error) {
    console.error(`[SCHEDULER] Failed to add DOWN reaction for trade ${trade.id}:`, error.message)
  }

  // Voting window is handled by the tick loop via voting_ends_at
  console.log(`[SCHEDULER] Trade ${trade.id} voting ends at ${trade.voting_ends_at}`)
}

async function closeVotingFromTick(trade) {
  if (!tradingChannel) {
    console.error('[SCHEDULER] No trading channel available for voting close')
    return
  }

  let proposalMessage = null

  if (trade.proposal_message_id) {
    try {
      proposalMessage = await tradingChannel.messages.fetch(trade.proposal_message_id)
    } catch (error) {
      console.error(`[SCHEDULER] Failed to fetch proposal message ${trade.proposal_message_id}:`, error.message)
    }  
  }

  if (!proposalMessage) {
    await cancelVotingTrade(trade.id, tradingChannel, 'Proposal message unavailable')
    return
  }

  let market = null
  try {
    market = await get15MinuteMarket(trade.asset)
  } catch (error) {
    console.error(`[SCHEDULER] Failed to fetch market for ${trade.asset}:`, error.message)
  }
  if (!market) {
    await cancelVotingTrade(trade.id, tradingChannel, 'No active market')
    return
  }

  await closeVoting(trade.id, proposalMessage, tradingChannel, market)
}

async function closeVoting(tradeId, proposalMessage, channel, market) {
  const trade = trades.getById(tradeId)
  if (!trade || trade.status !== 'voting') return

  const { up: UP_EMOJI, down: DOWN_EMOJI } = getVoteEmojis()
  const snapshotTime = new Date().toISOString()
  await snapshotPredictionsFromReactions(tradeId, proposalMessage, UP_EMOJI, DOWN_EMOJI, snapshotTime)

  const voteCounts = predictions.getVoteCounts(tradeId)
  const upVotes = voteCounts.up
  const downVotes = voteCounts.down
  const totalVotes = upVotes + downVotes

  if (totalVotes < CONFIG.trading.min_votes) {
    trades.deleteTrade(tradeId)
    await channel.send({
      content: [
        `⏰ **Voting closed**`,
        ``,
        `${UP_EMOJI} UP: ${upVotes} | ${DOWN_EMOJI} DOWN: ${downVotes}`,
        ``,
        `❌ Not enough votes (need ${CONFIG.trading.min_votes}). Trade cancelled.`,
      ].join('\n'),
    })
    return
  }

  const isTie = upVotes === downVotes
  const position = upVotes > downVotes ? 'UP'
    : upVotes < downVotes ? 'DOWN'
    : Math.random() > 0.5 ? 'UP' : 'DOWN'
  const upPercent = Math.round((upVotes / totalVotes) * 100)
  const downPercent = 100 - upPercent

  const poolBalance = await getPoolBalance()
  if (poolBalance <= 0) {
    trades.deleteTrade(tradeId)
    await channel.send('❌ No USDC balance in wallet. Trade cancelled.')
    return
  }

  const conviction = Math.abs(upPercent - downPercent) / 100
  const minPct = Number(CONFIG.trading.min_position_pct) || 0.05
  const maxPct = Number(CONFIG.trading.max_position_pct) || 0.10
  const minSize = poolBalance * minPct
  const maxSize = poolBalance * maxPct
  let positionSize = minSize + (maxSize - minSize) * conviction

  // Ensure minimum $1 bet
  if (positionSize < 1) {
    if (poolBalance >= 1) {
      positionSize = 1
    } else {
      trades.deleteTrade(tradeId)
      await channel.send('❌ Pool balance too low for minimum $1 bet. Trade cancelled.')
      return
    }
  }

  if (!market) {
    trades.deleteTrade(tradeId)
    await channel.send('❌ No active market. Trade cancelled.')
    return
  }

  try {
    const result = await executeTrade(market, position, positionSize)
    if (!result.success) {
      throw new Error(result.reason || 'Trade execution failed')
    }

    trades.execute(tradeId, position)

    trades.updateOrderId(tradeId, result.orderID)

    const direction = position === 'UP' ? 'LONG' : 'SHORT'
    const sizePct = ((result.totalCost / poolBalance) * 100).toFixed(1)
    const convictionLabel = conviction > 0.6 ? 'High' : conviction > 0.3 ? 'Medium' : 'Low'

    // Calculate minutes until resolution for display
    const resolutionTime = market.resolution_time.getTime()
    const resolutionMinutes = Math.ceil((resolutionTime - Date.now()) / 60000)

    await channel.send({
      content: [
        `🎯 **${trade.asset} ${direction} LOCKED**`,
        ``,
        `${UP_EMOJI} UP: ${upVotes} (${upPercent}%) · ${DOWN_EMOJI} DOWN: ${downVotes} (${downPercent}%)`,
        isTie ? `🎲 Tie! Coin flip chose ${position}.` : '',
        ``,
        `💵 $${result.totalCost.toFixed(2)} → ${result.sharesFilled.toFixed(2)} shares @ $${result.avgFillPrice.toFixed(4)}`,
        `📊 ${convictionLabel} conviction · ${sizePct}% of pool`,
        ``,
        `⏰ Resolves in ~${resolutionMinutes} min`,
        ``,
        `🔗 [View DeWiz on Polymarket](https://polymarket.com/@DeWiz)`,
      ].filter(Boolean).join('\n'),
    })

  } catch (error) {
    console.error('Trade execution failed:', error)
    trades.deleteTrade(tradeId)
    await channel.send(`❌ Trade execution failed: ${error.message || 'Unknown error'}`)
  }
}

async function getEligibleSnapshotUser(discordUser, guild, holderRoleId) {
  if (discordUser.bot) return null
  if (!guild) return null

  if (holderRoleId) {
    let member = guild.members.cache.get(discordUser.id)
    if (!member) {
      member = await guild.members.fetch(discordUser.id).catch(() => null)
    }
    if (!member?.roles.cache.has(holderRoleId)) {
      return null
    }
  }

  const user = users.get(discordUser.id)
  if (!user?.wallet_address) return null

  if (user.discord_username !== discordUser.username) {
    return users.getOrCreate(discordUser.id, discordUser.username)
  }

  return user
}

async function snapshotPredictionsFromReactions(tradeId, message, upEmoji, downEmoji, snapshotAt) {
  const holderRoleId = CONFIG.discord.holder_role_id
  const guild = message.guild
  const upReaction = message.reactions.cache.find(r => r.emoji.name === upEmoji)
  const downReaction = message.reactions.cache.find(r => r.emoji.name === downEmoji)

  if (upReaction) {
    const upUsers = await upReaction.users.fetch()
    for (const discordUser of upUsers.values()) {
      const user = await getEligibleSnapshotUser(discordUser, guild, holderRoleId)
      if (!user) continue
      predictions.upsertWithSnapshot(user.discord_id, tradeId, 'UP', snapshotAt)
    }
  }

  if (downReaction) {
    const downUsers = await downReaction.users.fetch()
    for (const discordUser of downUsers.values()) {
      const user = await getEligibleSnapshotUser(discordUser, guild, holderRoleId)
      if (!user) continue
      predictions.upsertWithSnapshot(user.discord_id, tradeId, 'DOWN', snapshotAt)
    }
  }

  predictions.deleteNonSnapshotted(tradeId)

  console.log(`[SNAPSHOT] Snapshotted predictions for trade ${tradeId} at ${snapshotAt}`)
}

export async function resolveRound(tradeId, channel) {
  const trade = trades.getById(tradeId)
  if (!trade || trade.status !== 'executed') return

  try {
    const resolution = await getMarketResolution(trade.polymarket_market_id)

    if (!resolution.resolved) {
      console.log(`[RESOLUTION] Trade ${tradeId} market not yet resolved`)
      return
    }

    const { pnl, pnlPercent } = await getPositionPnl(resolution.conditionId)

    try {
      await redeemWinnings(resolution.conditionId, resolution.tokenIds)
    } catch (redeemError) {
      console.error(`[RESOLUTION] Redemption failed for trade ${tradeId}:`, redeemError.message)
      return
    }

    const correctPosition = resolution.outcome
    const summary = applyResolutionUpdates(tradeId, correctPosition, pnl)
    await finishRound(channel, trade, correctPosition, pnl, pnlPercent, summary)

  } catch (error) {
    console.error(`[RESOLUTION] Error resolving trade ${tradeId}:`, error.message)
  }
}

function applyResolutionUpdates(tradeId, correctPosition, pnl) {
  const db = getDb()

  const transaction = db.transaction(() => {
    trades.resolve(tradeId, pnl)
    predictions.markCorrectness(tradeId, correctPosition)

    const tradePredictions = predictions.getSnapshottedByTrade(tradeId)
    const correctPredictors = []
    const streakUpdates = []

    for (const pred of tradePredictions) {
      const user = users.get(pred.user_id)

      const wasCorrect = pred.prediction === correctPosition

      if (wasCorrect) {
        const newStreak = user.current_streak + 1
        const newBest = Math.max(user.best_streak, newStreak)

        users.updateStreak(user.discord_id, newStreak, newBest)
        correctPredictors.push(user.discord_id)

        if (newStreak >= 3) {
          const emoji = newStreak >= 10 ? '🔥🔥🔥'
            : newStreak >= 5 ? '🔥🔥'
            : '🔥'
          streakUpdates.push(`${emoji} <@${user.discord_id}> on a ${newStreak}-streak!`)
        }
      } else {
        users.updateStreak(user.discord_id, 0, user.best_streak)
      }

      if (user.reputation_weight < 1.0) {
        const newWeight = Math.min(
          CONFIG.reputation.max_weight,
          user.reputation_weight + CONFIG.reputation.weight_increase_per_prediction
        )

        users.updateReputationWeight(user.discord_id, newWeight)
      }
    }

    return { correctPredictors, streakUpdates }
  })

  return transaction()
}

async function finishRound(channel, trade, correctPosition, pnl, pnlPercent, summary) {
  const { correctPredictors, streakUpdates } = summary

  const isWin = pnl > 0
  const currentBalance = await getPoolBalance()
  const profitSincePayout = await getProfitSinceLastPayout()

  const profitProgress = Math.max(0, profitSincePayout)

  if (isWin) {
    const winLines = [
      `🚀 **WE'RE SO BACK**`,
      ``,
      `${trade.asset} went **${correctPosition}** · +$${pnl.toFixed(2)} (+${pnlPercent.toFixed(0)}%) 💰`,
    ]

    if (correctPredictors.length > 0) {
      winLines.push(``, `✅ ${correctPredictors.slice(0, 8).map(id => `<@${id}>`).join(', ')}`)
    }

    if (streakUpdates.length > 0) {
      winLines.push(``, streakUpdates.join('\n'))
    }

    winLines.push(
      ``,
      `💰 Pool: $${currentBalance.toFixed(2)} · $${profitProgress.toFixed(2)} toward next payout`,
      ``,
      `🔗 [DeWiz on Polymarket](https://polymarket.com/@DeWiz)`
    )

    await channel.send({ content: winLines.join('\n') })
  } else {
    const lossLines = [
      `📉 **Down bad**`,
      ``,
      `${trade.asset} went **${correctPosition}** · we were ${trade.executed_position === 'UP' ? 'long' : 'short'} · -$${Math.abs(pnl).toFixed(2)}`,
    ]

    if (correctPredictors.length > 0) {
      lossLines.push(``, `🎯 ${correctPredictors.slice(0, 5).map(id => `<@${id}>`).join(', ')} counter-called it`)
    }

    lossLines.push(
      ``,
      `💰 Pool: $${currentBalance.toFixed(2)}`,
      ``,
      `🔗 [DeWiz on Polymarket](https://polymarket.com/@DeWiz)`
    )

    await channel.send({ content: lossLines.join('\n') })
  }
}
