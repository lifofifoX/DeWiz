import { fetch as undiciFetch, ProxyAgent } from 'undici'

// Create proxy agent if PROXY_URL is configured
let proxyAgent = null
if (process.env.PROXY_URL) {
  proxyAgent = new ProxyAgent(process.env.PROXY_URL)
  console.log(`[FETCH] Using proxy: ${process.env.PROXY_URL}`)
}

/**
 * Fetch with automatic retry on network errors
 * Uses proxy when PROXY_URL env var is set
 */
export async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fetchOptions = proxyAgent
        ? { ...options, dispatcher: proxyAgent }
        : options
      const response = await undiciFetch(url, fetchOptions)
      return response
    } catch (error) {
      lastError = error
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
        console.log(`[FETCH] Retry ${attempt}/${maxRetries} for ${url} after ${delay}ms: ${error.message}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}
