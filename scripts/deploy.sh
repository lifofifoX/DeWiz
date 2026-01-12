#!/bin/bash
# Deploy Script for DegenWizard Discord Bot
# Run from your local machine to deploy to production server
# Usage: ./scripts/deploy.sh [server-host]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# Configuration - EDIT THESE
SERVER_HOST="${1:-}"
SERVER_USER="degenwizard"
APP_DIR="/home/${SERVER_USER}/discord-trading-bot"
SSH_KEY="${SSH_KEY:-}"  # Optional: path to SSH key

# Check for server host
if [ -z "$SERVER_HOST" ]; then
    # Check if .deploy-config exists
    if [ -f ".deploy-config" ]; then
        source .deploy-config
    else
        log_error "Server host not specified!"
        echo ""
        echo "Usage: ./scripts/deploy.sh <server-host>"
        echo "   or: Create .deploy-config file with SERVER_HOST=your.server.com"
        echo ""
        echo "Example .deploy-config:"
        echo "  SERVER_HOST=123.45.67.89"
        echo "  SERVER_USER=degenwizard"
        echo "  SSH_KEY=~/.ssh/id_rsa"
        exit 1
    fi
fi

# Build SSH command
SSH_CMD="ssh"
RSYNC_SSH="ssh"
if [ -n "$SSH_KEY" ]; then
    SSH_CMD="ssh -i $SSH_KEY"
    RSYNC_SSH="ssh -i $SSH_KEY"
fi

# Verify we're in the project root
if [ ! -f "package.json" ]; then
    log_error "Please run this script from the project root directory"
    exit 1
fi

echo ""
echo "=========================================="
echo -e "${GREEN}DegenWizard Deployment${NC}"
echo "=========================================="
echo "Server: ${SERVER_USER}@${SERVER_HOST}"
echo "Path:   ${APP_DIR}"
echo "=========================================="
echo ""

# Pre-deployment checks
log_step "Running pre-deployment checks..."

# Check if server is reachable
if ! $SSH_CMD -o ConnectTimeout=5 -o BatchMode=yes ${SERVER_USER}@${SERVER_HOST} "echo 'connected'" &>/dev/null; then
    log_error "Cannot connect to server ${SERVER_HOST}"
    echo "Make sure:"
    echo "  1. The server is running"
    echo "  2. SSH key is configured"
    echo "  3. User ${SERVER_USER} has SSH access"
    exit 1
fi
log_info "Server connection OK"

# Check for uncommitted changes (warning only)
if [ -d ".git" ]; then
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        log_warn "You have uncommitted changes. Consider committing before deploying."
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

# Sync files to server
log_step "Syncing files to server..."
rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.env' \
    --exclude '.env.local' \
    --exclude 'data/' \
    --exclude 'logs/' \
    --exclude '.deploy-config' \
    --exclude '*.db' \
    --exclude '*.db-*' \
    -e "$RSYNC_SSH" \
    ./ ${SERVER_USER}@${SERVER_HOST}:${APP_DIR}/

log_info "Files synced successfully"

# Install dependencies and restart on server
log_step "Installing dependencies on server..."
$SSH_CMD ${SERVER_USER}@${SERVER_HOST} << REMOTE_SCRIPT
set -e
cd ${APP_DIR}

echo "[REMOTE] Installing npm dependencies..."
npm ci --production --silent

echo "[REMOTE] Checking if database needs migration..."
if [ -f "src/database/migrate.js" ]; then
    npm run db:migrate 2>/dev/null || echo "[REMOTE] Migration check complete"
fi

echo "[REMOTE] Restarting application..."
if pm2 list | grep -q "degen-wizard"; then
    pm2 restart degen-wizard --update-env
else
    pm2 start ecosystem.config.cjs
fi

echo "[REMOTE] Saving PM2 configuration..."
pm2 save

echo "[REMOTE] Application status:"
pm2 status degen-wizard
REMOTE_SCRIPT

echo ""
echo "=========================================="
echo -e "${GREEN}Deployment complete!${NC}"
echo "=========================================="
echo ""
echo "Useful commands:"
echo "  View logs:     ssh ${SERVER_USER}@${SERVER_HOST} 'pm2 logs'"
echo "  Check status:  ssh ${SERVER_USER}@${SERVER_HOST} 'pm2 status'"
echo "  Restart:       ssh ${SERVER_USER}@${SERVER_HOST} 'pm2 restart degen-wizard'"
echo ""
