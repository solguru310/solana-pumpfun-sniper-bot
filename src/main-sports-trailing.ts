import { loadConfigFromEnv, loadEnvFile, parseArgv, resolveSimulation } from "./config.js";
import { PolymarketApi } from "./api.js";
import { createClobClient, verifyClobAuth } from "./clob.js";
import { runSportsTrailing } from "./trailing-loop.js";

async function main(): Promise<void> {
  const { envPath, cliSimulation } = parseArgv();
  loadEnvFile(envPath);
  const simulation = resolveSimulation(cliSimulation);
  const cfg = loadConfigFromEnv();
  const slug = cfg.trading.slug?.trim();
  if (!slug) {
    console.error(`Set TRADING_SLUG in your env file (${envPath}; see .env.example).`);
    process.exit(1);
  }

  console.log(
    simulation
      ? "MODE: SIMULATION — no real orders (set TRADING_LIVE=true in .env or use npm run start:live / --no-simulation)."
      : "MODE: LIVE — real orders will be submitted."
  );

  const api = new PolymarketApi(cfg.polymarket);
  const gamma = await api.getMarketBySlug(slug);
  const conditionId = gamma.conditionId;
  if (!conditionId) {
    console.error("Gamma response had no conditionId.");
    process.exit(1);
  }

  const details = await api.getClobMarketDetails(conditionId);
  const gammaEnd = gamma.endDateISO ?? gamma.endDateIso;

  const pk = cfg.polymarket.private_key?.trim();
  if (!pk) {
    console.error("PRIVATE_KEY is required in .env (simulation and live) so the bot can verify CLOB authentication at startup.");
    process.exit(1);
  }

  const clobClient = await createClobClient(cfg.polymarket);
  await verifyClobAuth(clobClient);
  console.log("CLOB auth OK.");

  await runSportsTrailing(api, cfg, details, gammaEnd, simulation, clobClient);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
