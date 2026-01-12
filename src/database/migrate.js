import 'dotenv/config'
import { initializeDatabase } from './index.js'

console.log('Running database migrations...')

initializeDatabase()

console.log('Migrations complete!')
