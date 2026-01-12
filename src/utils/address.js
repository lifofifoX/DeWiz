import { ethers } from 'ethers'

export function isValidAddress(address) {
  try {
    return ethers.utils.isAddress(address)
  } catch {
    return false
  }
}

export function normalizeAddress(address) {
  return ethers.utils.getAddress(address)
}

export function formatAddress(address) {
  if (!address) return 'Not set'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}
