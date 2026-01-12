import { ethers } from 'ethers'
import { env, CONFIG } from '../config/index.js'
import { users, payouts, trades, settlements, getDb } from '../database/index.js'
import { checkGasBalance } from '../utils/gas.js'
import { setEmergencyStop } from './scheduler.js'

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

const USDC_DECIMALS = 6
const MAX_PAYOUT_RETRIES = 5
const RETRY_DELAYS_MS = [60000, 120000, 240000, 480000, 960000]

let provider = null
let wallet = null
const isTestMode = process.env.TEST_MODE === 'true' || process.env.NODE_ENV === 'test'

function getProvider() {
  if (!provider) {
    provider = new ethers.providers.JsonRpcProvider(env.POLYGON_RPC_URL)
  }
  return provider
}

function getWallet() {
  if (!env.WALLET_PRIVATE_KEY) {
    console.warn('WALLET_PRIVATE_KEY not set - payouts disabled')
    return null
  }

  if (!wallet) {
    wallet = new ethers.Wallet(env.WALLET_PRIVATE_KEY, getProvider())
  }
  return wallet
}

function calculatePayoutAmounts(totalPayout, distribution, winnerCount) {
  if (winnerCount <= 0) return []

  const weights = [
    distribution.first,
    distribution.second,
    distribution.third,
  ]
  const activeWeights = weights.slice(0, winnerCount)
  const weightSum = activeWeights.reduce((sum, weight) => sum + weight, 0)
  if (weightSum <= 0) return []

  const totalCents = Math.round(totalPayout * 100)
  const amounts = []
  let allocated = 0

  for (const weight of activeWeights) {
    const cents = Math.floor((totalCents * weight) / weightSum)
    amounts.push(cents)
    allocated += cents
  }

  const remainder = totalCents - allocated
  if (remainder !== 0) {
    amounts[0] += remainder
  }

  return amounts.map(cents => cents / 100)
}

function serializeTxRequest(txRequest) {
  const requiredFields = ['to', 'data', 'value', 'nonce', 'gasLimit', 'chainId']
  for (const field of requiredFields) {
    if (txRequest[field] === undefined || txRequest[field] === null) {
      throw new Error(`[PAYOUT] Missing tx field: ${field}`)
    }
  }

  const normalized = {
    to: txRequest.to,
    data: txRequest.data,
    value: ethers.BigNumber.from(txRequest.value).toString(),
    nonce: txRequest.nonce,
    gasLimit: ethers.BigNumber.from(txRequest.gasLimit).toString(),
    chainId: txRequest.chainId,
  }

  if (txRequest.type === 2) {
    if (txRequest.maxFeePerGas === undefined || txRequest.maxPriorityFeePerGas === undefined) {
      throw new Error('[PAYOUT] Missing EIP-1559 fee fields')
    }
    if (txRequest.gasPrice !== undefined && txRequest.gasPrice !== null) {
      throw new Error('[PAYOUT] Unexpected gasPrice on EIP-1559 tx')
    }
    normalized.type = 2
    normalized.maxFeePerGas = ethers.BigNumber.from(txRequest.maxFeePerGas).toString()
    normalized.maxPriorityFeePerGas = ethers.BigNumber.from(txRequest.maxPriorityFeePerGas).toString()
  } else if (txRequest.type === 0 || txRequest.type === undefined || txRequest.type === null) {
    if (txRequest.gasPrice === undefined || txRequest.gasPrice === null) {
      throw new Error('[PAYOUT] Missing gasPrice on legacy tx')
    }
    if (txRequest.maxFeePerGas !== undefined || txRequest.maxPriorityFeePerGas !== undefined) {
      throw new Error('[PAYOUT] Unexpected EIP-1559 fields on legacy tx')
    }
    normalized.type = 0
    normalized.gasPrice = ethers.BigNumber.from(txRequest.gasPrice).toString()
  } else {
    throw new Error(`[PAYOUT] Unsupported tx type: ${txRequest.type}`)
  }

  return JSON.stringify(normalized)
}

