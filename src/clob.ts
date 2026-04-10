import { ethers } from "ethers";
import { ClobClient, Chain, Side, OrderType, type ApiKeyCreds } from "@polymarket/clob-client";
import type { PolymarketConfig } from "./config.js";

export function createWallet(privateKey: string): ethers.Wallet {
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  return new ethers.Wallet(key);
}

export async function createClobClient(cfg: PolymarketConfig): Promise<ClobClient> {
  const pk = cfg.private_key;
  if (!pk) throw new Error("private_key is required for live trading");
  const wallet = createWallet(pk);
  const host = cfg.clob_api_url.replace(/\/$/, "");
  const signatureType = cfg.signature_type ?? 0;
  const funderAddress =
    (signatureType === 1 || signatureType === 2) && cfg.proxy_wallet_address
      ? cfg.proxy_wallet_address
      : undefined;

  let creds: ApiKeyCreds | null = null;
  const client = new ClobClient(host, Chain.POLYGON, wallet, undefined, signatureType, funderAddress);
  try {
    const derived = await client.deriveApiKey();
    if (derived?.key && derived?.secret && derived?.passphrase) creds = derived;
  } catch {
    /* empty */
  }
  if (!creds) {
    const created = await client.createApiKey();
    if (created?.key && created?.secret && created?.passphrase) creds = created;
  }

  if (!creds) {
    throw new Error(
      "Could not obtain CLOB API credentials from the wallet (deriveApiKey / createApiKey failed). Check private_key and proxy_wallet_address / signature_type."
    );
  }

  return new ClobClient(host, Chain.POLYGON, wallet, creds, signatureType, funderAddress);
}

export async function verifyClobAuth(client: ClobClient): Promise<void> {
  const res = await client.getApiKeys();
  const status = (res as { status?: number }).status;
  const error = (res as { error?: string }).error;
  if (status === 401 || (error && String(error).toLowerCase().includes("unauthorized"))) {
    throw new Error(
      "Polymarket CLOB auth failed (401). Check private_key and proxy_wallet_address / signature_type."
    );
  }
}

export interface MarketBuyParams {
  tokenId: string;
  usdcAmount: number;
  priceHint: number;
  tickSize: import("@polymarket/clob-client").TickSize;
  negRisk: boolean;
}

export async function placeMarketBuyUsdc(client: ClobClient, p: MarketBuyParams): Promise<void> {
  await client.createAndPostMarketOrder(
    {
      tokenID: p.tokenId,
      side: Side.BUY,
      amount: p.usdcAmount,
      price: Math.min(0.99, Math.max(0.01, p.priceHint)),
    },
    { tickSize: p.tickSize, negRisk: p.negRisk },
    OrderType.FOK
  );
}
