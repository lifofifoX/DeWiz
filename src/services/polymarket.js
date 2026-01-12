import { ClobClient, Side, OrderType } from '@polymarket/clob-client'
import { ethers } from 'ethers'
import { env } from '../config/index.js'
import { checkGasBalance } from '../utils/gas.js'
import { fetchWithRetry } from '../utils/fetch.js'

const GAMMA_API = 'https://gamma-api.polymarket.com'
const CLOB_API = 'https://clob.polymarket.com'
const DATA_API = 'https://data-api.polymarket.com'

const POLYGON_CHAIN_ID = 137

// Polymarket contract addresses
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
]

const MIN_ALLOWANCE = ethers.utils.parseUnits('1000', 6)

let cachedProvider = null
let cachedWallet = null

function getProvider() {
  if (!cachedProvider) {
    cachedProvider = new ethers.providers.JsonRpcProvider(env.POLYGON_RPC_URL)
  }
  return cachedProvider
}

function getWallet() {
  if (!env.WALLET_PRIVATE_KEY) {
    throw new Error('WALLET_PRIVATE_KEY not configured')
  }
  if (!cachedWallet) {
    cachedWallet = new ethers.Wallet(env.WALLET_PRIVATE_KEY, getProvider())
  }
  return cachedWallet
}

async function createClobClient() {
  const wallet = getWallet()
  const tempClient = new ClobClient(CLOB_API, POLYGON_CHAIN_ID, wallet)
  const creds = await tempClient.deriveApiKey()
  const client = new ClobClient(CLOB_API, POLYGON_CHAIN_ID, wallet, creds)
  console.log('[POLYMARKET] CLOB client created with derived API key')
  return client
}

async function ensureAllowance() {
  const wallet = getWallet()
  const provider = getProvider()
  const usdc = new ethers.Contract(USDC_E, ERC20_ABI, wallet)
  const contracts = [CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE, NEG_RISK_ADAPTER]
  const maxApproval = ethers.constants.MaxUint256

  for (const contract of contracts) {
    const allowance = await usdc.allowance(wallet.address, contract)
    if (allowance.lt(MIN_ALLOWANCE)) {
      console.log(`[POLYMARKET] Setting USDC allowance for ${contract}`)
      try {
        const gasPrice = await provider.getGasPrice()
        const boostedGasPrice = gasPrice.mul(120).div(100)
        const tx = await usdc.approve(contract, maxApproval, {
          gasLimit: 100000,
          gasPrice: boostedGasPrice,
        })
        console.log(`[POLYMARKET] Approval tx sent: ${tx.hash}`)
        const receipt = await tx.wait(1)
        console.log(`[POLYMARKET] Allowance set for ${contract} (block ${receipt.blockNumber})`)
      } catch (error) {
        console.error(`[POLYMARKET] Failed to set allowance for ${contract}:`, error.message)
        return false
      }
    }
  }
  return true
}

function getWalletAddress() {
  return getWallet().address
}

/**
 * Get actual P&L for a position from Polymarket data API
 * This accounts for fees automatically
 */
export async function getPositionPnl(conditionId) {
  const walletAddress = getWalletAddress()
  const response = await fetchWithRetry(
    `${DATA_API}/positions?user=${walletAddress}&sizeThreshold=0`,
    { headers: { 'Accept': 'application/json' } }
  )

  if (!response.ok) {
    throw new Error(`Data API error: ${response.status}`)
  }

  const positions = await response.json()
  const position = positions.find(p => p.conditionId === conditionId)

  if (!position) {
    throw new Error(`Position not found for conditionId: ${conditionId}`)
  }

  console.log(`[POLYMARKET] Position P&L from API: cashPnl=${position.cashPnl}, percentPnl=${position.percentPnl}`)

  return {
    pnl: position.cashPnl,
    pnlPercent: position.percentPnl,
  }
}

async function getTokenBalances(tokenIds) {
  const wallet = getWallet()
  const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, getProvider())
  const balances = await Promise.all(
    tokenIds.map(id => ctf.balanceOf(wallet.address, id))
  )
  return balances
}

