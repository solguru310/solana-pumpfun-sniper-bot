import type { TickSize } from "@polymarket/clob-client";

export interface TokenMeta {
  token_id: string;
  outcome: string;
}

export interface GammaMarket {
  conditionId: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  id?: string;
  endDateISO?: string;
  endDateIso?: string;
  outcomes?: string;
  tokens?: TokenMeta[];
  clobTokenIds?: string;
}

export interface ClobMarketDetails {
  condition_id: string;
  closed: boolean;
  /** Polymarket resolution / order lifecycle end (often days after the event for sports). */
  end_date_iso: string;
  /** Scheduled event start from CLOB when present (sports); empty if API omits it. */
  game_start_time: string;
  tokens: TokenMeta[];
  tickSize: TickSize;
  negRisk: boolean;
}

export interface TokenPrice {
  token_id: string;
  bid: number | null;
  ask: number | null;
}
