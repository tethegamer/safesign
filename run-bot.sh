#!/bin/bash
# Keeps bot.js alive (long polling). Requires TELEGRAM_BOT_TOKEN in the environment.
cd "$(dirname "$0")"
while true; do node bot.js; echo "bot exited, restarting $(date)"; sleep 5; done