export async function redeemWinnings(conditionId, tokenIds) {
  console.log(`[POLYMARKET] Redeeming position for conditionId: ${conditionId}`)

  const [upBalance, downBalance] = await getTokenBalances(tokenIds)
  console.log(`[POLYMARKET] Token balances - UP: ${ethers.utils.formatUnits(upBalance, 6)}, DOWN: ${ethers.utils.formatUnits(downBalance, 6)}`)

  // 1=UP, 2=DOWN
  const indexSets = []
  if (!upBalance.isZero()) indexSets.push(1)
  if (!downBalance.isZero()) indexSets.push(2)

  if (indexSets.length === 0) {
    console.log(`[POLYMARKET] No tokens to redeem`)
    return { txHash: null, blockNumber: null }
  }

  console.log(`[POLYMARKET] Redeeming indexSets: [${indexSets.join(', ')}]`)

  const wallet = getWallet()
  const provider = getProvider()
  const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, wallet)

  const gasPrice = await provider.getGasPrice()
  const boostedGasPrice = gasPrice.mul(120).div(100)

  const tx = await ctf.redeemPositions(
    USDC_E,
    ethers.constants.HashZero,
    conditionId,
    indexSets,
    { gasLimit: 200000, gasPrice: boostedGasPrice }
  )

  console.log(`[POLYMARKET] Redeem tx sent: ${tx.hash}`)

  const receipt = await tx.wait(1)
  console.log(`[POLYMARKET] Redeem confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`)

  return { txHash: tx.hash, blockNumber: receipt.blockNumber }
}

// Series IDs for 15M crypto markets
const SERIES_IDS = {
  BTC: 10192,
  ETH: 10191,
  SOL: 10423,
  XRP: 10422,
}

export async function find15MinuteMarkets() {
  try {
    const results = await Promise.all(
      Object.entries(SERIES_IDS).map(async ([asset, seriesId]) => {
        const response = await fetchWithRetry(
          `${GAMMA_API}/events?series_id=${seriesId}&closed=false&limit=10`,
          { headers: { 'Accept': 'application/json' } }
        )
        return response.ok ? await response.json() : []
      })
    )
    const allEvents = results.flat()

    const now = Date.now()
    const cryptoMarkets = []

    for (const event of allEvents) {
      const slug = event.slug?.toLowerCase() || ''

      const asset = detectAsset(slug)
      if (!asset) continue

      const market = event.markets?.[0]
      if (!market) continue

      const startMatch = slug.match(/-(\d{10})$/)
      const startTime = startMatch ? parseInt(startMatch[1]) * 1000 : 0

      if (startTime < now) continue

      const maxStartTime = now + 20 * 60 * 1000
      if (startTime > maxStartTime) continue

      const endDate = new Date(market.endDate || event.endDate)
      if (endDate.getTime() < now) continue

      // clobTokenIds and outcomePrices are JSON strings in the API response
      let tokenIds
      try {
        const parsedIds = typeof market.clobTokenIds === 'string'
          ? JSON.parse(market.clobTokenIds)
          : market.clobTokenIds
        if (!parsedIds || parsedIds.length < 2) continue
        tokenIds = { yes: parsedIds[0], no: parsedIds[1] }
      } catch {
        continue
      }

      let yesPriceVal = 0.5, noPriceVal = 0.5
      try {
        const prices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices)
          : market.outcomePrices
        if (prices?.length >= 2) {
          yesPriceVal = parseFloat(prices[0]) || 0.5
          noPriceVal = parseFloat(prices[1]) || 0.5
        }
      } catch {
        // Use defaults
      }

      cryptoMarkets.push({
        id: market.id,
        slug: event.slug,
        question: market.question || event.title,
        asset,
        yes_price: yesPriceVal,
        no_price: noPriceVal,
        volume: market.volumeNum || parseFloat(market.volume) || 0,
        liquidity: market.liquidityNum || parseFloat(market.liquidity) || 0,
        start_time: new Date(startTime),
        resolution_time: endDate,
        tokenIds,
        conditionId: market.conditionId,
      })
    }

    cryptoMarkets.sort((a, b) => a.start_time - b.start_time)

    console.log(`[POLYMARKET] Found ${cryptoMarkets.length} active 15M crypto markets`)
    return cryptoMarkets

  } catch (error) {
    console.error('[POLYMARKET] Error fetching markets:', error)
    return []
  }
}

export async function get15MinuteMarket(asset) {
  const markets = await find15MinuteMarkets()
  return markets.find(m => m.asset === asset) || null
}

async function getOrderbook(tokenId) {
  try {
    const response = await fetchWithRetry(
      `${CLOB_API}/book?token_id=${tokenId}`,
      { headers: { 'Accept': 'application/json' } }
    )

    if (!response.ok) {
      throw new Error(`CLOB orderbook error: ${response.status}`)
    }

    return await response.json()
  } catch (error) {
    console.error('[POLYMARKET] Error fetching orderbook:', error)
    return { bids: [], asks: [] }
  }
}

const MIN_ORDER_SIZE_USD = 1

