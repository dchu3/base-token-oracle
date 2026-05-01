/**
 * Classifies a token holder address into a coarse category. The goal is to
 * let consumers reason about *who* the top-10 holders are so a high
 * concentration figure isn't misread when most of the supply lives in a
 * Uniswap pool, the canonical Base bridge, or a burn sink.
 *
 * Classification is intentionally lightweight:
 *  - `burn`    — known sinks where supply is provably non-recoverable
 *  - `bridge`  — known canonical bridge / messaging contracts on Base
 *  - `deployer`— matches the token's `creator_address_hash`
 *  - `contract`— any other contract (LPs, vaults, multisigs, routers)
 *  - `eoa`     — externally-owned account
 *  - `unknown` — Blockscout lookup failed or returned no `is_contract`
 *
 * The static address sets below are deliberately small and conservative;
 * they are easy to extend without changing the API contract.
 */

export const HOLDER_CATEGORIES = [
  'burn',
  'bridge',
  'deployer',
  'contract',
  'eoa',
  'unknown',
] as const;

export type HolderCategory = (typeof HOLDER_CATEGORIES)[number];

/** Addresses where supply is considered destroyed. */
export const BURN_ADDRESSES = new Set<string>([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
]);

/**
 * Canonical bridge / cross-chain messaging contracts on Base mainnet.
 * Balances held by these addresses represent supply that is locked on
 * Base while a wrapped representation circulates on another chain (or
 * vice-versa) — not free-float concentration.
 */
export const BRIDGE_ADDRESSES = new Set<string>([
  // Base canonical L1<->L2 bridge (L2StandardBridge predeploy)
  '0x4200000000000000000000000000000000000010',
  // LayerZero Endpoint v2 on Base
  '0x1a44076050125825900e736c501f859c50fe728c',
  // Wormhole TokenBridge on Base
  '0x8d2de8d2f73f1f4cab472ac9a881c9b123c79627',
]);

/**
 * Returns the category for a holder. `isContract` should come from
 * Blockscout's `getAddress` lookup; pass `null` when the lookup failed
 * so the caller can surface `unknown` instead of misclassifying as EOA.
 */
export function classifyHolder(
  address: string,
  isContract: boolean | null,
  deployerAddress: string | null,
): HolderCategory {
  const a = address.toLowerCase();
  if (BURN_ADDRESSES.has(a)) return 'burn';
  if (BRIDGE_ADDRESSES.has(a)) return 'bridge';
  if (deployerAddress && a === deployerAddress.toLowerCase()) return 'deployer';
  if (isContract === true) return 'contract';
  if (isContract === false) return 'eoa';
  return 'unknown';
}

/** Categories whose balances are excluded from the circulating denominator. */
export const NON_CIRCULATING_CATEGORIES: ReadonlySet<HolderCategory> = new Set<HolderCategory>([
  'burn',
  'bridge',
]);
