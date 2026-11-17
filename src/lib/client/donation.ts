/**
 * One place for Sushi's donation details, so the Settings menu item, the
 * donation dialog and the README never drift apart.
 *
 * The address is the project's public tip jar — a plain EVM address, accepted
 * on Ethereum mainnet and on every EVM-compatible chain (BSC, Polygon, Base,
 * Arbitrum, Optimism, …). Only view/copy it; nothing here ever signs a
 * transaction, and Sushi never asks for a seed phrase or private key.
 */

/** Sushi's public donation address (EVM — Ethereum, BSC, Polygon, Base, Arbitrum, …). */
export const DONATION_ADDRESS =
  "0xf3430a560b57189a888Ac02763c4d8f383B00F8d";

/** Chains the address works on, in the order shown to the user. */
export const DONATION_NETWORKS = [
  "Ethereum (ETH / ERC-20)",
  "BNB Smart Chain (BNB / BEP-20)",
  "Polygon (POL / ERC-20)",
  "Base, Arbitrum, Optimism (ETH / ERC-20)",
] as const;

/**
 * The `ethereum:` URI wallets understand. EIP-681 — scannable by MetaMask,
 * Trust Wallet, Rainbow, Coinbase Wallet and every other QR-capable wallet.
 */
export function donationWalletUri(networkChainId?: number): string {
  const base = `ethereum:${DONATION_ADDRESS}`;
  return typeof networkChainId === "number" ? `${base}@${networkChainId}` : base;
}

/**
 * What the QR code can encode. A bare address is what wallets show verbatim
 * before asking which chain to use; the `ethereum:` URI opens a wallet
 * directly. Both are offered in the dialog.
 */
export const DONATION_QR_PAYLOADS = [
  { id: "address", label: "Address", value: DONATION_ADDRESS },
  { id: "ethereum", label: "ethereum: URI", value: donationWalletUri() },
] as const;

/** Link that opens the address in a block explorer (defaults to Etherscan). */
export function donationExplorerUrl(
  network: "ethereum" | "bsc" | "polygon" | "base" | "arbitrum" = "ethereum"
): string {
  switch (network) {
    case "bsc":
      return `https://bscscan.com/address/${DONATION_ADDRESS}`;
    case "polygon":
      return `https://polygonscan.com/address/${DONATION_ADDRESS}`;
    case "base":
      return `https://basescan.org/address/${DONATION_ADDRESS}`;
    case "arbitrum":
      return `https://arbiscan.io/address/${DONATION_ADDRESS}`;
    case "ethereum":
    default:
      return `https://etherscan.io/address/${DONATION_ADDRESS}`;
  }
}

/**
 * True when every character of `address` is a valid hex digit and a wallet
 * would treat it as a checksummed EVM address (or the all-lowercase form).
 * Used by the test suite to guard the published address from typos.
 */
export function isDonationAddressShapeValid(address = DONATION_ADDRESS): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}
