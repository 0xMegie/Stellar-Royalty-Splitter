import React, { useState, useEffect, useCallback, useRef } from "react";
import { api, RoyaltyTemplate, RoyaltyTemplateAllocation } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import FormStatus from "./FormStatus";
import ValidationSummary, {
  type ValidationSummaryIssue,
} from "./ValidationSummary";
import { useFormStatus } from "../hooks/useFormStatus";
import { useRoyaltyDraft } from "../hooks/useRoyaltyDraft";
import {
  parseRoyaltyConfigImport,
  RoyaltyConfigImportError,
  buildRoyaltyConfigExport,
  downloadRoyaltyConfig,
  RoyaltyConfigExportError,
} from "../utils/royaltyConfig";

interface Collaborator {
  address: string;
  basisPoints: string;
}

interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const MAX_COLLABORATORS = 50;
const PERCENTAGE_INPUT_RE = /^(\d+(\.\d*)?|\.\d+)?$/;
const SIGNED_PERCENTAGE_INPUT_RE = /^-(\d+(\.\d*)?|\.\d+)$/;
const PERCENTAGE_NAVIGATION_KEYS = [
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "Enter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
];

function getPercentageError(value: string) {
  if (value === "") return "Percentage is required.";
  if (SIGNED_PERCENTAGE_INPUT_RE.test(value)) {
    return "Percentage must be between 0 and 100.";
  }
  if (!PERCENTAGE_INPUT_RE.test(value)) return "Percentage must be a number.";

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return "Percentage must be a number.";
  if (numericValue < 0 || numericValue > 100) {
    return "Percentage must be between 0 and 100.";
  }

  return "";
}

function isAllowedPercentageInput(value: string) {
  return PERCENTAGE_INPUT_RE.test(value);
}

/**
 * Mirrors the backend's template allocation validation (#652) so a
 * template can be checked both before it's saved and again before it's
 * applied to the form (templates are app-level data and could in theory
 * have been created under different rules).
 */
function validateTemplateAllocations(allocations: RoyaltyTemplateAllocation[]) {
  const addresses = allocations.map((a) => a.address);
  if (new Set(addresses).size !== addresses.length) {
    return "Duplicate collaborator addresses are not allowed.";
  }
  const totalPct = allocations.reduce((sum, a) => sum + a.percentage, 0);
  if (Math.round(totalPct * 100) !== 10_000) {
    return `Percentages must sum to 100% (got ${totalPct.toFixed(2)}%).`;
  }
  return null;
}

function updatePercentageError(
  setErrors: React.Dispatch<
    React.SetStateAction<
      Record<number, { address?: string; basisPoints?: string }>
    >
  >,
  i: number,
  error: string,
) {
  setErrors((prev) => ({
    ...prev,
    [i]: {
      ...prev[i],
      basisPoints: error,
    },
  }));
}

function handlePercentageKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
  if (
    event.ctrlKey ||
    event.metaKey ||
    PERCENTAGE_NAVIGATION_KEYS.includes(event.key)
  ) {
    return;
  }

  if (!/^[0-9.]$/.test(event.key)) {
    event.preventDefault();
    return;
  }

  if (event.key === "." && event.currentTarget.value.includes(".")) {
    event.preventDefault();
  }
}

