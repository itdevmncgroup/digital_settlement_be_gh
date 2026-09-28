const DATABASE_URL_ENV_KEYS: Record<string, string> = {
  postgres: 'DATABASE_URL_POSTGRES',
  supabase: 'DATABASE_URL_SUPABASE',
  aws: 'DATABASE_URL_AWS',
};

// postgres/supabase/aws all speak the same PostgreSQL wire protocol, so
// Prisma's datasource provider stays "postgresql" (prisma/schema.prisma) -
// only the connection string needs to change. DB_PROVIDER picks which
// DATABASE_URL_<PROVIDER> value gets copied into DATABASE_URL before
// PrismaClient is ever constructed (PrismaService, src/prisma/) - it reads
// process.env.DATABASE_URL once, at instantiation time, so this must run
// before NestFactory.create. The Prisma CLI (migrate/studio/seed - see
// scripts/resolve-database-url.js) is a separate process and needs its own
// copy of this same resolution before it loads DATABASE_URL.
export function resolveDatabaseUrl(): void {
  const provider = (process.env.DB_PROVIDER || 'postgres').trim().toLowerCase();
  const key = DATABASE_URL_ENV_KEYS[provider] ?? DATABASE_URL_ENV_KEYS.postgres;
  const url = process.env[key];
  if (url) process.env.DATABASE_URL = url;
}