export async function executeTrade(market, position, sizeUsd) {
  console.log(`[POLYMARKET] Executing ${position} trade on ${market.asset} for $${sizeUsd}`)

  if (sizeUsd < MIN_ORDER_SIZE_USD) {
    console.error(`[POLYMARKET] Order size $${sizeUsd} below minimum $${MIN_ORDER_SIZE_USD}`)
    return { success: false, reason: `Order size below minimum ($${MIN_ORDER_SIZE_USD})` }
  }

  if (!await checkGasBalance()) {
    console.error('[POLYMARKET] Insufficient MATIC for gas')
    return { success: false, reason: 'Insufficient MATIC for gas' }
  }

  if (!await ensureAllowance()) {
    console.error('[POLYMARKET] Failed to set USDC allowance')
    return { success: false, reason: 'Failed to set USDC allowance' }
  }

  try {
    const client = await createClobClient()

    const tokenId = position === 'UP'
      ? market.tokenIds.yes
      : market.tokenIds.no

    const orderbook = await getOrderbook(tokenId)
    const bestAsk = parseFloat(orderbook.asks[0]?.price) || 0.5

    const requestedShares = sizeUsd / bestAsk

    if (!Number.isFinite(requestedShares) || !Number.isFinite(sizeUsd)) {
      console.error(`[POLYMARKET] Invalid values: sizeUsd=${sizeUsd}, bestAsk=${bestAsk}, shares=${requestedShares}`)
      return { success: false, reason: 'Invalid order parameters' }
    }

    // Place order with price above best ask to ensure fill (FOK would be better but use GTC with aggressive price)
    // Round to tick size (0.01) to avoid precision errors
    const rawPrice = Math.min(0.99, bestAsk * 1.01) // 1% slippage tolerance
    const limitPrice = Math.round(rawPrice * 100) / 100
    const order = await client.createAndPostOrder({
      tokenID: tokenId,
      price: limitPrice,
      side: Side.BUY,
      size: requestedShares,
    }, {
      tickSize: '0.01',
      negRisk: false,
    }, OrderType.GTC)

    if (!order?.orderID) {
      console.error('[POLYMARKET] Order creation failed - no orderID returned')
      return { success: false, reason: 'Order creation failed' }
    }

    const orderID = order.orderID

    console.log(`[POLYMARKET] Order placed: ${orderID}`)

    const fillData = await waitForOrderFill(client, orderID, tokenId, 30000)

    if (!fillData.filled) {
      try {
        await client.cancelOrder({ orderID })
        console.log(`[POLYMARKET] Cancelled unfilled order ${orderID}`)
      } catch (cancelErr) {
        console.error(`[POLYMARKET] Failed to cancel order:`, cancelErr)
      }
      return {
        success: false,
        reason: 'Order did not fill within timeout',
      }
    }

    if (fillData.partial) {
      try {
        await client.cancelOrder({ orderID })
        console.log(`[POLYMARKET] Cancelled remaining size for partially filled order ${orderID}`)
      } catch (cancelErr) {
        console.error(`[POLYMARKET] Failed to cancel remaining size:`, cancelErr)
      }
    }

    const fillLabel = fillData.partial ? 'partially filled' : 'filled'
    console.log(`[POLYMARKET] Order ${fillLabel}: ${fillData.sharesFilled} shares @ avg $${fillData.avgPrice.toFixed(4)}`)

    return {
      success: true,
      orderID,
      sharesFilled: fillData.sharesFilled,
      avgFillPrice: fillData.avgPrice,
      totalCost: fillData.totalCost,
      partial: fillData.partial,
    }
  } catch (error) {
    console.error('[POLYMARKET] Trade execution failed:', error)
    return {
      success: false,
      reason: error.message,
    }
  }
}

function isTradeForOrder(trade, orderId) {
  if (trade.taker_order_id === orderId) return true
  if (Array.isArray(trade.maker_orders)) {
    return trade.maker_orders.some(order => order.order_id === orderId)
  }
  return false
}

async function getOrderFillData(client, tokenId, orderId, sizeMatched, fallbackPrice) {
  try {
    const trades = await client.getTrades({ asset_id: tokenId }, true)
    const orderTrades = trades.filter(trade => isTradeForOrder(trade, orderId))

    if (orderTrades.length > 0) {
      let totalShares = 0
      let totalCost = 0

      for (const trade of orderTrades) {
        const shares = parseFloat(trade.size)
        const price = parseFloat(trade.price)
        if (!Number.isFinite(shares) || !Number.isFinite(price)) continue
        totalShares += shares
        totalCost += shares * price
      }

      if (totalShares > 0) {
        const avgPrice = totalCost / totalShares
        return { sharesFilled: totalShares, avgPrice, totalCost }
      }
    }
  } catch (error) {
    console.error('[POLYMARKET] Error fetching trades for fill data:', error)
  }

  const safePrice = Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : 0
  return {
    sharesFilled: sizeMatched,
    avgPrice: safePrice,
    totalCost: sizeMatched * safePrice,
  }
}

