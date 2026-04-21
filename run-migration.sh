#!/bin/bash
psql "$DATABASE_URL" << SQL
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "hashedPassword" TEXT;
SQL
