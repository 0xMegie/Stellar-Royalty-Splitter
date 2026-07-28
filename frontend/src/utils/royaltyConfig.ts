/**
 * JSON import/export format for royalty split configurations (#666, #665).
 *
 * Mirrors the collaborator address/percentage rules enforced by
 * InitializeForm.tsx so an imported file can only ever produce a
 * collaborator list that the contract's `initialize()` would accept.
 */

// Same shape InitializeForm.tsx uses internally: basisPoints holds the
// *percentage* (0-100) entered by the user, not raw contract basis points.
export interface RoyaltyConfigCollaborator {
  address: string;
  basisPoints: string;
}

export interface RoyaltyConfigFile {
  version: number;
  createdAt: string;
  collaborators: Array<{ address: string; percentage: number }>;
}

export const ROYALTY_CONFIG_VERSION = 1;

// Mirrors InitializeForm.tsx's STELLAR_ADDRESS_RE / MAX_COLLABORATORS.
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const MAX_COLLABORATORS = 50;

export class RoyaltyConfigImportError extends Error {
  errors: string[];

  constructor(errors: string[]) {
    super(errors[0] ?? "Invalid royalty configuration file.");
    this.name = "RoyaltyConfigImportError";
    this.errors = errors;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates the raw text of an imported royalty configuration
 * JSON file. Treats the input as untrusted: every field is checked before
 * any value is used. Throws `RoyaltyConfigImportError` (with all collected
 * error messages) rather than returning partially-valid data.
 */
export function parseRoyaltyConfigImport(raw: string): RoyaltyConfigCollaborator[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RoyaltyConfigImportError(["File is not valid JSON."]);
  }

  if (!isPlainObject(parsed)) {
    throw new RoyaltyConfigImportError([
      "File must contain a JSON object with a \"collaborators\" array.",
    ]);
  }

  const { collaborators } = parsed as Record<string, unknown>;
  if (!Array.isArray(collaborators) || collaborators.length === 0) {
    throw new RoyaltyConfigImportError([
      "\"collaborators\" must be a non-empty array.",
    ]);
  }

  if (collaborators.length > MAX_COLLABORATORS) {
    throw new RoyaltyConfigImportError([
      `Too many collaborators (${collaborators.length}). Maximum is ${MAX_COLLABORATORS}.`,
    ]);
  }

  const errors: string[] = [];
  const seenAddresses = new Set<string>();
  const result: RoyaltyConfigCollaborator[] = [];
  let total = 0;

  collaborators.forEach((entry, i) => {
    const row = i + 1;
    if (!isPlainObject(entry)) {
      errors.push(`Row ${row}: must be an object with "address" and "percentage".`);
      return;
    }

    const { address, percentage } = entry as Record<string, unknown>;

    if (typeof address !== "string" || !STELLAR_ADDRESS_RE.test(address)) {
      errors.push(`Row ${row}: "address" must be a valid Stellar address (G..., 56 chars).`);
      return;
    }

    if (seenAddresses.has(address)) {
      errors.push(`Row ${row}: duplicate collaborator address "${address}".`);
      return;
    }

    if (
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      percentage <= 0 ||
      percentage > 100
    ) {
      errors.push(`Row ${row}: "percentage" must be a number greater than 0 and up to 100.`);
      return;
    }

    seenAddresses.add(address);
    total += percentage;
    result.push({ address, basisPoints: String(percentage) });
  });

  if (errors.length > 0) {
    throw new RoyaltyConfigImportError(errors);
  }

  // Contract requires stored shares to sum to exactly 10,000 basis points (100%).
  if (Math.round(total * 100) !== 10_000) {
    throw new RoyaltyConfigImportError([
      `Collaborator percentages must sum to 100% (file totals ${total.toFixed(2)}%).`,
    ]);
  }

  return result;
}
