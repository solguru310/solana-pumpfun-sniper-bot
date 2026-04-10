# polymarket-trading-bot-sports-typescript

TypeScript bot for **slug-based trailing-stop trading** on Polymarket **sports** markets with **2 or 3 outcomes**. It polls CLOB prices, runs a small state machine, and can place **market buys** (simulation or live) via `@polymarket/clob-client`.

This is a port of the behavior in `polymarket-trading-bot-sports` (Rust), with a few TS-specific details (logging, opposite-leg trailing).

### Recommended: two-way (binary) sports markets

**Prefer two-outcome markets** for this strategy. The flow is built around **one first leg** on an underdog side and **one hedge** on the **single opposite** outcome: trailing, pair stop-loss (`firstPrice + oppositeAsk`), and mental model of a **two-price book** (roughly complementary) all map cleanly to **binary** sports contracts.

**Good fits (examples, not exhaustive):**

- **Head-to-head / moneyline** — player or team A vs B (tennis, MMA, many matchups)
- **Two-sided props** — e.g. over vs under on a single line where the CLOB exposes **two** tokens
- Any Polymarket slug whose resolved market has **exactly two** outcome tokens in the CLOB

**Three-outcome** markets (e.g. win / draw / lose) are **supported** but a **weaker fit**: after the first fill the bot must choose between **two** remaining legs, stop-loss uses a **minimum** of those asks, and behavior is harder to reason about than a simple **favorite vs underdog** binary. Use **2-way** slugs when you can.

---

## Requirements

- **Node.js** ≥ 18
- A Polymarket market **slug** (from the event URL or Gamma)
- A **`.env`** file (from **`.env.example`**) with at least **`PRIVATE_KEY`** and **`TRADING_SLUG`**. The key is used on **every** run (simulation and live) to build the CLOB client and **verify** credentials (`getApiKeys`) before trading logic starts. Simulation still **does not** submit orders; it only skips live execution inside the strategy loop.

---

## Setup

```bash
cd polymarket-trading-bot-sports-typescript
npm install
cp .env.example .env
# Edit .env: set PRIVATE_KEY, TRADING_SLUG, and other variables as needed
```

---

## Commands

| Command | Description |
|--------|-------------|
| `npm run start` | **Simulation** by default (no real orders; CLOB auth still runs) unless `TRADING_LIVE=true` in `.env` |
| `npm run start:live` | **Live** trading (adds `--no-simulation`) |
| `npm run build` | Typecheck with `tsc` |

**Simulation vs live**

- On startup the bot prints **`MODE: SIMULATION`** or **`MODE: LIVE`** so you can confirm.
- **Precedence:** `--no-simulation` / `--simulation` on the command line **override** `.env`.
- If you do **not** pass those flags: set **`TRADING_LIVE=true`** in `.env` for live orders, or leave unset / `false` for simulation (safe default).

**CLI flags** (see `src/config.ts`):

- `--simulation` — force simulation
- `--no-simulation` — live orders (requires wallet + CLOB auth)
- `-e` / `--env <path>` — env file path (default: `.env` in the current working directory)

---

## Trading strategy (high level)

The bot focuses on **underdog sides** (`ask < 0.5`) for the **first** leg in 2-outcome markets, then **hedges** on the **opposite** token with a **second** market buy sized to match share count.

### Two-outcome markets

1. **Waiting for first (`wf`)**  
   For each outcome it maintains a **trailing range** (low / high of the ask).  
   - After each update it computes a **trigger** = `low + trailing_stop_point` (using the low **before** a “spike” reset).  
   - If the ask makes a **new high** vs the previous step, the trail **resets** (same idea as a spike in the Rust reference).  
   - A **first buy** is considered only if the ask is **below 0.5** (underdog filter) and the bounce condition holds: `ask >= trigger` and `ask <= previous_high`.  
   - If both sides qualify, the **cheaper** underdog is chosen.

2. **After first buy (`fb`)**  
   The bot **trails the opposite token’s ask** with the same trigger + spike-reset + `ask <= old_high` pattern (not only a global minimum).  
   When that fires, it places the **second** buy with **notional ≈ shares × opposite ask** (same share count as the first leg).