export default function InitializeForm({
  contractId,
  walletAddress,
  onSuccess,
}: Props) {
  const { network, networkMismatch } = useNetwork();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([
    { address: "", basisPoints: "" },
  ]);
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const addressRefs = useRef<(HTMLInputElement | null)[]>([]);
  const percentageRefs = useRef<(HTMLInputElement | null)[]>([]);

  function triggerImport() {
    importInputRef.current?.click();
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after a failed import.
    event.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const imported = parseRoyaltyConfigImport(text);
      setCollaborators(imported);
      setErrors({});
      setStatus(
        "ok",
        `Imported ${imported.length} collaborator(s) from ${file.name}.`,
      );
    } catch (e: unknown) {
      if (e instanceof RoyaltyConfigImportError) {
        setStatus("error", e.errors.join(" "));
      } else {
        setStatus("error", "Could not read the selected file.");
      }
    }
  }

  function handleExport() {
    try {
      const config = buildRoyaltyConfigExport(
        collaborators,
        new Date().toISOString(),
      );
      const suffix = contractId ? contractId.slice(0, 8) : "draft";
      downloadRoyaltyConfig(config, `royalty-split-${suffix}.json`);
      setStatus("ok", "Exported royalty split configuration.");
    } catch (e: unknown) {
      if (e instanceof RoyaltyConfigExportError) {
        setStatus("error", e.errors.join(" "));
      } else {
        setStatus("error", "Could not export the current configuration.");
      }
    }
  }

  // Reusable royalty split templates (#652)
  const [templates, setTemplates] = useState<RoyaltyTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateStatus, setTemplateStatus] = useState<{
    type: "ok" | "error";
    message: string;
  } | null>(null);

  const fetchTemplates = useCallback(() => {
    if (!walletAddress) return;
    setTemplatesLoading(true);
    setTemplatesError(null);
    api
      .listTemplates(walletAddress)
      .then((res) => setTemplates(res.data))
      .catch((e: unknown) =>
        setTemplatesError(
          e instanceof Error ? e.message : "Failed to load templates",
        ),
      )
      .finally(() => setTemplatesLoading(false));
  }, [walletAddress]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  function update(i: number, field: keyof Collaborator, value: string) {
    setCollaborators((prev: Collaborator[]) =>
      prev.map((c: Collaborator, idx: number) =>
        idx === i ? { ...c, [field]: value } : c,
      ),
    );
  }

  function cancelEdit() {
    setEditingIndex(-1);
    setEditBuffer({ address: "", basisPoints: "" });
    setEditErrors({});
  }

  function validateEditBuffer(buf: Collaborator) {
    const errs: { address?: string; basisPoints?: string } = {};
    if (!buf.address || !STELLAR_ADDRESS_RE.test(buf.address)) {
      errs.address = "Must be a valid Stellar address (G..., 56 chars)";
    }
    const pctErr = getPercentageError(buf.basisPoints);
    if (pctErr) errs.basisPoints = pctErr;
    return errs;
  }

  function saveEdit(i: number) {
    const errs = validateEditBuffer(editBuffer);
    if (Object.keys(errs).length > 0) {
      setEditErrors(errs);
      return;
    }
    setCollaborators((prev) =>
      prev.map((c, idx) => (idx === i ? { ...editBuffer } : c)),
    );
    setEditingIndex(-1);
    setEditBuffer({ address: "", basisPoints: "" });
    setEditErrors({});
  }

  function addRow() {
    if (collaborators.length >= MAX_COLLABORATORS) return;
    const newIndex = collaborators.length;
    setCollaborators((prev) => [...prev, { address: "", basisPoints: "" }]);
    setEditingIndex(newIndex);
    setEditBuffer({ address: "", basisPoints: "" });
    setEditErrors({});
  }

  function removeRow(i: number) {
    setCollaborators((prev) =>
      prev.filter((_: Collaborator, idx: number) => idx !== i),
    );
    if (editingIndex === i) {
      setEditingIndex(-1);
      setEditBuffer({ address: "", basisPoints: "" });
      setEditErrors({});
    } else if (editingIndex > i) {
      setEditingIndex(editingIndex - 1);
    }
  }

  async function saveAsTemplate() {
    setTemplateStatus(null);

    const name = templateName.trim();
    if (!name) {
      setTemplateStatus({
        type: "error",
        message: "Enter a name for the template.",
      });
      return;
    }
    if (hasErrors || hasEmptyFields || hasInvalidPercentages) {
      setTemplateStatus({
        type: "error",
        message:
          "Fix the collaborator allocation errors before saving as a template.",
      });
      return;
    }

    const allocations: RoyaltyTemplateAllocation[] = collaborators.map((c) => ({
      address: c.address,
      percentage: parseFloat(c.basisPoints),
    }));
    const allocationError = validateTemplateAllocations(allocations);
    if (allocationError) {
      setTemplateStatus({ type: "error", message: allocationError });
      return;
    }

    setSavingTemplate(true);
    try {
      await api.createTemplate({ walletAddress, name, allocations });
      setTemplateName("");
      setTemplateStatus({ type: "ok", message: `Saved template "${name}".` });
      fetchTemplates();
    } catch (e: unknown) {
      setTemplateStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to save template.",
      });
    } finally {
      setSavingTemplate(false);
    }
  }

  function applyTemplate(template: RoyaltyTemplate) {
    const allocationError = validateTemplateAllocations(template.allocations);
    if (allocationError) {
      setTemplateStatus({
        type: "error",
        message: `Cannot apply "${template.name}": ${allocationError}`,
      });
      return;
    }

    setCollaborators(
      template.allocations.map((a) => ({
        address: a.address,
        basisPoints: String(a.percentage),
      })),
    );
    setErrors({});
    setTemplateStatus({
      type: "ok",
      message: `Applied template "${template.name}".`,
    });
  }

  async function handleDeleteTemplate(id: number, name: string) {
    setTemplateStatus(null);
    try {
      await api.deleteTemplate(id, walletAddress);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      setTemplateStatus({ type: "ok", message: `Deleted template "${name}".` });
    } catch (e: unknown) {
      setTemplateStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to delete template.",
      });
    }
  }

  const total = collaborators.reduce(
    (sum: number, c: Collaborator) => sum + (parseFloat(c.basisPoints) || 0),
    0,
  );

  const hasUnsavedEdit = editingIndex >= 0;
  const allRowsCommitted = collaborators.every(
    (c) => c.address && c.basisPoints,
  );

  // Issue #694 — one summary of every active validation issue, derived from
  // the same per-row (getPercentageError, STELLAR_ADDRESS_RE) and aggregate
  // (share total, duplicate address) checks submit() already runs, so there
  // is only one validation implementation.
  const validationIssues: ValidationSummaryIssue[] = [];
  collaborators.forEach((c: Collaborator, i: number) => {
    if (!c.address) {
      validationIssues.push({
        index: i,
        field: "address",
        message: `Collaborator ${i + 1}: wallet address is required.`,
      });
    } else if (!STELLAR_ADDRESS_RE.test(c.address)) {
      validationIssues.push({
        index: i,
        field: "address",
        message: `Collaborator ${i + 1}: must be a valid Stellar address (G..., 56 chars).`,
      });
    }

    const percentageError = getPercentageError(c.basisPoints);
    if (percentageError) {
      validationIssues.push({
        index: i,
        field: "basisPoints",
        message: `Collaborator ${i + 1}: ${percentageError}`,
      });
    }
  });
  {
    const seen = new Set<string>();
    collaborators.forEach((c: Collaborator, i: number) => {
      if (!c.address) return;
      if (seen.has(c.address)) {
        validationIssues.push({
          index: i,
          field: "address",
          message: `Collaborator ${i + 1}: duplicate address.`,
        });
      }
      seen.add(c.address);
    });
  }
  if (Math.round(total * 100) !== 10_000) {
    validationIssues.push({
      index: -1,
      field: "basisPoints",
      message: `Percentages must sum to 100% (currently ${total.toFixed(2)}%).`,
    });
  }

  function focusField(index: number, field: "address" | "basisPoints") {
    if (field === "address") {
      addressRefs.current[index]?.focus();
    } else {
      percentageRefs.current[index]?.focus();
    }
  }

  async function submit() {
    if (networkMismatch)
      return setStatus(
        "error",
        "Your wallet is on the wrong network. Switch it before submitting.",
      );
    if (!contractId) return setStatus("error", "Enter a contract ID first.");

    if (hasUnsavedEdit) {
      return setStatus(
        "error",
        "Please save or cancel the current edit before submitting.",
      );
    }

    const nextErrors = collaborators.reduce<
      Record<number, { address?: string; basisPoints?: string }>
    >((acc, c, i) => {
      if (!c.address || !STELLAR_ADDRESS_RE.test(c.address)) {
        acc[i] = {
          ...acc[i],
          address: "Must be a valid Stellar address (G..., 56 chars)",
        };
      }
      const percentageError = getPercentageError(c.basisPoints);
      if (percentageError) {
        acc[i] = { ...acc[i], basisPoints: percentageError };
      }
      return acc;
    }, {});

    if (Object.keys(nextErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...nextErrors }));
      const firstErrorIdx = Object.keys(nextErrors)
        .map(Number)
        .sort((a, b) => a - b)[0];
      if (firstErrorIdx !== undefined) {
        const fieldErrors = nextErrors[firstErrorIdx];
        if (fieldErrors?.address) {
          addressRefs.current[firstErrorIdx]?.focus();
        } else if (fieldErrors?.basisPoints) {
          percentageRefs.current[firstErrorIdx]?.focus();
        }
      }
      return setStatus(
        "error",
        "Please fix all field errors before submitting.",
      );
    }

    if (Math.round(total * 100) !== 10_000)
      return setStatus(
        "error",
        `Percentages must sum to 100% (currently ${total.toFixed(2)}%).`,
      );

    const addresses = collaborators.map((c: Collaborator) => c.address);
    const hasDuplicates = new Set(addresses).size !== addresses.length;
    if (hasDuplicates) {
      return setStatus("error", "Duplicate addresses are not allowed.");
    }

    setLoading(true);
    setStatus("info", "Building transaction…");

    try {
      const res = await api.initialize({
        contractId,
        walletAddress,
        collaborators: addresses,
        shares: collaborators.map((c: Collaborator) =>
          Math.round(parseFloat(c.basisPoints) * 100),
        ),
      });

      setStatus("info", "Signing transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr, network);

      setStatus("info", "Waiting for confirmation...");
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus("ok", `Initialized. Tx: ${hash}`);
      onSuccess();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      if (
        errorMessage.includes("409") ||
        errorMessage.includes("already initialized")
      ) {
        setStatus(
          "error",
          "⚠️ This contract is already initialized. You cannot re-initialize an existing contract.",
        );
      } else {
        setStatus("error", errorMessage);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <span className="badge">Initialize</span>

      {pendingDraft && (
        <div
          className="status info"
          role="alert"
          aria-live="polite"
          data-testid="draft-restore-banner"
        >
          A saved draft from {new Date(pendingDraft.savedAt).toLocaleString()}{" "}
          was found.{" "}
          <button
            type="button"
            onClick={acceptDraft}
            style={{ marginRight: "0.5rem" }}
            data-testid="draft-restore-accept"
          >
            Restore draft
          </button>
          <button
            type="button"
            onClick={discardDraft}
            data-testid="draft-restore-discard"
          >
            Discard
          </button>
        </div>
      )}

      {collaborators.map((c: Collaborator, i: number) => (
        <div key={i}>
          <div className="collaborator-row">
            <div style={{ flex: 3, display: "flex", flexDirection: "column" }}>
              <label htmlFor={`collaborator-${i}-address`}>
                Collaborator {i + 1} wallet address
              </label>
              <input
                id={`collaborator-${i}-address`}
                ref={(el) => {
                  addressRefs.current[i] = el;
                }}
                placeholder="Wallet address (G...)"
                value={c.address}
                aria-invalid={Boolean(errors[i]?.address)}
                aria-describedby={
                  errors[i]?.address
                    ? `collaborator-${i}-address-error`
                    : undefined
                }
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  update(i, "address", e.target.value)
                }
                onBlur={(e: React.FocusEvent<HTMLInputElement>) =>
                  handleBlur(i, "address", e.target.value)
                }
                style={{
                  marginBottom: errors[i]?.address ? "0.25rem" : undefined,
                }}
              />
              {errors[i]?.address && (
                <span
                  id={`collaborator-${i}-address-error`}
                  className="field-error"
                  role="alert"
                >
                  {errors[i].address}
                </span>
              )}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <label htmlFor={`collaborator-${i}-percentage`}>
                Collaborator {i + 1} percentage
              </label>
              <input
                id={`collaborator-${i}-percentage`}
                ref={(el) => {
                  percentageRefs.current[i] = el;
                }}
                placeholder="% (0–100)"
                type="number"
                min={0}
                max={100}
                step="any"
                value={c.basisPoints}
                className={errors[i]?.basisPoints ? "input-error" : ""}
                aria-invalid={Boolean(errors[i]?.basisPoints)}
                aria-describedby={
                  errors[i]?.basisPoints
                    ? `collaborator-${i}-percentage-error`
                    : undefined
                }
                onKeyDown={handlePercentageKeyDown}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const { value } = e.target;
                  if (!isAllowedPercentageInput(value)) {
                    updatePercentageError(
                      setErrors,
                      i,
                      getPercentageError(value),
                    );
                    return;
                  }
                  update(i, "basisPoints", value);
                  validateRow(i, "basisPoints", value);
                }}
                onBlur={(e: React.FocusEvent<HTMLInputElement>) =>
                  handleBlur(i, "basisPoints", e.target.value)
                }
                style={{
                  marginBottom: errors[i]?.basisPoints ? "0.25rem" : undefined,
                }}
              />
              {errors[i]?.basisPoints && (
                <span
                  id={`collaborator-${i}-percentage-error`}
                  className="field-error"
                  role="alert"
                >
                  {errors[i].basisPoints}
                </span>
              )}
            </div>
            {collaborators.length > 1 && (
              <button
                className="btn-danger"
                aria-label={`Remove collaborator ${i + 1}`}
                onClick={() => removeRow(i)}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}

      <div
        className={`share-total ${Math.round(total * 100) === 10_000 ? "share-total--valid" : "share-total--invalid"}`}
        role="status"
        aria-live="polite"
        aria-label={`Share total: ${total.toFixed(2)}% of 100% required`}
        data-testid="share-total"
      >
        Total: {total.toFixed(2)}% / 100%
        {Math.round(total * 100) !== 10_000 && total > 0 && (
          <span className="share-total__hint" aria-hidden="true">
            {" "}
            (
            {Math.round(total * 100) < 10_000
              ? `${(100 - total).toFixed(2)}% remaining`
              : `${(total - 100).toFixed(2)}% over`}
            )
          </span>
        )}
      </div>

      <RoyaltyPayoutPreview
        collaborators={collaborators}
        isValid={previewValid}
        invalidReason={previewInvalidReason}
      />
      <ValidationSummary issues={validationIssues} onFocusField={focusField} />

      {collaborators.length >= MAX_COLLABORATORS - 5 &&
        collaborators.length < MAX_COLLABORATORS && (
          <div className="status info">
            Approaching the limit — max {MAX_COLLABORATORS} collaborators
            allowed ({MAX_COLLABORATORS - collaborators.length} remaining).
          </div>
        )}
      {collaborators.length >= MAX_COLLABORATORS && (
        <div className="status error">
          Maximum of {MAX_COLLABORATORS} collaborators reached. Remove one to
          add another.
        </div>
      )}

      <div className="row">
        <button
          className="btn-add"
          onClick={addRow}
          disabled={collaborators.length >= MAX_COLLABORATORS}
          aria-label={`Add collaborator (${collaborators.length} of ${MAX_COLLABORATORS})`}
        >
          + Add collaborator
        </button>
        <button className="btn-add" type="button" onClick={triggerImport}>
          Import from JSON
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportFile}
          style={{ display: "none" }}
        />
        <button className="btn-add" type="button" onClick={handleExport}>
          Export to JSON
        </button>
        <button
          className="btn-primary"
          onClick={submit}
          disabled={
            loading ||
            hasUnsavedEdit ||
            !allRowsCommitted ||
            hasErrors ||
            hasEmptyFields ||
            hasInvalidPercentages ||
            networkMismatch
          }
        >
          {loading ? "Submitting…" : "Initialize contract"}
        </button>
      </div>

      {networkMismatch && (
        <div className="status error" role="alert">
          Your wallet is on the wrong network. Switch it to{" "}
          {network === "mainnet" ? "Mainnet" : "Testnet"} to initialize this
          contract.
        </div>
      )}
      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
