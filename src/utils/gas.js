import { ethers } from 'ethers'
import { env } from '../config/index.js'

const MIN_MATIC_FOR_GAS = '0.1'

export async function checkGasBalance() {
  if (!env.WALLET_PRIVATE_KEY) {
    return false
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(env.POLYGON_RPC_URL)
    const wallet = new ethers.Wallet(env.WALLET_PRIVATE_KEY, provider)
    const balance = await provider.getBalance(wallet.address)
    return balance.gte(ethers.utils.parseEther(MIN_MATIC_FOR_GAS))
  } catch {
    return false
  }
}
