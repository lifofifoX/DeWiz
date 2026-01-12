#!/bin/bash
# Server Setup Script for DegenWizard Discord Bot
# Run this ONCE on a fresh Ubuntu/Debian VPS
# Usage: curl -sL <raw-script-url> | sudo bash
#    or: sudo bash scripts/server-setup.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "Please run as root (sudo)"
    exit 1
fi

APP_USER="degenwizard"
APP_DIR="/home/${APP_USER}/discord-trading-bot"
NODE_VERSION="20"

log_info "Starting DegenWizard server setup..."

# Update system packages
log_info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# Install essential build tools (required for better-sqlite3)
log_info "Installing build tools and dependencies..."
apt-get install -y -qq \
    curl \
    git \
    build-essential \
    python3 \
    g++ \
    make

# Install Node.js via NodeSource
log_info "Installing Node.js ${NODE_VERSION}.x..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs
else
    CURRENT_VERSION=$(node -v | cut -d'.' -f1 | cut -c2-)
    if [ "$CURRENT_VERSION" -lt "$NODE_VERSION" ]; then
        log_warn "Node.js version is older than ${NODE_VERSION}, upgrading..."
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
        apt-get install -y -qq nodejs
    else
        log_info "Node.js $(node -v) already installed"
    fi
fi

# Install PM2 globally
log_info "Installing PM2..."
npm install -g pm2

# Create application user (non-root)
if id "$APP_USER" &>/dev/null; then
    log_info "User ${APP_USER} already exists"
else
    log_info "Creating application user: ${APP_USER}"
    useradd -r -s /bin/bash -m -d /home/${APP_USER} ${APP_USER}
fi

# Create application directory
log_info "Setting up application directory: ${APP_DIR}"
mkdir -p ${APP_DIR}/logs
mkdir -p ${APP_DIR}/data
chown -R ${APP_USER}:${APP_USER} ${APP_DIR}

# Setup PM2 to run on startup
log_info "Configuring PM2 startup..."
pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER}

# Create env file template if it doesn't exist
if [ ! -f "${APP_DIR}/.env" ]; then
    log_info "Creating .env template at ${APP_DIR}/.env"
    cat > ${APP_DIR}/.env << EOF
# Discord Bot Configuration
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id

# Wallet (Polygon) - used for both Polymarket trading and USDC payouts
WALLET_PRIVATE_KEY=your_polygon_wallet_private_key
POLYGON_RPC_URL=https://polygon-rpc.com

# Anthropic API (for research agents)
ANTHROPIC_API_KEY=your_anthropic_api_key

# Database path (SQLite)
DATABASE_PATH=${APP_DIR}/data/degenwizard.db
EOF
    chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env
    chmod 600 ${APP_DIR}/.env
    log_warn "IMPORTANT: Edit ${APP_DIR}/.env with your actual credentials!"
fi

# Setup log rotation
log_info "Configuring log rotation..."
cat > /etc/logrotate.d/degen-wizard << EOF
${APP_DIR}/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 ${APP_USER} ${APP_USER}
    postrotate
        pm2 reloadLogs
    endscript
}
EOF

# Configure firewall (if ufw is installed)
if command -v ufw &> /dev/null; then
    log_info "Configuring UFW firewall..."
    ufw allow ssh
    ufw --force enable
fi

# Print summary
echo ""
echo "=========================================="
echo -e "${GREEN}Server setup complete!${NC}"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Edit credentials:  sudo nano ${APP_DIR}/.env"
echo "2. Deploy the code:   ./scripts/deploy.sh"
echo "3. Run migrations:    cd ${APP_DIR} && npm run db:migrate"
echo "4. Start the bot:     pm2 start ecosystem.config.cjs"
echo "5. Save PM2 config:   pm2 save"
echo ""
echo "Useful PM2 commands:"
echo "  pm2 status          - View running processes"
echo "  pm2 logs            - View logs in real-time"
echo "  pm2 restart all     - Restart the bot"
echo "  pm2 monit           - Interactive monitoring"
echo ""
log_info "Setup completed successfully!"
