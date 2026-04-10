import axios, { type AxiosInstance } from "axios";
import type { TickSize } from "@polymarket/clob-client";
import type { GammaMarket, ClobMarketDetails, TokenMeta } from "./types.js";
import type { PolymarketConfig } from "./config.js";

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function num(v: unknown, d = 0): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : d;
}

export function decimalToTickSize(raw: unknown): TickSize {
  const n = num(raw, 0.01);
  const s = n.toString();
  const allowed: TickSize[] = ["0.1", "0.01", "0.001", "0.0001"];
  if (allowed.includes(s as TickSize)) return s as TickSize;
  if (n >= 0.1) return "0.1";
  if (n >= 0.01) return "0.01";
  if (n >= 0.001) return "0.001";
  return "0.0001";
}

export class PolymarketApi {
  public readonly clobUrl: string;
  private gammaClient: AxiosInstance;

  constructor(cfg: PolymarketConfig) {
    const gammaUrl = cfg.gamma_api_url.replace(/\/$/, "");
    this.clobUrl = cfg.clob_api_url.replace(/\/$/, "");
    this.gammaClient = axios.create({
      baseURL: gammaUrl,
      timeout: 15_000,
      headers: { "Content-Type": "application/json" },
    });
  }

  async getMarketBySlug(slug: string): Promise<GammaMarket> {
    const { data } = await this.gammaClient.get<{ markets?: unknown[] }>(
      `/events/slug/${encodeURIComponent(slug)}`
    );
    const markets = data?.markets;
    if (!Array.isArray(markets) || markets.length === 0) {
      throw new Error(`No markets for slug: ${slug}`);
    }
    const raw = markets[0] as Record<string, unknown>;
    const conditionId = str(raw.conditionId ?? raw.condition_id);
    const base: GammaMarket = {
      conditionId,
      question: str(raw.question),
      slug: str(raw.slug),
      active: Boolean(raw.active),
      closed: Boolean(raw.closed),
      id: raw.id != null ? str(raw.id) : undefined,
      endDateISO: raw.endDateISO != null ? str(raw.endDateISO) : undefined,
      endDateIso: raw.endDateIso != null ? str(raw.endDateIso) : undefined,
      outcomes: raw.outcomes != null ? str(raw.outcomes) : undefined,
      tokens: Array.isArray(raw.tokens) ? (raw.tokens as TokenMeta[]) : undefined,
      clobTokenIds: raw.clobTokenIds != null ? str(raw.clobTokenIds) : undefined,
    };
    if (Array.isArray(base.tokens) && base.tokens.length > 0) return base;
    const clob = await this.getClobMarketDetails(conditionId);
    return { ...base, tokens: clob.tokens };
  }

  async getClobMarketDetails(conditionId: string): Promise<ClobMarketDetails> {
    const { data } = await axios.get<Record<string, unknown>>(`${this.clobUrl}/markets/${conditionId}`, {
      timeout: 15_000,
    });
    const tokensRaw = data.tokens;
    const tokens: TokenMeta[] = Array.isArray(tokensRaw)
      ? (tokensRaw as Array<Record<string, unknown>>).map((t) => ({
          token_id: str(t.token_id ?? t.tokenId),
          outcome: str(t.outcome),
        }))
      : [];

    const minTick = data.minimum_tick_size ?? data.minimumTickSize ?? 0.01;
    const negRisk = Boolean(data.neg_risk ?? data.negRisk);

    return {
      condition_id: str(data.condition_id ?? data.conditionId ?? conditionId),
      closed: Boolean(data.closed),
      end_date_iso: str(data.end_date_iso ?? data.endDateIso ?? ""),
      game_start_time: str(data.game_start_time ?? data.gameStartTime ?? ""),
      tokens,
      tickSize: decimalToTickSize(minTick),
      negRisk,
    };
  }

  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number> {
    const { data } = await axios.get<{ price?: string }>(`${this.clobUrl}/price`, {
      params: { token_id: tokenId, side },
      timeout: 10_000,
    });
    const p = data?.price;
    if (p == null) throw new Error("Invalid /price response");
    const n = parseFloat(String(p));
    if (!Number.isFinite(n)) throw new Error(`Bad price: ${p}`);
    return n;
  }
}