function deserializeTxRequest(txRequestJson) {
  if (!txRequestJson) return null

  const stored = JSON.parse(txRequestJson)
  const requiredFields = ['to', 'data', 'value', 'nonce', 'gasLimit', 'chainId', 'type']
  for (const field of requiredFields) {
    if (stored[field] === undefined || stored[field] === null) {
      throw new Error(`[PAYOUT] Missing stored tx field: ${field}`)
    }
  }

  const txRequest = {
    to: stored.to,
    data: stored.data,
    value: ethers.BigNumber.from(stored.value),
    nonce: stored.nonce,
    gasLimit: ethers.BigNumber.from(stored.gasLimit),
    chainId: stored.chainId,
    type: stored.type,
  }

  if (stored.type === 2) {
    if (stored.maxFeePerGas === undefined || stored.maxPriorityFeePerGas === undefined) {
      throw new Error('[PAYOUT] Missing stored EIP-1559 fee fields')
    }
    if (stored.gasPrice !== undefined && stored.gasPrice !== null) {
      throw new Error('[PAYOUT] Unexpected stored gasPrice on EIP-1559 tx')
    }
    txRequest.maxFeePerGas = ethers.BigNumber.from(stored.maxFeePerGas)
    txRequest.maxPriorityFeePerGas = ethers.BigNumber.from(stored.maxPriorityFeePerGas)
  } else if (stored.type === 0) {
    if (stored.gasPrice === undefined || stored.gasPrice === null) {
      throw new Error('[PAYOUT] Missing stored gasPrice on legacy tx')
    }
    if (stored.maxFeePerGas !== undefined || stored.maxPriorityFeePerGas !== undefined) {
      throw new Error('[PAYOUT] Unexpected stored EIP-1559 fields on legacy tx')
    }
    txRequest.gasPrice = ethers.BigNumber.from(stored.gasPrice)
  } else {
    throw new Error(`[PAYOUT] Unsupported stored tx type: ${stored.type}`)
  }

  return txRequest
}

export function getProfitSinceLastPayout() {
  return trades.getUnsettledPnl()
}

function floorToCents(amount) {
  return Math.floor(amount * 100) / 100
}

export async function runWeeklyPayouts(channel) {
  const profitSinceLastPayout = getProfitSinceLastPayout()

  if (profitSinceLastPayout <= 0) {
    return
  }

  const minPayoutUsd = CONFIG.payouts.min_payout_usd
  const payoutShare = CONFIG.payouts.payout_share
  const totalPayout = floorToCents(profitSinceLastPayout * payoutShare)

  if (totalPayout < minPayoutUsd) {
    return
  }

  console.log(`[PAYOUT] Weekly payout triggered: unpaid profit $${profitSinceLastPayout.toFixed(2)}, payout $${totalPayout.toFixed(2)}`)

  const db = getDb()
  const settlementResult = db.transaction(() => {
    const currentProfit = trades.getUnsettledPnl()
    if (currentProfit <= 0) {
      return null
    }

    const currentTotalPayout = floorToCents(currentProfit * payoutShare)
    if (currentTotalPayout < minPayoutUsd) {
      return null
    }

    const unsettledTrades = trades.getUnsettledTrades()
    if (unsettledTrades.length === 0) {
      return null
    }

    const tradeIds = unsettledTrades.map(t => t.id)
    const winners = users.getTopPredictorsForTrades(tradeIds, 3)
    if (winners.length === 0) {
      return null
    }

    const payoutAmounts = calculatePayoutAmounts(currentTotalPayout, CONFIG.payouts.distribution, winners.length)
    if (payoutAmounts.length === 0) {
      return null
    }

    const settlement = settlements.create()
    settlements.updateStatus(settlement.id, 'distributing')

    trades.linkToSettlement(tradeIds, settlement.id)

    for (let i = 0; i < winners.length; i++) {
      const user = winners[i]
      const amount = payoutAmounts[i]
      const rank = i + 1

      payouts.create(user.discord_id, amount, rank, settlement.id)
    }

    return { settlement, tradeCount: tradeIds.length, totalPayout: currentTotalPayout, profit: currentProfit }
  })()

  if (!settlementResult) {
    console.log('[PAYOUT] Weekly settlement not created (insufficient profit, no unsettled trades, or no eligible winners)')
    return
  }

  const { settlement, tradeCount, totalPayout: actualPayout, profit } = settlementResult
  console.log(`[PAYOUT] Created weekly settlement ${settlement.id}, linked ${tradeCount} trades, payout $${actualPayout.toFixed(2)} from $${profit.toFixed(2)} profit`)

  await executeSettlementPayouts(settlement.id, channel)
}

async function reconcilePayoutTx(payout) {
  if (!payout.tx_hash) return { status: 'none' }

  try {
    const receipt = await getProvider().getTransactionReceipt(payout.tx_hash)
    if (!receipt) {
      const tx = await getProvider().getTransaction(payout.tx_hash)
      if (tx) {
        return { status: 'pending' }
      }
      return { status: 'missing' }
    }

    if (receipt.status === 1) {
      payouts.updateStatus(payout.id, 'sent')
      return { status: 'sent' }
    }

    payouts.updateStatus(payout.id, 'failed')
    payouts.incrementRetry(payout.id, 'Transaction reverted')
    payouts.updateTxHash(payout.id, null)
    payouts.updateTxRequest(payout.id, null)
    return { status: 'failed', error: 'Transaction reverted' }
  } catch (error) {
    console.error(`[PAYOUT] Error checking tx ${payout.tx_hash}:`, error)
    return { status: 'pending', error: error.message }
  }
}

