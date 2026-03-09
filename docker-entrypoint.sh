#!/bin/sh
set -e

echo "Running database migrations..."
npx node-pg-migrate up --migrations-dir dist/db/migrations --envPath /dev/null
echo "Migrations complete."

echo "Running seed..."
node dist/db/seed.js
echo "Seed complete."

echo "Starting server..."
exec node dist/server.js