async function waitForOrderFill(client, orderId, tokenId, timeoutMs = 30000) {
  const startTime = Date.now()
  const pollIntervalMs = 2000

  while (Date.now() - startTime < timeoutMs) {
    try {
      const order = await client.getOrder(orderId)
      const sizeMatched = parseFloat(order.size_matched || '0')
      const originalSize = parseFloat(order.original_size || '0')
      const fallbackPrice = parseFloat(order.price) || 0

      if (sizeMatched > 0) {
        const fillData = await getOrderFillData(client, tokenId, orderId, sizeMatched, fallbackPrice)
        const partial = originalSize > 0 ? sizeMatched < originalSize : false
        return {
          filled: true,
          ...fillData,
          partial,
        }
      }

      if (order.status === 'FILLED') {
        const sharesFilled = parseFloat(order.size_matched || order.original_size) || 0
        const avgPrice = parseFloat(order.price) || 0
        return {
          filled: true,
          sharesFilled,
          avgPrice,
          totalCost: sharesFilled * avgPrice,
          partial: false,
        }
      }

      if (order.status === 'CANCELLED' || order.status === 'EXPIRED') {
        return { filled: false }
      }

    } catch (err) {
      console.error(`[POLYMARKET] Error checking order status:`, err)
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }

  try {
    const order = await client.getOrder(orderId)
    const sizeMatched = parseFloat(order.size_matched || '0')
    const originalSize = parseFloat(order.original_size || '0')
    const fallbackPrice = parseFloat(order.price) || 0

    if (sizeMatched > 0) {
      const fillData = await getOrderFillData(client, tokenId, orderId, sizeMatched, fallbackPrice)
      const partial = originalSize > 0 ? sizeMatched < originalSize : false
      return {
        filled: true,
        ...fillData,
        partial,
      }
    }
  } catch (error) {
    console.error('[POLYMARKET] Error checking final order status:', error)
  }

  return { filled: false }
}

const BINANCE_SYMBOLS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
}

export async function getCurrentPrice(asset) {
  const symbol = BINANCE_SYMBOLS[asset]
  if (!symbol) {
    console.error('[POLYMARKET] Unknown asset for price:', asset)
    return 0
  }

  try {
    const response = await fetchWithRetry(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      { headers: { 'Accept': 'application/json' } }
    )

    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status}`)
    }

    const data = await response.json()
    return parseFloat(data.price) || 0
  } catch (error) {
    console.error('[POLYMARKET] Error fetching price:', error)
    return 0
  }
}

export async function getRecentCandles(asset, interval = '1m', limit = 60) {
  const symbol = BINANCE_SYMBOLS[asset]
  if (!symbol) {
    console.error('[BINANCE] Unknown asset for candles:', asset)
    return []
  }

  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 60))

  try {
    const response = await fetchWithRetry(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}`,
      { headers: { 'Accept': 'application/json' } }
    )

    if (!response.ok) {
      throw new Error(`Binance klines error: ${response.status}`)
    }

    const data = await response.json()
    if (!Array.isArray(data)) {
      return []
    }

    return data.map(row => ({
      openTime: Number(row[0]),
      open: parseFloat(row[1]) || 0,
      high: parseFloat(row[2]) || 0,
      low: parseFloat(row[3]) || 0,
      close: parseFloat(row[4]) || 0,
      volume: parseFloat(row[5]) || 0,
      closeTime: Number(row[6]),
    }))
  } catch (error) {
    console.error('[BINANCE] Error fetching candles:', error)
    return []
  }
}

/**
 * Check if market has resolved and get the outcome
 * Can accept either a market object or a market ID string
 */
export async function getMarketResolution(marketOrId) {
  try {
    const marketId = typeof marketOrId === 'string' ? marketOrId : marketOrId.id
    const asset = typeof marketOrId === 'string' ? null : marketOrId.asset

    const response = await fetchWithRetry(
      `${GAMMA_API}/markets/${marketId}`,
      { headers: { 'Accept': 'application/json' } }
    )

    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.closed && data.resolutionSource) {
      // outcomePrices is a JSON string from the API
      const prices = JSON.parse(data.outcomePrices)
      const yesPrice = parseFloat(prices[0])
      const outcome = yesPrice > 0.5 ? 'UP' : 'DOWN'
      console.log(`[POLYMARKET] Resolution: yesPrice=${yesPrice}, outcome=${outcome}, conditionId=${data.conditionId}`)

      return {
        resolved: true,
        outcome,
        conditionId: data.conditionId,
        tokenIds: JSON.parse(data.clobTokenIds),
      }
    }

    return { resolved: false }

  } catch (error) {
    console.error('[POLYMARKET] Error checking resolution:', error)
    throw error
  }
}

function detectAsset(text) {
  const lower = text.toLowerCase()
  if (lower.includes('btc') || lower.includes('bitcoin')) return 'BTC'
  if (lower.includes('eth') || lower.includes('ethereum')) return 'ETH'
  if (lower.includes('sol') || lower.includes('solana')) return 'SOL'
  if (lower.includes('xrp')) return 'XRP'
  return null
}
