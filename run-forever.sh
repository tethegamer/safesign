#!/bin/bash
cd /workspace/safesign
while true; do node server.js; echo "restart $(date)"; sleep 2; done