async function processPayout(payout) {
  if (payout.status === 'sent') {
    return { payout, success: true, alreadySent: true }
  }

  const txStatus = await reconcilePayoutTx(payout)
  if (txStatus.status === 'sent') {
    return { payout, success: true, alreadySent: true }
  }
  if (txStatus.status === 'pending') {
    return { payout, success: false, pending: true }
  }
  if (txStatus.status === 'missing') {
    if (payout.tx_request) {
      const result = await sendUsdcPayout(payout.id, null, payout.amount, payout.tx_request)
      if (result.pending) {
        return { payout, success: false, pending: true, attempted: true }
      }
      if (result.success) {
        payouts.updateStatus(payout.id, 'sent')
        return { payout, success: true, attempted: true }
      }
      payouts.updateStatus(payout.id, 'failed')
      payouts.incrementRetry(payout.id, result.error || 'Unknown error')
      return { payout, success: false, attempted: true }
    }
    return { payout, success: false, pending: true }
  }
  if (txStatus.status === 'failed') {
    return { payout, success: false }
  }

  const user = users.get(payout.user_id)
  if (!user?.wallet_address) {
    payouts.updateStatus(payout.id, 'failed')
    payouts.incrementRetry(payout.id, 'No wallet address')
    return { payout, user, success: false }
  }

  const result = await sendUsdcPayout(payout.id, user.wallet_address, payout.amount, payout.tx_request)

  if (result.pending) {
    return { payout, user, success: false, pending: true, attempted: true }
  }

  if (result.success) {
    payouts.updateStatus(payout.id, 'sent')
    return { payout, user, success: true, attempted: true }
  }

  payouts.updateStatus(payout.id, 'failed')
  payouts.incrementRetry(payout.id, result.error || 'Unknown error')
  if (result.failed && result.txHash) {
    payouts.updateTxHash(payout.id, null)
    payouts.updateTxRequest(payout.id, null)
  }
  return { payout, user, success: false, attempted: true }
}

async function executeSettlementPayouts(settlementId, channel) {
  const settlement = settlements.getById(settlementId)
  if (!settlement) return

  const settlementPayouts = payouts.getBySettlement(settlementId)
  if (settlementPayouts.length === 0) {
    console.error(`[PAYOUT] CRITICAL: Settlement ${settlementId} has no payout records`)
    await triggerPayoutEmergencyStop(settlementId, channel, 'No payout records for settlement')
    return
  }
  const payoutResults = []

  for (const payout of settlementPayouts) {
    const result = await processPayout(payout)
    payoutResults.push(result)
  }

  const allSucceeded = payoutResults.every(r => r.success)
  const anyFailed = payoutResults.some(r => !r.success && !r.pending)
  const anyPending = payoutResults.some(r => r.pending)

  if (allSucceeded) {
    settlements.updateStatus(settlementId, 'completed')
    console.log(`[PAYOUT] Settlement ${settlementId} completed successfully`)
  } else if (anyFailed) {
    const failedPayouts = payouts.getFailedBySettlement(settlementId)
    const hasRetryable = failedPayouts.some(p => p.retry_count < MAX_PAYOUT_RETRIES)

    if (hasRetryable) {
      settlements.updateStatus(settlementId, 'failed', 'Some payouts failed - will retry')
      console.log(`[PAYOUT] Settlement ${settlementId} has failed payouts, scheduling retry`)
    } else {
      settlements.updateStatus(settlementId, 'failed', 'All payout retries exhausted')
      console.error(`[PAYOUT] CRITICAL: Settlement ${settlementId} exhausted all retries`)
      await triggerPayoutEmergencyStop(settlementId, channel, 'All payout retries exhausted')
      return
    }
  } else if (anyPending) {
    settlements.updateStatus(settlementId, 'distributing')
    console.log(`[PAYOUT] Settlement ${settlementId} has pending transactions, awaiting confirmation`)
  }

  if (channel) {
    const successfulPayouts = payoutResults.filter(r => r.success && !r.alreadySent)

    if (successfulPayouts.length > 0) {
      const payoutLines = successfulPayouts.map(p => {
        const medal = p.payout.rank === 1 ? '🥇' : p.payout.rank === 2 ? '🥈' : '🥉'
        return `${medal} ${p.user?.discord_username || 'Unknown'}: $${p.payout.amount.toFixed(2)} ✅`
      })

      const failedCount = payoutResults.filter(r => !r.success && !r.pending).length
      const failedLine = failedCount > 0 ? `\n⚠️ ${failedCount} payout(s) failed - will retry` : ''

      await channel.send({
        content: [
          `🎉 **PAYOUT TIME!** USDC distributed`,
          ``,
          `**Top 3 predictors:**`,
          ...payoutLines,
          failedLine,
        ].filter(Boolean).join('\n'),
      })
    }
  }
}