3. **Stop loss (pair)** — when **`TRADING_STOP_LOSS_POINT`** **> 0**  
   While waiting for the second leg, if the **combined** cost of your first fill and the **current opposite ask** is too high, the bot **hedges immediately** instead of waiting for the trail:  
   `firstPrice + oppositeAsk > 1 + stop_loss_point`  
   It then buys the opposite token (same sizing as a normal second leg) and **resets** to `wf` if **`TRADING_CONTINUOUS`** is true (same as completing a pair). Set **`TRADING_STOP_LOSS_POINT` to `0`** to disable.

4. **Continuous mode**  
   If **`TRADING_CONTINUOUS`** is **true**, after a successful second buy it **returns** to `wf` and can repeat **first → second** cycles until the market is closed or you stop the process.  
   If **false**, it stops after one full pair (`done`).

### Three-outcome markets

Same idea extended to three tokens: **first** buy picks one underdog under the same trailing rules; **second** buy picks between the **two remaining** outcomes using per-leg low/high trailing (`fb3`), then optionally resets to `wf3` if `continuous` is true.

**Stop loss (3-way):** if `firstPrice + min(remainingAsk1, remainingAsk2) > 1 + stop_loss_point`, the bot buys the **cheaper** of the two remaining outcomes and resets trailing (same `continuous`/`done` rules as a normal second leg).

### Orders

- Buys use **market-style** flow (`createAndPostMarketOrder`, FOK-style parameters via the client), sized in **USDC** from price and share targets.

---

## Configuration

Configuration is read from **environment variables**, loaded by **`dotenv`** from a `.env` file in the project directory (or a path you pass with **`--env`**).

1. Copy **`.env.example`** → **`.env`**
2. Set variables (see table below). **Do not commit `.env`** (it is gitignored).

### Environment variables

| Variable | Required | Purpose |
|----------|----------|--------|
| `GAMMA_API_URL` | no | **Rarely set.** Defaults in code to `https://gamma-api.polymarket.com`. Override only for a non‑production or custom Gamma host. |
| `CLOB_API_URL` | no | **Rarely set.** Defaults in code to `https://clob.polymarket.com`. Override only for a different CLOB host. |
| `PRIVATE_KEY` | **yes** | Polygon wallet key (hex, with or without `0x`). Used on every run to authenticate against the CLOB at startup (simulation and live). The client **derives** or **creates** CLOB API keys from this key. Live mode also uses it to sign orders. |
| `SIGNATURE_TYPE` | no | `0` = EOA (default in `.env.example`). `1` / `2` = Polymarket proxy modes — must match your account. For proxy modes, if the CLOB client needs a funder address, set **`PROXY_WALLET_ADDRESS`** in `.env` (not in the template; only when required). |
| `TRADING_SLUG` | **yes** | Event/market slug (e.g. from the Polymarket URL). Resolved via Gamma → `conditionId` → CLOB market details |
| `TRADING_LIVE` | no | `true` / `1` / `yes` → **live** orders when you do **not** pass `--simulation` / `--no-simulation`. If unset or `false`, runs in **simulation** (unless `npm run start:live` or `--no-simulation`). |
| `TRADING_CONTINUOUS` | no | `true` / `false` — repeat first+second cycles until exit (default: `false`) |
| `TRADING_CHECK_INTERVAL_MS` | no | Delay between main loop iterations (default: `1000`) |
| `TRADING_TRAILING_STOP_POINT` | no | Trailing stop width in price units (default: `0.03`) |
| `TRADING_STOP_LOSS_POINT` | no | Pair hedge cap: stop loss when `firstPrice + oppAsk > 1 + value`; set `0` to disable (default: `0.03`) |
| `TRADING_TRAILING_SHARES` | no | Target share count for the first leg (default: `10`) |
| `TRADING_FIXED_TRADE_AMOUNT` | no | Fallback for share sizing (default: `1`) |

---

## Time displays (sports)

Logs use CLOB **`game_start_time`** for **`until_game_start=`** / **`since_game_start=`**.  
**`end_date_iso`** is still used **internally** for refresh / “past official end” style checks; it is usually **much later** than kickoff (resolution window), so it is not shown as the main “game clock.”

---

## Risks and disclaimer

- **Live trading** spends real funds; simulation does not. Test with `npm run start` first.
- Market rules, fees, liquidity, and resolution are determined by **Polymarket**, not this repo.
- Protect **`.env`**: treat **private keys** as compromised if leaked; rotate credentials if needed.

---

## License

See repository root or add a `LICENSE` if you distribute this project.
