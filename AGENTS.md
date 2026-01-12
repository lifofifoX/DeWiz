# DegenWizard

Polymarket 15m crypto prediction bot. Community votes → bot trades → weekly payouts (top 3 predictors split 40% profit).

## Tech
Node.js 24+ ES6, discord.js v14, better-sqlite3 (WAL), ethers v5, @polymarket/clob-client, Binance API, @anthropic-ai/sdk (claude-3-5-haiku)

## Files
- `src/services/scheduler.js` — Tick-based scheduling, trade lifecycle, `canStartTrade()`
- `src/services/polymarket.js` — CLOB/Gamma API, market resolution, order execution
- `src/database/index.js` — SQLite schema, all DB operations
- `src/bot/reactions.js` — Vote handling (🟢/🔴), wallet gating
- `src/services/payouts.js` — USDC payouts on Polygon
- `src/services/agents.js` — Claude AI market analysis, `analyzeMarket()`
- `src/services/ta.js` — Technical analysis (RSI14, MA, stdDev)
- `src/bot/commands/` — Slash commands (register, propose, emergency-stop, etc.)
- `config.yaml` — Bot config (voting window, min votes, etc.)

## Lifecycle
`voting` → `executed` → `resolved` (or deleted on fail)

Voting: Claude analyzes market, posts proposal, users react 🟢/🔴
Execute: Min votes required, CLOB order placed, conviction-based sizing
Resolve: Poll Polymarket for outcome, redeem tokens, update P&L

## DB Schema
- `discord_id` (TEXT) is `users` PK — no internal integer ID
- All FKs (`predictions.user_id`, `payouts.user_id`) store discord_id directly
- `trades.polymarket_market_id` REQUIRED for resolution — must store at creation
- `trades.voting_ends_at` stores when voting window closes — enables restart survival
- `predictions.snapshot_at` must be non-null to count (set at vote close)
- Weekly payouts: Sunday 18:00 in configured timezone, 40% profit, min $25

**Tables:** `users`, `settlements`, `trades`, `predictions`, `payouts`, `runtime_state`

## Gotchas
- `clobTokenIds[0]`=YES/UP, `[1]`=NO/DOWN (order critical)
- `clobTokenIds`, `outcomePrices` are JSON strings—parse them
- Emergency stop persists in `runtime_state`, survives restart
- SQLite: append 'Z' for `new Date()` parsing
- Conviction: `|upPct - downPct| / 100` scales position size
- Holder role checked at vote AND snapshot

## APIs

### Polymarket
- Series IDs: BTC=10192, ETH=10191, SOL=10423, XRP=10422
- Slug format: `btc-updown-15m-{unix_ts}`
- Tradeable: 0-20 min in future; `endDate` = resolution time
- USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- Allowance required: CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, NEG_RISK_ADAPTER

### Binance
- Symbols: `BTCUSDT`, `ETHUSDT` format
- Klines: `[time, open, high, low, close, volume, ...]`

## Errors
- Resolution never completes → polls indefinitely (manual intervention)
- Payout fails 5x → EMERGENCY STOP
- No market ID stored → EMERGENCY STOP (should never happen)
- Trade execution fails → cancel trade, post error to channel
- Claude analysis fails → random fallback from BTC/ETH/SOL/XRP

## Recovery
- Voting trades: resume via `voting_ends_at` in DB
- Executed trades: resolution polling resumes via tick loop
- Failed settlements: retry continues via periodic check
- Emergency stop: restored from DB
- Settlement retry: 5-min periodic check for failed payouts
- Scheduled trades: `last_morning_trade_date`, `next_hourly_trade_at`, `last_weekly_payout_date` in `runtime_state`

## Security
- NEVER log/expose/commit `WALLET_PRIVATE_KEY`
- NEVER hardcode wallet addresses — use env vars or DB
- ALWAYS validate addresses via `ethers.isAddress()` before transactions
- Payout amounts MUST come from DB calculations, never user input

## Env
**Required:** `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `WALLET_PRIVATE_KEY`, `POLYGON_RPC_URL`, `ANTHROPIC_API_KEY`
**Optional:** `DATABASE_PATH` (default: `./data/degenwizard.db`), `PROXY_URL`

## Code Style
ES6 JavaScript, no TypeScript, no semicolons
