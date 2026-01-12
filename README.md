# DegenWizard Discord Trading Bot

Discord bot for The Wizards of Ord community that runs community-voted trades on Polymarket 15-minute crypto markets and tracks results for payouts.

> **Disclaimer:** This project was largely vibe coded. Review the code thoroughly before using it.

## Setup

1. Install dependencies: `npm install`
2. Configure env vars: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `WALLET_PRIVATE_KEY`, `POLYGON_RPC_URL`, `ANTHROPIC_API_KEY`
3. Initialize the database: `npm run db:migrate`
4. Start the bot: `npm run dev`
