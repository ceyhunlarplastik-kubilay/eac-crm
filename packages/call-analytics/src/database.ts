import { Pool, type PoolClient } from "pg";

let pool: Pool | undefined;
export function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 20_000,
    application_name: "eac-post-call-analytics"
  });
  return pool;
}

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
