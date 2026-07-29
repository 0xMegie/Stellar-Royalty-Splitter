import { describe, test, expect } from "@jest/globals";
import {
  recordSecondarySaleSchema,
  initializeSchema,
  MAX_NFT_ID_LENGTH,
  MAX_COLLABORATORS_BACKEND,
} from "../src/validation.js";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "CTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SELLER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BUYER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function makeSalePayload(overrides = {}) {
  return {
    contractId: CONTRACT,
    walletAddress: WALLET,
    nftId: "nft-001",
    previousOwner: SELLER,
    newOwner: BUYER,
    salePrice: 1_000_000,
    saleToken: TOKEN,
    royaltyRate: 500,
    ...overrides,
  };
}

describe("recordSecondarySaleSchema — nftId size limits", () => {
  test("accepts nftId at exactly MAX_NFT_ID_LENGTH characters", () => {
    const nftId = "a".repeat(MAX_NFT_ID_LENGTH);
    const result = recordSecondarySaleSchema.safeParse(makeSalePayload({ nftId }));
    expect(result.success).toBe(true);
  });

  test("rejects nftId one character over the limit", () => {
    const nftId = "a".repeat(MAX_NFT_ID_LENGTH + 1);
    const result = recordSecondarySaleSchema.safeParse(makeSalePayload({ nftId }));
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(" ");
    expect(msg).toMatch(new RegExp(String(MAX_NFT_ID_LENGTH)));
  });

  test("rejects empty nftId", () => {
    const result = recordSecondarySaleSchema.safeParse(makeSalePayload({ nftId: "" }));
    expect(result.success).toBe(false);
  });

  test("accepts typical short nftId", () => {
    const result = recordSecondarySaleSchema.safeParse(makeSalePayload({ nftId: "nft-abc-123" }));
    expect(result.success).toBe(true);
  });
});

function makeCollaborators(n) {
  const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return Array.from({ length: n }, (_, i) => {
    const c1 = base32[Math.floor(i / 32) % 32];
    const c2 = base32[i % 32];
    return "G" + c1 + c2 + "A".repeat(53);
  });
}

describe("initializeSchema — collaborator list size limits", () => {
  test("accepts MAX_COLLABORATORS_BACKEND collaborators when shares sum to 10000", () => {
    const n = MAX_COLLABORATORS_BACKEND;
    const collaborators = makeCollaborators(n);
    const share = Math.floor(10000 / n);
    const shares = Array(n).fill(share);
    // Adjust last share for rounding
    shares[n - 1] = 10000 - share * (n - 1);

    const result = initializeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaborators,
      shares,
    });
    expect(result.success).toBe(true);
  });

  test("rejects collaborator list exceeding MAX_COLLABORATORS_BACKEND", () => {
    const n = MAX_COLLABORATORS_BACKEND + 1;
    const collaborators = makeCollaborators(n);
    const shares = Array(n).fill(0);
    shares[0] = 10000;

    const result = initializeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaborators,
      shares,
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty collaborator list", () => {
    const result = initializeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaborators: [],
      shares: [],
    });
    expect(result.success).toBe(false);
  });
});