export async function retryFailedSettlements(channel) {
  const incompleteSettlements = settlements.getIncomplete()

  for (const settlement of incompleteSettlements) {
    const settlementPayouts = payouts.getBySettlement(settlement.id)

    if (settlementPayouts.length === 0) {
      console.error(`[PAYOUT] CRITICAL: Settlement ${settlement.id} has no payout records`)
      await triggerPayoutEmergencyStop(settlement.id, channel, 'No payout records for settlement')
      continue
    }

    const pendingOrFailed = settlementPayouts.filter(p => p.status !== 'sent')
    if (pendingOrFailed.length === 0) {
      settlements.updateStatus(settlement.id, 'completed')
      console.log(`[PAYOUT] Settlement ${settlement.id} marked complete - all payouts sent`)
      continue
    }

    const retryablePayouts = pendingOrFailed.filter(p => p.retry_count < MAX_PAYOUT_RETRIES)

    if (retryablePayouts.length === 0) {
      console.error(`[PAYOUT] CRITICAL: Settlement ${settlement.id} has no retryable payouts left`)
      await triggerPayoutEmergencyStop(settlement.id, channel, 'All payout retries exhausted')
      continue
    }

    for (const payout of retryablePayouts) {
      const delay = RETRY_DELAYS_MS[Math.min(payout.retry_count, RETRY_DELAYS_MS.length - 1)]
      const lastRetry = payout.last_retry_at ? new Date(payout.last_retry_at).getTime() : 0
      const now = Date.now()

      if (now - lastRetry < delay) {
        continue
      }

      const attemptNumber = payout.retry_count + 1
      const result = await processPayout(payout)

      if (result.attempted) {
        console.log(`[PAYOUT] Retrying payout ${payout.id} (attempt ${attemptNumber}/${MAX_PAYOUT_RETRIES})`)
      }

      if (result.success && !result.alreadySent) {
        console.log(`[PAYOUT] Retry succeeded for payout ${payout.id}`)

        if (channel) {
          await channel.send({
            content: `✅ Payout retry succeeded: $${payout.amount.toFixed(2)} sent to ${result.user?.discord_username || result.user?.discord_id || payout.user_id}`,
          })
        }
      } else if (result.attempted && !result.success && !result.pending) {
        console.log(`[PAYOUT] Retry failed for payout ${payout.id}`)

        const updated = payouts.getById(payout.id)
        if (updated.retry_count >= MAX_PAYOUT_RETRIES) {
          console.error(`[PAYOUT] Payout ${payout.id} exhausted all retries`)
        }
      }
    }

    const remainingUnsent = payouts.getBySettlement(settlement.id).filter(p => p.status !== 'sent')
    if (remainingUnsent.length === 0) {
      settlements.updateStatus(settlement.id, 'completed')
      console.log(`[PAYOUT] Settlement ${settlement.id} completed after retries`)
    } else {
      const allExhausted = remainingUnsent.every(p => p.retry_count >= MAX_PAYOUT_RETRIES)
      if (allExhausted) {
        await triggerPayoutEmergencyStop(settlement.id, channel, 'All payout retries exhausted')
      }
    }
  }
}

async function triggerPayoutEmergencyStop(settlementId, channel, reason = 'Payout retries exhausted') {
  const failedPayouts = payouts.getFailedBySettlement(settlementId)

  settlements.updateStatus(settlementId, 'failed', `Emergency stop triggered - ${reason}`)
  setEmergencyStop(true)

  console.error(`[PAYOUT] EMERGENCY STOP: Settlement ${settlementId} - ${reason}`)

  if (channel) {
    const failedLines = failedPayouts.map(p => {
      const user = users.get(p.user_id)
      return `- ${user?.discord_username || p.user_id}: $${p.amount.toFixed(2)} (${p.retry_count} retries, error: ${p.error_message || 'unknown'})`
    })

    await channel.send({
      content: [
        `🚨 **CRITICAL: PAYOUT FAILURE - EMERGENCY STOP**`,
        ``,
        `Settlement ${settlementId} could not complete payouts.`,
        `Reason: ${reason}`,
        ``,
        `**Failed payouts:**`,
        failedLines.length > 0 ? failedLines.join('\n') : 'None',
        ``,
        `⚠️ **Bot has entered emergency stop mode.**`,
        ``,
        `**MANUAL ACTION REQUIRED:**`,
        `1. Check wallet balance and gas`,
        `2. Verify recipient addresses`,
        `3. Send payouts manually if needed`,
        `4. Use \`/resume\` to restart trading after fixing`,
      ].join('\n'),
    })
  }
}

