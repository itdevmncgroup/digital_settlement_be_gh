// -r preload for the Prisma CLI / seed npm scripts (package.json) - a
// separate process from the Nest app, so it needs its own copy of
// src/config/resolve-database-url.ts's DB_PROVIDER -> DATABASE_URL logic.
// dotenv.config() never overrides an already-set process.env var, so setting
// DATABASE_URL here first wins over whatever .env's own DATABASE_URL line has.
require('dotenv').config();

const DATABASE_URL_ENV_KEYS = {
  postgres: 'DATABASE_URL_POSTGRES',
  supabase: 'DATABASE_URL_SUPABASE',
  aws: 'DATABASE_URL_AWS',
};

const provider = (process.env.DB_PROVIDER || 'postgres').trim().toLowerCase();
const key = DATABASE_URL_ENV_KEYS[provider] || DATABASE_URL_ENV_KEYS.postgres;
const url = process.env[key];
if (url) process.env.DATABASE_URL = url;
