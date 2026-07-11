import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const name = `klm-migrations-${process.pid}`;

function run(command, args, { quiet = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: quiet ? "ignore" : "inherit",
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result.status;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  run("docker", ["info"], { quiet: true });
  run("docker", ["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=test", "postgres:17"], { quiet: true });

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (run("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { quiet: true, allowFailure: true }) === 0) {
      ready = true;
      break;
    }
    await wait(500);
  }
  if (!ready) throw new Error("Throwaway Postgres did not become ready");

  run("docker", ["exec", name, "createdb", "-U", "postgres", "app"]);
  run("docker", ["cp", join(root, "supabase", "tests", "_stubs.sql"), `${name}:/tmp/stubs.sql`], { quiet: true });
  run("docker", ["cp", `${join(root, "supabase", "migrations")}${process.platform === "win32" ? "\\." : "/."}`, `${name}:/tmp/m/`], { quiet: true });
  run("docker", ["cp", join(root, "supabase", "tests", "production_readiness.test.sql"), `${name}:/tmp/production_readiness.sql`], { quiet: true });
  run("docker", ["exec", name, "psql", "-U", "postgres", "-d", "app", "-v", "ON_ERROR_STOP=1", "-q", "-f", "/tmp/stubs.sql"]);

  const migrations = readdirSync(join(root, "supabase", "migrations"))
    .filter((file) => /^\d.*\.sql$/.test(file))
    .sort();
  for (const file of migrations) {
    console.log(`Applying ${file}`);
    run("docker", ["exec", name, "psql", "-U", "postgres", "-d", "app", "-v", "ON_ERROR_STOP=1", "-q", "-f", `/tmp/m/${file}`]);
  }
  run("docker", ["exec", name, "psql", "-U", "postgres", "-d", "app", "-v", "ON_ERROR_STOP=1", "-q", "-f", "/tmp/production_readiness.sql"]);
  console.log(`Verified ${migrations.length} migrations and production security invariants.`);
} finally {
  run("docker", ["rm", "-f", name], { quiet: true, allowFailure: true });
}
