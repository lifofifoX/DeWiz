import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import { env } from '../config/index.js'

let db = null

function getUtcTimestamp() {
  return new Date().toISOString()
}

function normalizeTimestamp(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return value
}

export function getDb() {
  if (!db) {
    const dbPath = env.DATABASE_PATH
    const dbDir = dirname(dbPath)

    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

export function initializeDatabase() {
  const database = getDb()

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY NOT NULL,
      discord_username TEXT,
      wallet_address TEXT,
      reputation_weight REAL NOT NULL DEFAULT 0.1,
      current_streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'pending',
      triggered_at TIMESTAMP NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id INTEGER REFERENCES settlements(id),
      asset TEXT NOT NULL,
      polymarket_market_id TEXT NOT NULL,
      proposal_message_id TEXT,
      clob_order_id TEXT,
      executed_position TEXT,
      pnl REAL,
      resolution_time TIMESTAMP,
      voting_ends_at TIMESTAMP NOT NULL,
      status TEXT NOT NULL DEFAULT 'voting',
      executed_at TIMESTAMP,
      resolved_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(discord_id),
      trade_id INTEGER NOT NULL REFERENCES trades(id),
      prediction TEXT NOT NULL,
      was_correct BOOLEAN,
      snapshot_at TIMESTAMP,
      UNIQUE(user_id, trade_id)
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(discord_id),
      settlement_id INTEGER REFERENCES settlements(id),
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      tx_request TEXT,
      rank INTEGER NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_at TIMESTAMP,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS runtime_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      emergency_stopped INTEGER NOT NULL DEFAULT 0,
      last_morning_trade_date TEXT NOT NULL DEFAULT '1970-01-01',
      next_hourly_trade_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      last_weekly_payout_date TEXT NOT NULL DEFAULT '1970-01-01'
    );

    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_settlement_id ON trades(settlement_id);
    CREATE INDEX IF NOT EXISTS idx_trades_resolved_at ON trades(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_trades_clob_order_id ON trades(clob_order_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_user_id ON predictions(user_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_trade_id ON predictions(trade_id);
    CREATE INDEX IF NOT EXISTS idx_payouts_user_id ON payouts(user_id);
    CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
    CREATE INDEX IF NOT EXISTS idx_payouts_settlement_id ON payouts(settlement_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet_address_ci ON users(LOWER(wallet_address)) WHERE wallet_address IS NOT NULL;

    INSERT OR IGNORE INTO runtime_state (id, emergency_stopped) VALUES (1, 0);
  `)

  console.log('Database initialized successfully')
}

// User operations (discord_id is the primary key)
export const users = {
  get(discordId) {
    const stmt = getDb().prepare('SELECT * FROM users WHERE discord_id = ?')
    return stmt.get(discordId)
  },

  create(discordId, username) {
    const stmt = getDb().prepare(`
      INSERT INTO users (discord_id, discord_username)
      VALUES (?, ?)
      RETURNING *
    `)
    return stmt.get(discordId, username || null)
  },

  getOrCreate(discordId, username) {
    const existing = this.get(discordId)
    if (existing) {
      if (username && existing.discord_username !== username) {
        getDb().prepare('UPDATE users SET discord_username = ? WHERE discord_id = ?')
          .run(username, discordId)
        existing.discord_username = username
      }
      return existing
    }
    return this.create(discordId, username)
  },

  updateWalletAddress(discordId, address) {
    getDb().prepare('UPDATE users SET wallet_address = ? WHERE discord_id = ?')
      .run(address, discordId)
  },

  isWalletInUse(address, excludeDiscordId = null) {
    const stmt = excludeDiscordId
      ? getDb().prepare('SELECT discord_id FROM users WHERE LOWER(wallet_address) = LOWER(?) AND discord_id != ?')
      : getDb().prepare('SELECT discord_id FROM users WHERE LOWER(wallet_address) = LOWER(?)')
    const result = excludeDiscordId ? stmt.get(address, excludeDiscordId) : stmt.get(address)
    return !!result
  },

  updateReputationWeight(discordId, weight) {
    getDb().prepare('UPDATE users SET reputation_weight = ? WHERE discord_id = ?')
      .run(weight, discordId)
  },

  updateStreak(discordId, current, best) {
    getDb().prepare('UPDATE users SET current_streak = ?, best_streak = ? WHERE discord_id = ?')
      .run(current, best, discordId)
  },

  getStats(discordId) {
    const predStats = getDb().prepare(`
      SELECT
        COUNT(*) as total_predictions,
        COUNT(CASE WHEN was_correct = 1 THEN 1 END) as correct_predictions
      FROM predictions
      WHERE user_id = ? AND snapshot_at IS NOT NULL
    `).get(discordId)

    const earnedStats = getDb().prepare(`
      SELECT COALESCE(SUM(amount), 0) as total_earned
      FROM payouts
      WHERE user_id = ? AND status = 'sent'
    `).get(discordId)

    return {
      totalPredictions: predStats?.total_predictions || 0,
      correctPredictions: predStats?.correct_predictions || 0,
      totalEarned: earnedStats?.total_earned || 0,
    }
  },

  getTopPredictors(limit = 10) {
    const stmt = getDb().prepare(`
      SELECT u.*,
             COUNT(CASE WHEN p.was_correct = 1 THEN 1 END) as correct_predictions,
             COUNT(*) as total_predictions
      FROM users u
      JOIN predictions p ON u.discord_id = p.user_id
      WHERE p.snapshot_at IS NOT NULL
      GROUP BY u.discord_id
      HAVING total_predictions > 0
      ORDER BY
        (CAST(correct_predictions AS REAL) / NULLIF(total_predictions, 0)) * u.reputation_weight DESC,
        total_predictions DESC
      LIMIT ?
    `)
    return stmt.all(limit)
  },

  getTopPredictorsForTrades(tradeIds, limit = 3) {
    if (tradeIds.length === 0) return []

    const placeholders = tradeIds.map(() => '?').join(',')
    const stmt = getDb().prepare(`
      SELECT u.*, COUNT(CASE WHEN p.was_correct = 1 THEN 1 END) as correct_count,
             COUNT(*) as total_count
      FROM users u
      JOIN predictions p ON u.discord_id = p.user_id
      WHERE p.trade_id IN (${placeholders})
        AND p.snapshot_at IS NOT NULL
        AND u.wallet_address IS NOT NULL
      GROUP BY u.discord_id
      ORDER BY
        correct_count DESC,
        u.reputation_weight DESC,
        total_count DESC,
        u.discord_id ASC
      LIMIT ?
    `)
    return stmt.all(...tradeIds, limit)
  },
}

export const trades = {
  /**
   * Atomically check for active trade and create new one if none exists.
   * Prevents race condition where two trades could be created simultaneously.
   * @returns {object|null} The created trade, or null if an active trade already exists
   */
  createIfNoActive(params) {
    const db = getDb()
    const transaction = db.transaction(() => {
      const active = db.prepare(`
        SELECT id FROM trades
        WHERE status IN ('voting', 'executed')
        LIMIT 1
      `).get()

      if (active) {
        return null
      }

      const incompleteSettlement = db.prepare(`
        SELECT id FROM settlements
        WHERE status != 'completed'
        LIMIT 1
      `).get()

      if (incompleteSettlement) {
        return null
      }

      return db.prepare(`
        INSERT INTO trades (
          asset, polymarket_market_id, resolution_time, voting_ends_at
        )
        VALUES (?, ?, ?, ?)
        RETURNING *
      `).get(
        params.asset,
        params.polymarket_market_id || null,
        normalizeTimestamp(params.resolution_time),
        normalizeTimestamp(params.voting_ends_at)
      )
    })

    return transaction()
  },

  getActive() {
    const stmt = getDb().prepare(`
      SELECT * FROM trades
      WHERE status IN ('voting', 'executed')
      LIMIT 1
    `)
    return stmt.get()
  },

  getLastResolved() {
    const stmt = getDb().prepare(`
      SELECT * FROM trades
      WHERE status = 'resolved'
      ORDER BY resolved_at DESC
      LIMIT 1
    `)
    return stmt.get()
  },

  getById(id) {
    const stmt = getDb().prepare('SELECT * FROM trades WHERE id = ?')
    return stmt.get(id)
  },

  getByMessageId(messageId) {
    const stmt = getDb().prepare('SELECT * FROM trades WHERE proposal_message_id = ?')
    return stmt.get(messageId)
  },

  updateMessageId(id, messageId) {
    getDb().prepare('UPDATE trades SET proposal_message_id = ? WHERE id = ?')
      .run(messageId, id)
  },

  updateStatus(id, status) {
    getDb().prepare('UPDATE trades SET status = ? WHERE id = ?')
      .run(status, id)
  },

  getVotingTrades() {
    return getDb().prepare(`
      SELECT * FROM trades
      WHERE status = 'voting'
      ORDER BY voting_ends_at ASC
    `).all()
  },

  updateOrderId(id, orderId) {
    getDb().prepare('UPDATE trades SET clob_order_id = ? WHERE id = ?')
      .run(orderId, id)
  },

  execute(id, position) {
    getDb().prepare(`
      UPDATE trades SET
        executed_position = ?,
        status = 'executed',
        executed_at = ?
      WHERE id = ?
    `).run(position, getUtcTimestamp(), id)
  },

  resolve(id, pnl) {
    getDb().prepare(`
      UPDATE trades SET
        pnl = ?,
        status = 'resolved',
        resolved_at = ?
      WHERE id = ?
    `).run(pnl, getUtcTimestamp(), id)
  },

  getRecentResolved(limit = 20) {
    const stmt = getDb().prepare(`
      SELECT * FROM trades
      WHERE status = 'resolved'
      ORDER BY resolved_at DESC
      LIMIT ?
    `)
    return stmt.all(limit)
  },

  getAllExecuted() {
    const stmt = getDb().prepare(`
      SELECT * FROM trades
      WHERE status = 'executed'
      ORDER BY executed_at ASC
    `)
    return stmt.all()
  },

  getReadyForResolution() {
    const stmt = getDb().prepare(`
      SELECT * FROM trades
      WHERE status = 'executed'
        AND resolution_time IS NOT NULL
        AND datetime(resolution_time) <= datetime('now')
      ORDER BY resolution_time ASC
    `)
    return stmt.all()
  },

  getUnsettledPnl() {
    const result = getDb().prepare(`
      SELECT COALESCE(SUM(pnl), 0) as total
      FROM trades
      WHERE status = 'resolved' AND settlement_id IS NULL
    `).get()
    return result?.total || 0
  },

  getTotalPnl() {
    const result = getDb().prepare(`
      SELECT COALESCE(SUM(pnl), 0) as total
      FROM trades
      WHERE status = 'resolved'
    `).get()
    return result?.total || 0
  },

  getUnsettledTrades() {
    return getDb().prepare(`
      SELECT * FROM trades
      WHERE status = 'resolved' AND settlement_id IS NULL
      ORDER BY resolved_at ASC
    `).all()
  },

  linkToSettlement(tradeIds, settlementId) {
    if (tradeIds.length === 0) return
    const placeholders = tradeIds.map(() => '?').join(',')
    getDb().prepare(`
      UPDATE trades SET settlement_id = ?
      WHERE id IN (${placeholders})
    `).run(settlementId, ...tradeIds)
  },

  deleteTrade(id) {
    const db = getDb()
    db.transaction(() => {
      db.prepare('DELETE FROM predictions WHERE trade_id = ?').run(id)
      db.prepare('DELETE FROM trades WHERE id = ?').run(id)
    })()
  },
}

export const predictions = {
  upsert(userId, tradeId, prediction) {
    const stmt = getDb().prepare(`
      INSERT INTO predictions (user_id, trade_id, prediction)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, trade_id) DO UPDATE SET
        prediction = excluded.prediction
      RETURNING *
    `)
    return stmt.get(userId, tradeId, prediction)
  },

  upsertWithSnapshot(userId, tradeId, prediction, snapshotAt) {
    const stmt = getDb().prepare(`
      INSERT INTO predictions (user_id, trade_id, prediction, snapshot_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, trade_id) DO UPDATE SET
        prediction = excluded.prediction,
        snapshot_at = excluded.snapshot_at
      RETURNING *
    `)
    return stmt.get(userId, tradeId, prediction, snapshotAt)
  },

  getVoteCounts(tradeId) {
    const result = getDb().prepare(`
      SELECT
        COUNT(CASE WHEN prediction = 'UP' THEN 1 END) as up,
        COUNT(CASE WHEN prediction = 'DOWN' THEN 1 END) as down
      FROM predictions
      WHERE trade_id = ? AND snapshot_at IS NOT NULL
    `).get(tradeId)
    return { up: result?.up || 0, down: result?.down || 0 }
  },

  getSnapshottedByTrade(tradeId) {
    const stmt = getDb().prepare('SELECT * FROM predictions WHERE trade_id = ? AND snapshot_at IS NOT NULL')
    return stmt.all(tradeId)
  },

  markCorrectness(tradeId, correctPosition) {
    getDb().prepare(`
      UPDATE predictions SET was_correct = (prediction = ?)
      WHERE trade_id = ? AND snapshot_at IS NOT NULL
    `).run(correctPosition, tradeId)
  },

  deleteNonSnapshotted(tradeId) {
    getDb().prepare('DELETE FROM predictions WHERE trade_id = ? AND snapshot_at IS NULL').run(tradeId)
  },
}

export const payouts = {
  create(userId, amount, rank, settlementId = null) {
    const stmt = getDb().prepare(`
      INSERT INTO payouts (user_id, amount, rank, settlement_id)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `)
    return stmt.get(userId, amount, rank, settlementId)
  },

  updateStatus(id, status) {
    getDb().prepare('UPDATE payouts SET status = ? WHERE id = ?')
      .run(status, id)
  },

  updateTxHash(id, txHash) {
    getDb().prepare('UPDATE payouts SET tx_hash = ? WHERE id = ?')
      .run(txHash, id)
  },

  updateTxRequest(id, txRequest) {
    getDb().prepare('UPDATE payouts SET tx_request = ? WHERE id = ?')
      .run(txRequest, id)
  },

  getById(id) {
    const stmt = getDb().prepare('SELECT * FROM payouts WHERE id = ?')
    return stmt.get(id)
  },

  getFailedBySettlement(settlementId) {
    const stmt = getDb().prepare(`
      SELECT * FROM payouts
      WHERE settlement_id = ? AND status = 'failed'
    `)
    return stmt.all(settlementId)
  },

  getBySettlement(settlementId) {
    const stmt = getDb().prepare('SELECT * FROM payouts WHERE settlement_id = ?')
    return stmt.all(settlementId)
  },

  incrementRetry(id, errorMessage) {
    return getDb().prepare(`
      UPDATE payouts SET
        retry_count = retry_count + 1,
        last_retry_at = ?,
        error_message = ?
      WHERE id = ?
      RETURNING *
    `).get(getUtcTimestamp(), errorMessage, id)
  },

  getTotalDistributed() {
    const result = getDb().prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payouts
      WHERE status = 'sent'
    `).get()
    return result?.total || 0
  },
}

export const settlements = {
  create() {
    const stmt = getDb().prepare(`
      INSERT INTO settlements (status, triggered_at)
      VALUES ('pending', ?)
      RETURNING *
    `)
    return stmt.get(getUtcTimestamp())
  },

  getById(id) {
    const stmt = getDb().prepare('SELECT * FROM settlements WHERE id = ?')
    return stmt.get(id)
  },

  updateStatus(id, status, errorMessage = null) {
    getDb().prepare(`
      UPDATE settlements SET status = ?, error_message = ?
      WHERE id = ?
    `).run(status, errorMessage, id)
  },

  getIncomplete() {
    const stmt = getDb().prepare("SELECT * FROM settlements WHERE status != 'completed' ORDER BY triggered_at ASC")
    return stmt.all()
  },
}

export const runtimeState = {
  getEmergencyStopped() {
    const row = getDb().prepare('SELECT emergency_stopped FROM runtime_state WHERE id = 1').get()
    return row?.emergency_stopped === 1
  },

  setEmergencyStopped(stopped) {
    getDb().prepare(`
      INSERT INTO runtime_state (id, emergency_stopped)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET emergency_stopped = excluded.emergency_stopped
    `).run(stopped ? 1 : 0)
  },

  getScheduleState() {
    return getDb().prepare('SELECT * FROM runtime_state WHERE id = 1').get()
  },

  setLastMorningTradeDate(dateStr) {
    getDb().prepare(`
      UPDATE runtime_state SET last_morning_trade_date = ? WHERE id = 1
    `).run(dateStr)
  },

  setNextHourlyTradeAt(timestamp) {
    getDb().prepare(`
      UPDATE runtime_state SET next_hourly_trade_at = ? WHERE id = 1
    `).run(timestamp)
  },

  setLastWeeklyPayoutDate(dateStr) {
    getDb().prepare(`
      UPDATE runtime_state SET last_weekly_payout_date = ? WHERE id = 1
    `).run(dateStr)
  },
}
