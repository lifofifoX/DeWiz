function round(value, decimals = 4) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const factor = 10 ** decimals
  return Math.round(num * factor) / factor
}

function mean(values) {
  if (!values.length) return null
  const sum = values.reduce((total, value) => total + value, 0)
  return sum / values.length
}

function stdDev(values) {
  if (values.length < 2) return null
  const avg = mean(values)
  if (avg === null) return null
  const variance = mean(values.map(value => (value - avg) ** 2))
  if (variance === null) return null
  return Math.sqrt(variance)
}

function percentChange(from, to) {
  const start = Number(from)
  const end = Number(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null
  return ((end - start) / start) * 100
}

function computeReturnsPct(closes, minutes) {
  if (!Array.isArray(closes) || closes.length < 2) return null
  if (closes.length <= minutes) return null
  const from = closes[closes.length - 1 - minutes]
  const to = closes[closes.length - 1]
  return percentChange(from, to)
}

function computeMinuteReturnsPct(closes) {
  const returns = []
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]
    const cur = closes[i]
    const change = percentChange(prev, cur)
    if (change === null) continue
    returns.push(change)
  }
  return returns
}

function computeRsi14(closes) {
  const period = 14
  if (closes.length < period + 1) return null

  let gains = 0
  let losses = 0

  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) {
      gains += diff
    } else {
      losses += Math.abs(diff)
    }
  }

  const avgGain = gains / period
  const avgLoss = losses / period

  if (avgLoss === 0) return 100
  if (avgGain === 0) return 0

  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

function computeEma(closes, period) {
  const n = Number(period)
  if (!Number.isFinite(n) || n <= 0) return null
  if (closes.length < n) return null

  const seed = mean(closes.slice(0, n))
  if (seed === null) return null

  const k = 2 / (n + 1)
  let ema = seed

  for (let i = n; i < closes.length; i += 1) {
    ema = closes[i] * k + ema * (1 - k)
  }

  return ema
}

function computeHighLow(candles) {
  let high = null
  let low = null

  for (const candle of candles) {
    const h = Number(candle.high)
    const l = Number(candle.low)
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue
    high = high === null ? h : Math.max(high, h)
    low = low === null ? l : Math.min(low, l)
  }

  return { high, low }
}

function computeVolumeRatio(candles, minutes = 5) {
  const window = Number(minutes)
  if (!Number.isFinite(window) || window <= 0) return null
  if (!candles.length) return null

  const volumes = candles.map(c => Number(c.volume)).filter(v => Number.isFinite(v) && v >= 0)
  if (volumes.length < window) return null

  const avg1m = mean(volumes)
  if (!avg1m || avg1m <= 0) return null

  const lastWindowSum = volumes.slice(-window).reduce((sum, v) => sum + v, 0)
  return lastWindowSum / (avg1m * window)
}

export function buildTechnicalSnapshot(candles, options = {}) {
  const lookbackMinutes = Number(options.lookbackMinutes) || 60
  const lastReturnsCount = Number(options.lastReturnsCount) || 8

  if (!Array.isArray(candles) || candles.length < 2) {
    return null
  }

  const closes = candles.map(c => Number(c.close)).filter(v => Number.isFinite(v) && v > 0)
  if (closes.length < 2) return null

  const lastPrice = closes[closes.length - 1]

  const rsi14 = computeRsi14(closes)
  const ema9 = computeEma(closes, 9)
  const ema21 = computeEma(closes, 21)

  const minuteReturns = computeMinuteReturnsPct(closes)
  const vol15m = minuteReturns.length >= 15 ? stdDev(minuteReturns.slice(-15)) : null
  const vol60m = minuteReturns.length >= 60 ? stdDev(minuteReturns.slice(-60)) : null

  const rangeCandles = candles.slice(-Math.min(lookbackMinutes, candles.length))
  const { high, low } = computeHighLow(rangeCandles)
  const range = high !== null && low !== null ? (high - low) : null
  const positionInRange = range && range > 0 ? (lastPrice - low) / range : null

  const volumeRatio5m = computeVolumeRatio(rangeCandles, 5)

  const returnsPct = {
    '5m': round(computeReturnsPct(closes, 5), 3),
    '15m': round(computeReturnsPct(closes, 15), 3),
    '60m': round(computeReturnsPct(closes, 60), 3),
  }

  const lastReturns = minuteReturns
    .slice(-lastReturnsCount)
    .map(value => round(value, 3))

  return {
    price: round(lastPrice, 2),
    returns_pct: returnsPct,
    rsi14: round(rsi14, 2),
    ema9: round(ema9, 2),
    ema21: round(ema21, 2),
    ema_trend: ema9 !== null && ema21 !== null ? (ema9 > ema21 ? 'bullish' : 'bearish') : null,
    volatility_pct: {
      '15m': round(vol15m, 3),
      '60m': round(vol60m, 3),
    },
    range_lookback: {
      high: round(high, 2),
      low: round(low, 2),
      position: positionInRange !== null ? round(positionInRange, 3) : null,
    },
    volume_ratio_5m: round(volumeRatio5m, 3),
    last_1m_returns_pct: lastReturns,
  }
}

