import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2/promise";

const url = process.env.DATABASE_URL || "";
const isTiDB = url.includes("tidbcloud.com") || url.includes("tidb");

let sslConfig: any = undefined;
if (isTiDB) {
  sslConfig = { rejectUnauthorized: true };
}

const pool = createPool({
  uri: url,
  ssl: sslConfig,
  connectionLimit: 10,
});

export const db = drizzle(pool);

export async function checkConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.query("SELECT 1");
    connection.release();
    return true;
  } catch (error) {
    console.error("Database connection failed:", error);
    return false;
  }
}
