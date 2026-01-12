import { readFileSync, existsSync } from 'fs'
import { parse } from 'yaml'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const configPath = process.env.CONFIG_PATH || join(__dirname, '../..', 'config.yaml')

function readConfigFile() {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  return readFileSync(configPath, 'utf-8')
}

export const CONFIG = validateConfig(parse(readConfigFile()))

function getConfigValue(config, path) {
  return path.reduce((value, key) => value?.[key], config)
}

function validateConfig(config) {
  const requiredPaths = [
    ['discord', 'trading_channel_id'],
    ['scheduling', 'timezone'],
    ['scheduling', 'morning_trade_time'],
    ['scheduling', 'morning_blackout_minutes'],
    ['scheduling', 'trade_hours_start'],
    ['scheduling', 'trade_hours_end'],
    ['scheduling', 'interval_variance_minutes'],
    ['scheduling', 'min_gap_minutes'],
    ['trading', 'voting_window_seconds'],
    ['trading', 'min_votes'],
    ['trading', 'max_position_pct'],
    ['trading', 'min_position_pct'],
    ['payouts', 'min_payout_usd'],
    ['payouts', 'payout_share'],
    ['payouts', 'distribution', 'first'],
    ['payouts', 'distribution', 'second'],
    ['payouts', 'distribution', 'third'],
    ['payouts', 'usdc_contract'],
    ['reputation', 'weight_increase_per_prediction'],
    ['reputation', 'max_weight'],
    ['agents', 'model_fast'],
  ]

  const missing = requiredPaths
    .filter(path => {
      const value = getConfigValue(config, path)
      return value === undefined || value === null || value === ''
    })
    .map(path => path.join('.'))

  if (missing.length > 0) {
    throw new Error(`Missing required config values in config.yaml: ${missing.join(', ')}`)
  }

  return config
}

function getEnv(key, required = true) {
  const value = process.env[key]
  if (!value && required) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value || ''
}

export const env = {
  get DISCORD_BOT_TOKEN() { return getEnv('DISCORD_BOT_TOKEN') },
  get DISCORD_CLIENT_ID() { return getEnv('DISCORD_CLIENT_ID') },
  get WALLET_PRIVATE_KEY() { return getEnv('WALLET_PRIVATE_KEY', false) },
  get POLYGON_RPC_URL() { return getEnv('POLYGON_RPC_URL', false) || 'https://polygon-rpc.com' },
  get ANTHROPIC_API_KEY() { return getEnv('ANTHROPIC_API_KEY') },
  get DATABASE_PATH() { return getEnv('DATABASE_PATH', false) || './data/degenwizard.db' },
  get PROXY_URL() { return getEnv('PROXY_URL', false) },
}
