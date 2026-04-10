/**
 * Trailing state machine for 2- and 3-outcome markets (port of polymarket-trading-bot-sports).
 */
import type { ClobClient } from "@polymarket/clob-client";
import type { PolymarketApi } from "./api.js";
import type { Config } from "./config.js";
import type { TokenPrice, ClobMarketDetails } from "./types.js";
import { placeMarketBuyUsdc } from "./clob.js";

const MIN_FIRST_BUY_COST = 1.0;
const CLOSED_CHECK_INTERVAL = 60;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatRemainingHms(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** CLOB `game_start_time`: countdown before start, elapsed after. */
export function formatGameClock(gameStartTs: number | null, now: number): string {
  if (gameStartTs == null) return "no game_start_time (CLOB)";
  const delta = gameStartTs - now;
  if (delta > 0) return `until_game_start=${formatRemainingHms(delta)}`;
  return `since_game_start=${formatRemainingHms(-delta)}`;
}

/** Match Rust: naive timestamps treated as US Eastern (UTC-4). */
export function parseEndDateIso(raw: string | undefined | null): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.floor(t / 1000);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-04:00`;
    t = Date.parse(iso);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return null;
}

export function bidF64(p: TokenPrice): number {
  return p.bid ?? 0;
}

export function askF64(p: TokenPrice): number {
  if (p.ask != null) return p.ask;
  if (p.bid != null) return p.bid;
  return 0;
}

export function firstBuyUnitsAndInvestment(baseShares: number, price: number): { units: number; investment: number } {
  const minUnits = Math.max(MIN_FIRST_BUY_COST / price, baseShares);
  const units = Math.ceil(minUnits * 100) / 100;
  const investment = units * price;
  return { units, investment };
}

async function fetchTokenPrice(api: PolymarketApi, tokenId: string): Promise<TokenPrice | null> {
  try {
    const bid = await api.getPrice(tokenId, "BUY");
    const ask = await api.getPrice(tokenId, "SELL");
    return { token_id: tokenId, bid, ask };
  } catch {
    return null;
  }
}

/** Trailing state; `fb` = first leg filled, trail opposite ask like `wf` (local low + spike reset + bounce). */
type St =
  | { k: "wf"; low0: number; high0: number; low1: number; high1: number }
  | { k: "wf3"; low0: number; high0: number; low1: number; high1: number; low2: number; high2: number }
  | {
      k: "fb";
      first0: boolean;
      firstPrice: number;
      shares: number;
      oppLow: number;
      oppHigh: number;
    }
  | {
      k: "fb3";
      firstIdx: number;
      firstPrice: number;
      shares: number;
      rem1L: number;
      rem1H: number;
      rem2L: number;
      rem2H: number;
    }
  | { k: "done" };

async function execBuy(
  simulation: boolean,
  client: ClobClient | null,
  orderOpts: { tickSize: ClobMarketDetails["tickSize"]; negRisk: boolean },
  tokenId: string,
  usdcAmount: number,
  priceHint: number,
  label: string
): Promise<boolean> {
  if (simulation || !client) {
    console.log(`[SIM] Market BUY ${label}: token ${tokenId.slice(0, 16)}… ~$${usdcAmount.toFixed(2)} @ ~${priceHint.toFixed(4)}`);
    return true;
  }
  try {
    await placeMarketBuyUsdc(client, {
      tokenId,
      usdcAmount,
      priceHint,
      tickSize: orderOpts.tickSize,
      negRisk: orderOpts.negRisk,
    });
    console.log(
      `[LIVE] Order submitted — ${label}: ~$${usdcAmount.toFixed(2)} @ ~${priceHint.toFixed(4)} (token ${tokenId.slice(0, 16)}…)`
    );
    return true;
  } catch (e) {
    console.warn(`Buy failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

export async function runSportsTrailing(
  api: PolymarketApi,
  cfg: Config,
  details: ClobMarketDetails,
  gammaEndIso: string | undefined,
  simulation: boolean,
  clobClient: ClobClient | null
): Promise<void> {
  const continuous = cfg.trading.continuous;
  const trailingStop = cfg.trading.trailing_stop_point;
  const baseShares =
    cfg.trading.trailing_shares ||
    cfg.trading.fixed_trade_amount / 0.5 ||
    10;
  const checkMs = cfg.trading.check_interval_ms;
  const stopLossPoint = cfg.trading.stop_loss_point;
  const stopLossEnabled = stopLossPoint > 0;

  const conditionId = details.condition_id;
  const numTokens = details.tokens.length;
  if (numTokens < 2 || numTokens > 3) throw new Error(`Need 2–3 outcome tokens, got ${numTokens}`);

  let outcomeNames = details.tokens.map((t) => t.outcome);
  const token0Id = details.tokens[0].token_id;
  const token1Id = details.tokens[1].token_id;
  const token2Id = numTokens >= 3 ? details.tokens[2].token_id : "";
  const out0 = outcomeNames[0];
  const out1 = outcomeNames[1];
  const out2 = numTokens >= 3 ? outcomeNames[2] : "";

  const endTs =
    parseEndDateIso(details.end_date_iso) ??
    parseEndDateIso(gammaEndIso);
  const gameStartTs = parseEndDateIso(details.game_start_time || undefined);

  {
    const now0 = Math.floor(Date.now() / 1000);
    if (gameStartTs != null) {
      console.log(
        `game_start_time=${new Date(gameStartTs * 1000).toISOString()} | ${formatGameClock(gameStartTs, now0)}`
      );
    } else {
      console.log("No CLOB game_start_time; price lines cannot show until/since game start.");
    }
  }

  const orderOpts = { tickSize: details.tickSize, negRisk: details.negRisk };

  let st: St =
    numTokens === 3
      ? { k: "wf3", low0: 1, high0: 0, low1: 1, high1: 0, low2: 1, high2: 0 }
      : { k: "wf", low0: 1, high0: 0, low1: 1, high1: 0 };

  let firstPriceLogged = false;
  let priceLogCounter = 0;
  let iterationsSinceClosed = 0;

  const periodTimestamp = endTs != null ? Math.max(0, endTs - 3600) : 0;

  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    const timeRemaining = endTs != null ? Math.max(0, endTs - now) : 999_999;
    const gameClock = formatGameClock(gameStartTs, now);

    iterationsSinceClosed += 1;
    const shouldCheckClosed = timeRemaining === 0 || iterationsSinceClosed >= CLOSED_CHECK_INTERVAL;
    if (shouldCheckClosed) {
      iterationsSinceClosed = 0;
      try {
        const refresh = await api.getClobMarketDetails(conditionId);
        if (refresh.closed) {
          console.log("Market closed (API). Exiting.");
          return;
        }
        if (timeRemaining === 0) {
          console.log("Past end_date_iso but market still open (API); continuing.");
        }
      } catch (e) {
        console.warn(`Could not refresh market status: ${e}. Continuing.`);
      }
    }

    let p0: TokenPrice;
    let p1: TokenPrice;
    let p2: TokenPrice | null = null;
    if (numTokens === 3) {
      const [a, b, c] = await Promise.all([
        fetchTokenPrice(api, token0Id),
        fetchTokenPrice(api, token1Id),
        fetchTokenPrice(api, token2Id),
      ]);
      if (!a || !b || !c) {
        console.log(" price fetch missed; retrying…");
        await sleep(checkMs);
        continue;
      }
      p0 = a;
      p1 = b;
      p2 = c;
    } else {
      const [a, b] = await Promise.all([fetchTokenPrice(api, token0Id), fetchTokenPrice(api, token1Id)]);
      if (!a || !b) {
        console.log("Price fetch missed; retrying…");
        await sleep(checkMs);
        continue;
      }
      p0 = a;
      p1 = b;
    }

    const ask0 = askF64(p0);
    const ask1 = askF64(p1);
    const ask2 = p2 ? askF64(p2) : 0;
    const bid0 = bidF64(p0);
    const bid1 = bidF64(p1);
    const bid2 = p2 ? bidF64(p2) : 0;

    if (!firstPriceLogged) {
      firstPriceLogged = true;
      if (numTokens === 3) {
        console.log(
          `Price OK | ${out0} ${bid0.toFixed(4)}/${ask0.toFixed(4)} | ${out1} ${bid1.toFixed(4)}/${ask1.toFixed(4)} | ${out2} ${bid2.toFixed(4)}/${ask2.toFixed(4)}`
        );
      } else {
        console.log(`Price OK | ${out0} ${bid0.toFixed(4)}/${ask0.toFixed(4)} | ${out1} ${bid1.toFixed(4)}/${ask1.toFixed(4)}`);
      }
    }

    priceLogCounter += 1;
    if (priceLogCounter >= 1) {
      priceLogCounter = 0;
      if (numTokens === 3 && st.k === "wf3") {
        const l0 = st.low0;
        const l1 = st.low1;
        const l2 = st.low2;
        console.log(
          `Prices | ${out0} ${bid0.toFixed(4)}/${ask0.toFixed(4)} … ${gameClock} | lows+tr ${(l0 + trailingStop).toFixed(4)} ${(l1 + trailingStop).toFixed(4)} ${(l2 + trailingStop).toFixed(4)}`
        );
      } else if (numTokens === 2 && st.k === "wf") {
        console.log(
          `Prices | ${out0} ${bid0.toFixed(4)}/${ask0.toFixed(4)} | ${out1} ${bid1.toFixed(4)}/${ask1.toFixed(4)} | ${gameClock}`
        );
      }
    }

    if (st.k === "wf") {
      const oldH0 = st.high0;
      const oldH1 = st.high1;
      st.low0 = Math.min(st.low0, ask0);
      st.high0 = Math.max(st.high0, ask0);
      st.low1 = Math.min(st.low1, ask1);
      st.high1 = Math.max(st.high1, ask1);
      const trigger0 = st.low0 + trailingStop;
      const trigger1 = st.low1 + trailingStop;
      if (ask0 > oldH0) st.low0 = ask0;
      if (ask1 > oldH1) st.low1 = ask1;
      const buy0 = ask0 >= trigger0 && ask0 <= oldH0;
      const buy1 = ask1 >= trigger1 && ask1 <= oldH1;
      const u0 = ask0 < 0.5;
      const u1 = ask1 < 0.5;
      const d0 = buy0 && u0;
      const d1 = buy1 && u1;
      let first0 = false;
      let price = 0;
      if (d0 && (!d1 || ask0 <= ask1)) {
        first0 = true;
        price = ask0;
      } else if (d1) {
        first0 = false;
        price = ask1;
      }
      if (d0 || d1) {
        const { units, investment } = firstBuyUnitsAndInvestment(baseShares, price);
        const tokenId = first0 ? token0Id : token1Id;
        const oppAsk = first0 ? ask1 : ask0;
        const ok = await execBuy(simulation, clobClient, orderOpts, tokenId, investment, price, `${first0 ? out0 : out1} first`);
        if (ok) {
          console.log(`Trailing first buy: ${first0 ? out0 : out1} @ $${price.toFixed(4)} x ${units} (cost $${investment.toFixed(2)})`);
          st = {
            k: "fb",
            first0,
            firstPrice: price,
            shares: units,
            oppLow: oppAsk,
            oppHigh: oppAsk,
          };
        } else {
          st = { k: "wf", low0: ask0, high0: ask0, low1: ask1, high1: ask1 };
        }
        await sleep(checkMs);
        continue;
      }
    } else if (st.k === "wf3") {
      const oldH0 = st.high0;
      const oldH1 = st.high1;
      const oldH2 = st.high2;
      st.low0 = Math.min(st.low0, ask0);
      st.high0 = Math.max(st.high0, ask0);
      st.low1 = Math.min(st.low1, ask1);
      st.high1 = Math.max(st.high1, ask1);
      st.low2 = Math.min(st.low2, ask2);
      st.high2 = Math.max(st.high2, ask2);
      const trigger0 = st.low0 + trailingStop;
      const trigger1 = st.low1 + trailingStop;
      const trigger2 = st.low2 + trailingStop;
      if (ask0 > oldH0) st.low0 = ask0;
      if (ask1 > oldH1) st.low1 = ask1;
      if (ask2 > oldH2) st.low2 = ask2;
      const b0 = ask0 >= trigger0 && ask0 <= oldH0;
      const b1 = ask1 >= trigger1 && ask1 <= oldH1;
      const b2 = ask2 >= trigger2 && ask2 <= oldH2;
      const d0 = b0 && ask0 < 0.5;
      const d1 = b1 && ask1 < 0.5;
      const d2 = b2 && ask2 < 0.5;
      let fi = -1;
      let pr = 0;
      if (d0 && (!d1 || ask0 <= ask1) && (!d2 || ask0 <= ask2)) {
        fi = 0;
        pr = ask0;
      } else if (d1 && (!d2 || ask1 <= ask2)) {
        fi = 1;
        pr = ask1;
      } else if (d2) {
        fi = 2;
        pr = ask2;
      } else {
        fi = -1;
      }
      if (fi >= 0) {
        const ids = [token0Id, token1Id, token2Id];
        const outs = [out0, out1, out2];
        const { units, investment } = firstBuyUnitsAndInvestment(baseShares, pr);
        const tid = ids[fi];
        const rem1 = (fi + 1) % 3;
        const rem2 = (fi + 2) % 3;
        const asks = [ask0, ask1, ask2];
        const ok = await execBuy(simulation, clobClient, orderOpts, tid, investment, pr, `${outs[fi]} first (3-way)`);
        if (ok) {
          console.log(`Trailing first buy (3-way): ${outs[fi]} @ $${pr.toFixed(4)} x ${units}`);
          st = {
            k: "fb3",
            firstIdx: fi,
            firstPrice: pr,
            shares: units,
            rem1L: asks[rem1],
            rem1H: asks[rem1],
            rem2L: asks[rem2],
            rem2H: asks[rem2],
          };
        } else {
          st = { k: "wf3", low0: ask0, high0: ask0, low1: ask1, high1: ask1, low2: ask2, high2: ask2 };
        }
        await sleep(checkMs);
        continue;
      }
    } else if (st.k === "fb") {
      const oppAsk = st.first0 ? ask1 : ask0;
      const oppId = st.first0 ? token1Id : token0Id;
      const oppOut = st.first0 ? out1 : out0;
      const pairSum = st.firstPrice + oppAsk;
      const slThreshold = 1 + stopLossPoint;
      if (stopLossEnabled && pairSum > slThreshold) {
        const inv = st.shares * oppAsk;
        console.log(
          `Prices | ${out0} ${bid0.toFixed(4)}/${ask0.toFixed(4)} | ${out1} ${bid1.toFixed(4)}/${ask1.toFixed(4)} | ${gameClock} | STOP_LOSS pair_sum=${pairSum.toFixed(4)} > ${slThreshold.toFixed(4)} (${oppOut} ask=${oppAsk.toFixed(4)})`
        );
        const ok = await execBuy(simulation, clobClient, orderOpts, oppId, inv, oppAsk, `${oppOut} stop-loss`);
        if (ok) {
          console.log(
            `Stop loss (pair): bought ${oppOut} @ $${oppAsk.toFixed(4)} x ${st.shares} — resetting trailing`
          );
          st = continuous
            ? { k: "wf", low0: 1, high0: 0, low1: 1, high1: 0 }
            : { k: "done" };
        }
        await sleep(checkMs);
        continue;
      }
      const oldOppHigh = st.oppHigh;
      st.oppLow = Math.min(st.oppLow, oppAsk);
      st.oppHigh = Math.max(st.oppHigh, oppAsk);
      const trigger = st.oppLow + trailingStop;
      if (oppAsk > oldOppHigh) st.oppLow = oppAsk;
      const fireSecond = oppAsk >= trigger && oppAsk <= oldOppHigh;
      console.log(
        `Prices | ${out0} ${bid0.toFixed(4)}/${ask0.toFixed(4)} | ${out1} ${bid1.toFixed(4)}/${ask1.toFixed(4)} | ${gameClock} | opp=${oppOut} ask=${oppAsk.toFixed(4)} trail_low=${st.oppLow.toFixed(4)} trig=${trigger.toFixed(4)}`
      );
      if (fireSecond) {
        const inv = st.shares * oppAsk;
        const ok = await execBuy(simulation, clobClient, orderOpts, oppId, inv, oppAsk, `${oppOut} second`);
        if (ok) {
          console.log(`Trailing second buy: ${oppOut} @ $${oppAsk.toFixed(4)} x ${st.shares}`);
          st = continuous
            ? { k: "wf", low0: 1, high0: 0, low1: 1, high1: 0 }
            : { k: "done" };
        }
        await sleep(checkMs);
        continue;
      }
      await sleep(checkMs);
      continue;
    } else if (st.k === "fb3") {
      const rem1Idx = (st.firstIdx + 1) % 3;
      const rem2Idx = (st.firstIdx + 2) % 3;
      const asks = [ask0, ask1, ask2];
      const ids = [token0Id, token1Id, token2Id];
      const outs = [out0, out1, out2];
      const r1a = asks[rem1Idx];
      const r2a = asks[rem2Idx];
      const minRemAsk = Math.min(r1a, r2a);
      const slThreshold3 = 1 + stopLossPoint;
      if (stopLossEnabled && st.firstPrice + minRemAsk > slThreshold3) {
        const pickR1 = r1a <= r2a;
        const idx = pickR1 ? rem1Idx : rem2Idx;
        const oppAskSl = pickR1 ? r1a : r2a;
        const pairSum3 = st.firstPrice + oppAskSl;
        console.log(
          `Prices | … STOP_LOSS (3-way) pair_sum=${pairSum3.toFixed(4)} > ${slThreshold3.toFixed(4)} → ${outs[idx]} @ ${oppAskSl.toFixed(4)}`
        );
        const inv = st.shares * oppAskSl;
        const ok = await execBuy(simulation, clobClient, orderOpts, ids[idx], inv, oppAskSl, `${outs[idx]} stop-loss (3-way)`);
        if (ok) {
          console.log(`Stop loss (3-way): bought ${outs[idx]} @ $${oppAskSl.toFixed(4)} x ${st.shares} — resetting trailing`);
          st = continuous
            ? { k: "wf3", low0: 1, high0: 0, low1: 1, high1: 0, low2: 1, high2: 0 }
            : { k: "done" };
        }
        await sleep(checkMs);
        continue;
      }
      const oldR1h = st.rem1H;
      const oldR2h = st.rem2H;
      st.rem1L = Math.min(st.rem1L, r1a);
      st.rem1H = Math.max(st.rem1H, r1a);
      st.rem2L = Math.min(st.rem2L, r2a);
      st.rem2H = Math.max(st.rem2H, r2a);
      if (r1a > oldR1h) st.rem1L = r1a;
      if (r2a > oldR2h) st.rem2L = r2a;
      const tr1 = st.rem1L + trailingStop;
      const tr2 = st.rem2L + trailingStop;
      const br1 = r1a >= tr1 && r1a <= oldR1h;
      const br2 = r2a >= tr2 && r2a <= oldR2h;
      if (!br1 && !br2) {
        await sleep(checkMs);
        continue;
      }
      const pick1 = br1 && (!br2 || r1a <= r2a);
      const idx = pick1 ? rem1Idx : rem2Idx;
      const oppAsk = pick1 ? r1a : r2a;
      const inv = st.shares * oppAsk;
      const ok = await execBuy(simulation, clobClient, orderOpts, ids[idx], inv, oppAsk, `${outs[idx]} second (3-way)`);
      if (ok) {
        console.log(`Trailing second buy (3-way): ${outs[idx]} @ $${oppAsk.toFixed(4)} x ${st.shares}`);
        st = continuous
          ? { k: "wf3", low0: 1, high0: 0, low1: 1, high1: 0, low2: 1, high2: 0 }
          : { k: "done" };
      }
      await sleep(checkMs);
      continue;
    } else if (st.k === "done") {
      if (!continuous) {
        await sleep(checkMs);
        continue;
      }
      if (numTokens === 3) {
        st = { k: "wf3", low0: ask0, high0: ask0, low1: ask1, high1: ask1, low2: ask2, high2: ask2 };
      } else {
        st = { k: "wf", low0: ask0, high0: ask0, low1: ask1, high1: ask1 };
      }
    }

    await sleep(checkMs);
  }
}