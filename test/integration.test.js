import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'

process.env.NODE_ENV = 'test'
process.env.TEST_MODE = 'true'

const dbPath = `./data/test-degenwizard-${Date.now()}.db`
process.env.DATABASE_PATH = dbPath

const configPath = `./data/test-config-${Date.now()}.yaml`
process.env.CONFIG_PATH = configPath
copyFileSync('./config.yaml', configPath)

const dbModule = await import('../src/database/index.js')
const {
  initializeDatabase,
  getDb,
  users,
  trades,
  predictions,
  runtimeState,
} = dbModule

initializeDatabase()

const { loadConfig } = await import('../src/config/index.js')
const { runWeeklyPayouts, getProfitSinceLastPayout } = await import('../src/services/payouts.js')
const { canStartTrade, setEmergencyStop } = await import('../src/services/scheduler.js')

const config = loadConfig()

after(() => {
  try {
    getDb().close()
  } catch {
    // ignore
  }

  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
  rmSync(configPath, { force: true })
})

function resetDatabase() {
  const db = getDb()
  db.exec(`
    DELETE FROM predictions;
    DELETE FROM payouts;
    DELETE FROM trades;
    DELETE FROM settlements;
    DELETE FROM users;
    UPDATE runtime_state SET emergency_stopped = 0 WHERE id = 1;
  `)
}

function createRng(seed) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min
}

