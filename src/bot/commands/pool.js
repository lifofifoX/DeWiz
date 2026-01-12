import { payouts, trades } from '../../database/index.js'
import { CONFIG } from '../../config/index.js'
import { checkWalletBalance, getProfitSinceLastPayout } from '../../services/payouts.js'

export async function handlePool(interaction) {
  await interaction.deferReply()

  const walletBalance = await checkWalletBalance()
  const profitSincePayout = getProfitSinceLastPayout()
  const totalPnl = trades.getTotalPnl()
  const totalDistributed = payouts.getTotalDistributed()
  const payoutShare = CONFIG.payouts.payout_share
  const minPayoutUsd = CONFIG.payouts.min_payout_usd
  const estPayout = Math.floor(Math.max(0, profitSincePayout) * payoutShare * 100) / 100

  const activeTrade = trades.getActive()
  const positionInfo = activeTrade
    ? `**Current Position:** ${activeTrade.executed_position || 'Voting...'} ${activeTrade.asset}`
    : 'No active position'

  const payoutStatus = estPayout >= minPayoutUsd
    ? `Ready for payout`
    : `${Math.max(0, (estPayout / minPayoutUsd) * 100).toFixed(0)}% to minimum`

  await interaction.editReply({
    content: [
      `💰 **Pool Status**`,
      ``,
      `**Balance:** $${walletBalance.usdc.toFixed(2)} USDC | ${walletBalance.matic.toFixed(4)} POL`,
      positionInfo,
      ``,
      `**Payouts** (Sun 18:00 ${CONFIG.scheduling.timezone}):`,
      `Unpaid profit: $${profitSincePayout.toFixed(2)} → Est. payout: $${estPayout.toFixed(2)} (${payoutStatus})`,
      ``,
      `**All-time:** P&L $${totalPnl.toFixed(2)} | Distributed $${totalDistributed.toFixed(2)}`,
    ].join('\n'),
  })
}

export async function handleAbout(interaction) {
  await interaction.reply({
    content: [
      `**DegenWizard Trading Bot**`,
      ``,
      `This bot trades 15-minute crypto prediction markets on Polymarket.`,
      ``,
      `**How it works:**`,
      `1. Claude AI analyzes BTC, ETH, SOL, or XRP and proposes a trade`,
      `2. Holders vote UP or DOWN (5 min voting window)`,
      `3. Bot executes the winning direction on Polymarket`,
      `4. Market resolves ~15 min later based on actual price movement`,
      ``,
      `**Payouts:**`,
      `Top 3 predictors by accuracy split 40% of profits weekly.`,
    ].join('\n'),
  })
}

export async function handleHistory(interaction) {
  const recentTrades = trades.getRecentResolved(10)

  if (recentTrades.length === 0) {
    await interaction.reply({
      content: '**No trade history yet**\n\nWait for trades to complete or use `/propose` to trigger one.',
      ephemeral: true,
    })
    return
  }

  const historyLines = recentTrades.map(trade => {
    const pnlStr = (trade.pnl || 0) >= 0
      ? `+$${(trade.pnl || 0).toFixed(2)}`
      : `-$${Math.abs(trade.pnl || 0).toFixed(2)}`
    const emoji = (trade.pnl || 0) >= 0 ? '✅' : '❌'
    const dateSource = trade.resolved_at || trade.executed_at
    const date = dateSource ? new Date(dateSource).toLocaleDateString() : 'Unknown'

    return `${emoji} ${trade.asset} ${trade.executed_position} → ${pnlStr} (${date})`
  })

  await interaction.reply({
    content: [
      `📜 **Recent Trades**`,
      ``,
      ...historyLines,
    ].join('\n'),
    ephemeral: true,
  })
}
