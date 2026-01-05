#!/bin/bash

# Start the enrichment daemon in the background
echo "Starting enrichment daemon..."
node enrichment/realtime_enrichment.js daemon &
ENRICHMENT_PID=$!

# Start the main server
echo "Starting main server..."
node server.js &
SERVER_PID=$!

# Function to handle shutdown
shutdown() {
  echo "Shutting down..."
  kill $ENRICHMENT_PID
  kill $SERVER_PID
  exit 0
}

# Trap SIGTERM and SIGINT
trap shutdown SIGTERM SIGINT

# Wait for both processes
wait