async function sendUsdcPayout(payoutId, recipientAddress, amountUsd, txRequestJson = null) {
  if (isTestMode) {
    return { success: true }
  }

  const senderWallet = getWallet()

  if (!senderWallet) {
    return { success: false, error: 'Wallet not configured' }
  }

  let tx = null
  let txRequest = null

  try {
    const usdcContract = new ethers.Contract(
      CONFIG.payouts.usdc_contract,
      USDC_ABI,
      senderWallet
    )

    const amount = ethers.utils.parseUnits(amountUsd.toFixed(2), USDC_DECIMALS)

    if (!await checkGasBalance()) {
      return { success: false, error: 'Insufficient MATIC for gas' }
    }

    const balance = await usdcContract.balanceOf(senderWallet.address)
    if (balance.lt(amount)) {
      return { success: false, error: 'Insufficient USDC balance' }
    }

    if (txRequestJson) {
      txRequest = deserializeTxRequest(txRequestJson)
    }

    if (!txRequest) {
      if (!recipientAddress) {
        return { success: false, error: 'Missing recipient address' }
      }

      const unsigned = await usdcContract.populateTransaction.transfer(recipientAddress, amount)
      txRequest = await senderWallet.populateTransaction(unsigned)

      if (txRequest.value === undefined || txRequest.value === null) {
        txRequest.value = 0
      }

      if (txRequest.type === undefined || txRequest.type === null) {
        if (txRequest.maxFeePerGas !== undefined || txRequest.maxPriorityFeePerGas !== undefined) {
          txRequest.type = 2
        } else if (txRequest.gasPrice !== undefined) {
          txRequest.type = 0
        }
      }

      if (txRequest.chainId === undefined || txRequest.chainId === null) {
        txRequest.chainId = (await getProvider().getNetwork()).chainId
      }

      payouts.updateTxRequest(payoutId, serializeTxRequest(txRequest))
    }

    const rawTx = await senderWallet.signTransaction(txRequest)
    const txHash = ethers.utils.keccak256(rawTx)
    payouts.updateTxHash(payoutId, txHash)

    tx = await getProvider().sendTransaction(rawTx)

    const receipt = await tx.wait()
    if (receipt?.status === 1) {
      const confirmedHash = receipt.transactionHash || tx.hash || txHash
      const toLabel = recipientAddress || 'stored recipient'
      console.log(`[PAYOUT] Sent $${amountUsd} USDC to ${toLabel} - tx: ${confirmedHash}`)
      return { success: true, txHash: confirmedHash }
    }

    return { success: false, error: 'Transaction reverted', txHash: tx.hash || txHash, failed: true }
  } catch (error) {
    const receiptStatus = error?.receipt?.status
    const txHash = error?.receipt?.transactionHash || error?.transactionHash || tx?.hash
    if (txHash) {
      payouts.updateTxHash(payoutId, txHash)
    }
    if (receiptStatus === 0) {
      return { success: false, error: 'Transaction reverted', txHash, failed: true }
    }
    console.error('USDC transfer failed:', error)
    return { success: false, error: error.message, txHash, pending: !!txHash }
  }
}

export async function checkWalletBalance() {
  const senderWallet = getWallet()
  if (!senderWallet) {
    return { usdc: 0, matic: 0 }
  }

  try {
    const maticBalance = await getProvider().getBalance(senderWallet.address)
    const matic = parseFloat(ethers.utils.formatEther(maticBalance))

    const usdcContract = new ethers.Contract(
      CONFIG.payouts.usdc_contract,
      USDC_ABI,
      getProvider()
    )
    const usdcBalance = await usdcContract.balanceOf(senderWallet.address)
    const usdc = parseFloat(ethers.utils.formatUnits(usdcBalance, USDC_DECIMALS))

    return { usdc, matic }
  } catch (error) {
    console.error('Failed to check wallet balance:', error)
    return { usdc: 0, matic: 0 }
  }
}

/**
 * Get the current pool balance from blockchain
 * This is the single source of truth for position sizing
 */
export async function getPoolBalance() {
  const { usdc } = await checkWalletBalance()
  return usdc
}
