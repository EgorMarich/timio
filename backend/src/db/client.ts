import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://student:student@localhost:5432/timio';

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });
