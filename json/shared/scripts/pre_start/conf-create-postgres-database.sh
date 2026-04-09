#!/bin/sh
# Create a PostgreSQL database if it does not exist.
# Runs inside the Postgres container (execute_on: application:postgres).

DB_NAME="{{ database_name }}"
[ "$DB_NAME" = "NOT_DEFINED" ] && DB_NAME=""

if [ -z "$DB_NAME" ]; then
  echo "No database_name set, skipping" >&2
  exit 0
fi

echo "Checking database '${DB_NAME}'..." >&2

EXISTING=$(psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null)

if [ "$EXISTING" = "1" ]; then
  echo "Database '${DB_NAME}' already exists" >&2
else
  psql -U postgres -c "CREATE DATABASE \"${DB_NAME}\"" >&2
  if [ $? -eq 0 ]; then
    echo "Database '${DB_NAME}' created" >&2
  else
    echo "ERROR: Failed to create database '${DB_NAME}'" >&2
    exit 1
  fi
fi
