import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

export interface PolymarketConfig {
  gamma_api_url: string;
  clob_api_url: string;
  private_key: string | null;
  proxy_wallet_address: string | null;
  signature_type: number | null;
}

export interface SportsTradingConfig {
  slug: string | null;
  continuous: boolean;
  check_interval_ms: number;
  trailing_stop_point: number;
  /** If > 0: in `fb`, hedge when `firstPrice + oppAsk > 1 + stop_loss_point`. Set 0 to disable. */
  stop_loss_point: number;
  trailing_shares: number;
  fixed_trade_amount: number;
}

export interface Config {
  polymarket: PolymarketConfig;
  trading: SportsTradingConfig;
}

const DEFAULT_TRADING: SportsTradingConfig = {
  slug: null,
  continuous: false,
  check_interval_ms: 1000,
  trailing_stop_point: 0.03,
  stop_loss_point: 0.03,
  trailing_shares: 10,
  fixed_trade_amount: 1.0,
};

const DEFAULT_POLY: PolymarketConfig = {
  gamma_api_url: "https://gamma-api.polymarket.com",
  clob_api_url: "https://clob.polymarket.com",
  private_key: null,
  proxy_wallet_address: null,
  signature_type: null,
};

function envString(key: string): string | null {
  const v = process.env[key];
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v == null || v.trim() === "") return defaultValue;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function envNumber(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v == null || v.trim() === "") return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

function envIntOrNull(key: string): number | null {
  const v = process.env[key];
  if (v == null || v.trim() === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Load config from `process.env` (populate with `loadEnvFile` first). */
export function loadConfigFromEnv(): Config {
  return {
    polymarket: {
      gamma_api_url: envString("GAMMA_API_URL") ?? DEFAULT_POLY.gamma_api_url,
      clob_api_url: envString("CLOB_API_URL") ?? DEFAULT_POLY.clob_api_url,
      private_key: envString("PRIVATE_KEY"),
      proxy_wallet_address: envString("PROXY_WALLET_ADDRESS"),
      signature_type: envIntOrNull("SIGNATURE_TYPE"),
    },
    trading: {
      slug: envString("TRADING_SLUG"),
      continuous: envBool("TRADING_CONTINUOUS", DEFAULT_TRADING.continuous),
      check_interval_ms: envNumber("TRADING_CHECK_INTERVAL_MS", DEFAULT_TRADING.check_interval_ms),
      trailing_stop_point: envNumber("TRADING_TRAILING_STOP_POINT", DEFAULT_TRADING.trailing_stop_point),
      stop_loss_point: envNumber("TRADING_STOP_LOSS_POINT", DEFAULT_TRADING.stop_loss_point),
      trailing_shares: envNumber("TRADING_TRAILING_SHARES", DEFAULT_TRADING.trailing_shares),
      fixed_trade_amount: envNumber("TRADING_FIXED_TRADE_AMOUNT", DEFAULT_TRADING.fixed_trade_amount),
    },
  };
}

/** Load `.env` into `process.env`. Call before `loadConfigFromEnv`. */
export function loadEnvFile(envPath: string): void {
  const full = resolve(envPath);
  if (!existsSync(full)) {
    console.warn(`Warning: env file not found: ${full} — copy .env.example to .env and set variables.`);
  }
  dotenvConfig({ path: full });
}

/** Parse CLI only (call before `loadEnvFile`). */
export function parseArgv(): { envPath: string; cliSimulation: boolean | undefined } {
  const argv = process.argv.slice(2);
  let envPath = ".env";
  let cliSimulation: boolean | undefined = undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-simulation") cliSimulation = false;
    else if (argv[i] === "--simulation") cliSimulation = true;
    else if (argv[i] === "-e" || argv[i] === "--env") {
      envPath = argv[++i] ?? envPath;
    }
  }
  return { envPath, cliSimulation };
}

/**
 * Resolve paper vs live after `.env` is loaded.
 * Precedence: CLI (`--no-simulation` / `--simulation`) overrides `TRADING_LIVE` in `.env`.
 * If CLI does not specify: `TRADING_LIVE=true` → live; otherwise → simulation (safe default).
 */
export function resolveSimulation(cliSimulation: boolean | undefined): boolean {
  if (cliSimulation !== undefined) return cliSimulation;
  return !envBool("TRADING_LIVE", false);
}
