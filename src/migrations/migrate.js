const fs = require("fs");
const path = require("path");
const pool = require("../config/database");

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        run_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [file]
      );

      if (rows.length) {
        console.log(`Skipping (already run): ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
      console.log(`Running: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    console.log("All migrations complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