function shuffledCopy(items, rng) {
  const copy = items.slice()
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

function pickVoters(userIds, count, rng) {
  const core = userIds.slice(0, 3)
  const rest = userIds.slice(3)
  const picked = shuffledCopy(rest, rng).slice(0, Math.max(0, count - core.length))
  return core.concat(picked)
}

function decidePosition(voteCounts, rng) {
  if (voteCounts.up > voteCounts.down) return 'UP'
  if (voteCounts.down > voteCounts.up) return 'DOWN'
  return rng() > 0.5 ? 'UP' : 'DOWN'
}

function calculatePnl(sharesFilled, totalCost, won) {
  const cost = Number(totalCost) || 0
  const shares = Number(sharesFilled) || 0

  if (won) {
    return { pnl: (shares * 1.0) - cost }
  }

  return { pnl: -cost }
}

function createFakeChannel() {
  const messages = []
  return {
    messages,
    async send(payload) {
      if (typeof payload === 'string') {
        messages.push(payload)
        return
      }
      messages.push(payload?.content || '')
    },
  }
}

function updateUserStatsForTrade(tradeId, correctPosition) {
  const tradePredictions = predictions.getSnapshottedByTrade(tradeId)
  for (const pred of tradePredictions) {
    const user = users.get(pred.user_id)
    if (!user) continue

    const wasCorrect = pred.prediction === correctPosition
    if (wasCorrect) {
      const newStreak = user.current_streak + 1
      const newBest = Math.max(user.best_streak, newStreak)
      users.updateStreak(user.discord_id, newStreak, newBest)
    } else {
      users.updateStreak(user.discord_id, 0, user.best_streak)
    }

    if (user.reputation_weight < 1.0) {
      const newWeight = Math.min(
        config.reputation.max_weight,
        user.reputation_weight + config.reputation.weight_increase_per_prediction
      )
      users.updateReputationWeight(user.discord_id, newWeight)
    }
  }
}

function updateConfigValue(path, value) {
  const doc = parseDocument(readFileSync(configPath, 'utf-8'))
  doc.setIn(path, value)
  writeFileSync(configPath, doc.toString())
}

test('integration', async (t) => {
  await t.test('end-to-end trade flow with payouts', async () => {
    resetDatabase()
    setEmergencyStop(false)

    const rng = createRng(424242)
    const userCount = 20
    const userIds = []

    for (let i = 0; i < userCount; i += 1) {
      const discordId = `user-${i + 1}`
      const username = `user${i + 1}`
      users.getOrCreate(discordId, username)
      const wallet = `0x${(i + 1).toString(16).padStart(40, '0')}`
      users.updateWalletAddress(discordId, wallet)
      userIds.push(discordId)
    }

    const tradeCount = 5
    const channel = createFakeChannel()
    const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'BTC']
    let totalVotes = 0
    let totalProfit = 0

    for (let i = 0; i < tradeCount; i += 1) {
      const trade = trades.createIfNoActive({
        asset: assets[i],
        polymarket_market_id: `market-${i + 1}`,
      })

      assert.ok(trade)
      trades.updateStatus(trade.id, 'voting')
      await channel.send({ content: `Trade ${trade.id} posted` })

      const voterCount = randInt(rng, 15, 20)
      const voters = pickVoters(userIds, voterCount, rng)
      const snapshotAt = new Date(Date.now() + i * 1000).toISOString()

      for (const voterId of voters) {
        const prediction = rng() > 0.5 ? 'UP' : 'DOWN'
        predictions.upsertWithSnapshot(voterId, trade.id, prediction, snapshotAt)
      }

      const voteCounts = predictions.getVoteCounts(trade.id)
      const voteTotal = voteCounts.up + voteCounts.down
      assert.equal(voteTotal, voterCount)
      totalVotes += voteTotal

      const position = decidePosition(voteCounts, rng)
      const conviction = Math.abs(voteCounts.up - voteCounts.down) / voteTotal
      const poolBalance = 1000
      const baseSize = poolBalance * config.trading.base_position_pct
      let positionSize = baseSize * (0.5 + conviction)
      positionSize = Math.min(positionSize, poolBalance * config.trading.max_position_pct)
      positionSize = Math.max(positionSize, poolBalance * config.trading.min_position_pct)

      const entryPrice = 0.5
      const sharesFilled = positionSize / entryPrice

      trades.execute(trade.id, position)
      await channel.send({ content: `Votes locked for trade ${trade.id}` })

      const weWon = rng() < 0.7 || i < 3
      const correctPosition = weWon ? position : (position === 'UP' ? 'DOWN' : 'UP')
      const { pnl } = calculatePnl(sharesFilled, positionSize, weWon)

      trades.resolve(trade.id, pnl)
      totalProfit += pnl
      predictions.markCorrectness(trade.id, correctPosition)
      updateUserStatsForTrade(trade.id, correctPosition)
    }

    assert.ok(totalProfit > 0)
    const updatedShare = 0.5
    updateConfigValue(['payouts', 'payout_share'], updatedShare)
    updateConfigValue(['payouts', 'min_payout_usd'], 1)

    await runWeeklyPayouts(channel)

    const resolvedTrades = trades.getRecentResolved(10)
    assert.equal(resolvedTrades.length, tradeCount)

    const db = getDb()
    const settlementRows = db.prepare('SELECT * FROM settlements').all()
    assert.equal(settlementRows.length, 1)
    assert.equal(settlementRows[0].status, 'completed')

    const payoutRows = db.prepare('SELECT * FROM payouts').all()
    assert.equal(payoutRows.length, 3)
    assert.ok(payoutRows.every(payout => payout.status === 'sent'))

    const payoutTotal = payoutRows.reduce((sum, payout) => sum + payout.amount, 0)
    const updatedConfig = loadConfig()
    const expectedTotal = Math.floor(totalProfit * updatedConfig.payouts.payout_share * 100) / 100
    assert.equal(payoutTotal.toFixed(2), expectedTotal.toFixed(2))

    const linkedTrades = db.prepare('SELECT COUNT(*) as count FROM trades WHERE settlement_id = ?')
      .get(settlementRows[0].id).count
    assert.equal(linkedTrades, tradeCount)

    const predictionRows = db.prepare('SELECT COUNT(*) as count FROM predictions WHERE snapshot_at IS NOT NULL').get()
    assert.equal(predictionRows.count, totalVotes)

    assert.equal(getProfitSinceLastPayout().toFixed(2), '0.00')
    assert.ok(channel.messages.some(message => message.includes('PAYOUT TIME')))
    assert.equal(runtimeState.getEmergencyStopped(), false)
  })

  await t.test('emergency stop blocks new trades', () => {
    resetDatabase()
    setEmergencyStop(true)

    const result = canStartTrade(false)
    assert.equal(result.allowed, false)
    assert.ok(result.reason && result.reason.toLowerCase().includes('emergency stop'))

    setEmergencyStop(false)
  })
})
