#!/bin/bash
# Health Check Script for DegenWizard Discord Bot
# Run on the server to check if the bot is healthy
# Usage: ./scripts/health-check.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_NAME="degen-wizard"
APP_DIR="/home/degenwizard/discord-trading-bot"

echo ""
echo "DegenWizard Health Check"
echo "========================"
echo ""

# Check PM2 process
echo -n "PM2 Process:    "
if pm2 list 2>/dev/null | grep -q "$APP_NAME.*online"; then
    echo -e "${GREEN}RUNNING${NC}"
else
    echo -e "${RED}NOT RUNNING${NC}"
    echo ""
    echo "To start: pm2 start ecosystem.config.cjs"
    exit 1
fi

# Check memory usage
echo -n "Memory Usage:   "
MEM=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['monit']['memory']//1024//1024) if d else print(0)" 2>/dev/null || echo "0")
if [ "$MEM" -gt 0 ]; then
    echo "${MEM} MB"
else
    echo "Unknown"
fi

# Check uptime
echo -n "Uptime:         "
UPTIME=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); ms=d[0]['pm2_env']['pm_uptime']; import time; print(int((time.time()*1000-ms)/1000/60)) if d else print(0)" 2>/dev/null || echo "0")
if [ "$UPTIME" -gt 0 ]; then
    if [ "$UPTIME" -gt 1440 ]; then
        echo "$((UPTIME/1440)) days"
    elif [ "$UPTIME" -gt 60 ]; then
        echo "$((UPTIME/60)) hours"
    else
        echo "${UPTIME} minutes"
    fi
else
    echo "Just started"
fi

# Check restart count
echo -n "Restarts:       "
RESTARTS=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['pm2_env']['restart_time']) if d else print(0)" 2>/dev/null || echo "0")
echo "$RESTARTS"

# Check database
echo -n "Database:       "
if [ -f "${APP_DIR}/data/degenwizard.db" ]; then
    DB_SIZE=$(du -h "${APP_DIR}/data/degenwizard.db" 2>/dev/null | cut -f1)
    echo -e "${GREEN}EXISTS${NC} (${DB_SIZE})"
else
    echo -e "${YELLOW}NOT FOUND${NC}"
fi

# Check env file
echo -n "Config (.env):  "
if [ -f "${APP_DIR}/.env" ]; then
    echo -e "${GREEN}EXISTS${NC}"
else
    echo -e "${RED}MISSING${NC}"
fi

# Check log files
echo -n "Logs:           "
if [ -d "${APP_DIR}/logs" ]; then
    LOG_SIZE=$(du -sh "${APP_DIR}/logs" 2>/dev/null | cut -f1)
    echo "${LOG_SIZE}"
else
    echo "No logs directory"
fi

# Check disk space
echo -n "Disk Space:     "
DISK_USAGE=$(df -h ${APP_DIR} 2>/dev/null | tail -1 | awk '{print $5}')
DISK_AVAIL=$(df -h ${APP_DIR} 2>/dev/null | tail -1 | awk '{print $4}')
echo "${DISK_USAGE} used (${DISK_AVAIL} available)"

# Recent errors
echo ""
echo "Recent Errors (last 5):"
echo "------------------------"
if [ -f "${APP_DIR}/logs/error.log" ]; then
    tail -5 "${APP_DIR}/logs/error.log" 2>/dev/null || echo "  (no errors)"
else
    echo "  (no error log file)"
fi

echo ""
echo "========================"
echo -e "Overall: ${GREEN}HEALTHY${NC}"
echo ""
