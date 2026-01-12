import Anthropic from '@anthropic-ai/sdk'
import { env, CONFIG } from '../config/index.js'
import { buildTechnicalSnapshot } from './ta.js'

let anthropicClient = null

function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
    })
  }
  return anthropicClient
}

/**
 * Get candle fetch parameters from config
 * Used by startTrade to fetch candles in parallel with markets
 */
export function getCandleParams() {
  const lookbackMinutes = Number(CONFIG.agents.ta.lookback_minutes)
  const candleInterval = CONFIG.agents.ta.candle_interval
  const lastReturnsCount = Number(CONFIG.agents.ta.last_returns_count)
  const candleLimit = lookbackMinutes + 1
  return { lookbackMinutes, candleInterval, lastReturnsCount, candleLimit }
}

/**
 * Analyze market conditions for trade proposal
 * @param {Object} options
 * @param {Object} options.marketsByAsset - Market data keyed by asset
 * @param {Object} options.candlesByAsset - Pre-fetched candles keyed by asset (BTC, ETH, SOL, XRP)
 */
export async function analyzeMarket({ marketsByAsset, candlesByAsset }) {
  const client = getClient()

  const assets = ['BTC', 'ETH', 'SOL', 'XRP']
  const { lookbackMinutes, lastReturnsCount, candleInterval } = getCandleParams()

  const priceData = {}
  const taData = {}

  for (const asset of assets) {
    const candles = candlesByAsset[asset]
    if (!candles || candles.length === 0) {
      throw new Error(`No candle data for ${asset}`)
    }

    const snapshot = buildTechnicalSnapshot(candles, {
      lookbackMinutes,
      lastReturnsCount,
    })
    if (!snapshot) {
      throw new Error(`Unable to build TA snapshot for ${asset}`)
    }

    taData[asset] = snapshot
    priceData[asset] = snapshot.price
  }

  const now = new Date()

  const marketTiming = {}
  for (const asset of assets) {
    const market = marketsByAsset[asset]
    if (!market?.start_time) {
      marketTiming[asset] = null
      continue
    }

    const start = market.start_time instanceof Date ? market.start_time : new Date(market.start_time)
    const startMs = start.getTime()
    const minutesToStart = Math.round((startMs - now.getTime()) / 60000)

    const end = market.resolution_time instanceof Date ? market.resolution_time : new Date(market.resolution_time)
    const endMs = end.getTime()

    marketTiming[asset] = {
      start_time_utc: start.toISOString(),
      end_time_utc: end.toISOString(),
      minutes_to_start: minutesToStart,
      minutes_to_end: Math.round((endMs - now.getTime()) / 60000),
    }
  }

  const prompt = `You are a crypto market analyst for a trading bot. Analyze the current market conditions for a 15-minute price prediction.

We are betting on simple 15-minute UP/DOWN markets that start at ~50/50 odds, so focus on short-horizon price action and technical signals (not market odds).

Market definition:
- Let T0 be the market start time (not "now"). Let P0 be the spot price at T0.
- Let P15 be the spot price at T0 + 15 minutes.
- "UP" means P15 > P0, "DOWN" means P15 < P0.
- We enter before T0, so the start price can differ from the current price.
- If the market starts in N minutes, you're effectively forecasting ~N+15 minutes from now.

Current time (UTC): ${now.toISOString()}

Upcoming market start times (UTC):
${JSON.stringify(marketTiming, null, 2)}

Current prices (USD):
- BTC: $${priceData.BTC.toLocaleString()}
- ETH: $${priceData.ETH.toLocaleString()}
- SOL: $${priceData.SOL.toLocaleString()}
- XRP: $${priceData.XRP.toLocaleString()}

Technical snapshot (computed from Binance ${candleInterval} candles, last ${lookbackMinutes} minutes):
${JSON.stringify(taData, null, 2)}

Consider:
1. Which asset has the clearest short-term momentum signal?
2. RSI (overbought/oversold) and EMA trend (ema9 vs ema21)
3. Volatility and volume spike risk for the next 15 minutes

Provide your analysis in this exact JSON format (no markdown, just JSON):
{
  "asset": "BTC" or "ETH" or "SOL" or "XRP",
  "direction": "UP" or "DOWN",
  "confidence": 0.0 to 1.0,
  "reasoning": "2-3 sentences explaining your analysis",
  "support": approximate support level,
  "resistance": approximate resistance level
}

Be concise.`


  const response = await client.messages.create({
    model: CONFIG.agents.model_fast,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  })

  const content = response.content[0]
  if (content.type !== 'text') {
    throw new Error('Unexpected response type')
  }

  const analysis = JSON.parse(content.text)

  return {
    asset: analysis.asset,
    current_price: priceData[analysis.asset],
    direction_bias: analysis.direction,
    confidence: analysis.confidence,
    reasoning: analysis.reasoning,
    key_levels: {
      support: analysis.support,
      resistance: analysis.resistance,
    },
  }
}
