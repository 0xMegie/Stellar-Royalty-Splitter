/**
 * Freighter wallet integration for signing and submitting transactions.
 * Single responsibility: wallet interaction only.
 * For transaction building, use stellar SDK directly.
 * For formatting, use utils/format.ts.
 */

import { TransactionBuilder, Networks, SorobanRpc } from "@stellar/stellar-sdk";
import { FREIGHTER_NETWORK_NAMES, type Network } from "./context/NetworkContext";

const RPC_URLS: Record<Network, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

/**
 * Sign and submit a transaction XDR with Freighter wallet
 */
export async function signAndSubmitTransaction(
  xdrString: string,
  network: Network = "testnet",
): Promise<string> {
  // @ts-ignore
  if (!window.freighter)
    throw new Error("Freighter wallet not found. Install it at freighter.app");

  const passphrase = NETWORK_PASSPHRASES[network];
  const rpcUrl = RPC_URLS[network];
  const server = new SorobanRpc.Server(rpcUrl);

  // @ts-ignore
  const signedXdr = await window.freighter.signTransaction(xdrString, {
    network: FREIGHTER_NETWORK_NAMES[network],
  });

  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  const sendResult = await server.sendTransaction(tx);

  if (sendResult.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
    );
  }

  const hash = sendResult.hash;

  // Poll for confirmation (max 30s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const result = await server.getTransaction(hash);
    if (result.status === "SUCCESS") return hash;
    if (result.status === "FAILED")
      throw new Error(`Transaction failed on-chain: ${hash}`);
  }

  throw new Error(`Transaction confirmation timed out: ${hash}`);
}
