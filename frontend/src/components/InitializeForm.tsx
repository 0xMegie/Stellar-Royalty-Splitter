import React, { useState } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import FormStatus from "./FormStatus";
import { useFormStatus } from "../hooks/useFormStatus";


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
  const { network } = useNetwork();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([
    { address: "", basisPoints: "" },
  ]);
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);

  // Which row is currently open for editing (-1 = none)
  const [editingIndex, setEditingIndex] = useState<number>(0);
  // Temporary values while the row is in edit mode
  const [editBuffer, setEditBuffer] = useState<Collaborator>({ address: "", basisPoints: "" });
  // Validation errors for the active edit buffer
  const [editErrors, setEditErrors] = useState<{ address?: string; basisPoints?: string }>({});

  function startEdit(i: number) {
    setEditingIndex(i);
    setEditBuffer({ ...collaborators[i] });
    setEditErrors({});
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
      prev.map((c, idx) => (idx === i ? { ...editBuffer } : c))
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
      prev.filter((_: Collaborator, idx: number) => idx !== i)
    );
    if (editingIndex === i) {
      setEditingIndex(-1);
      setEditBuffer({ address: "", basisPoints: "" });
      setEditErrors({});
    } else if (editingIndex > i) {
      setEditingIndex(editingIndex - 1);
    }
  }

  // Total reflects the edit buffer in real time while a row is being edited
  const total = collaborators.reduce((sum: number, c: Collaborator, i: number) => {
    const val = i === editingIndex ? editBuffer.basisPoints : c.basisPoints;
    return sum + (parseFloat(val) || 0);
  }, 0);

  const hasUnsavedEdit = editingIndex >= 0;
  const allRowsCommitted = collaborators.every(
    (c) => c.address && c.basisPoints
  );

  async function submit() {
    if (!contractId)
      return setStatus("error", "Enter a contract ID first.");

    if (hasUnsavedEdit) {
      return setStatus("error", "Please save or cancel the current edit before submitting.");
    }

    const nextErrors = collaborators.reduce<
      Record<number, { address?: string; basisPoints?: string }>
    >((acc, c, i) => {
      if (!c.address || !STELLAR_ADDRESS_RE.test(c.address)) {
        acc[i] = { ...acc[i], address: "Must be a valid Stellar address (G..., 56 chars)" };
      }
      const percentageError = getPercentageError(c.basisPoints);
      if (percentageError) {
        acc[i] = { ...acc[i], basisPoints: percentageError };
      }
      return acc;
    }, {});

    if (Object.keys(nextErrors).length > 0) {
      return setStatus("error", "Please fix all field errors before submitting.");
    }

    if (Math.round(total * 100) !== 10_000)
      return setStatus("error", `Percentages must sum to 100% (currently ${total.toFixed(2)}%).`);

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
        shares: collaborators.map((c: Collaborator) => Math.round(parseFloat(c.basisPoints) * 100)),
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
      if (errorMessage.includes('409') || errorMessage.includes('already initialized')) {
        setStatus("error", "⚠️ This contract is already initialized. You cannot re-initialize an existing contract.");
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

      {collaborators.map((c: Collaborator, i: number) => (
        <div key={i} className="collaborator-row-wrapper">
          {editingIndex === i ? (
            <div className="collaborator-row" data-testid={`collaborator-edit-${i}`}>
              <div style={{ flex: 3, display: "flex", flexDirection: "column" }}>
                <input
                  placeholder="Wallet address (G...)"
                  value={editBuffer.address}
                  aria-label={`Wallet address for collaborator ${i + 1}`}
                  onChange={(e) =>
                    setEditBuffer((prev) => ({ ...prev, address: e.target.value }))
                  }
                  style={{ marginBottom: editErrors.address ? "0.25rem" : undefined }}
                />
                {editErrors.address && (
                  <span className="field-error">{editErrors.address}</span>
                )}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <input
                  placeholder="% (0–100)"
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  value={editBuffer.basisPoints}
                  className={editErrors.basisPoints ? "input-error" : ""}
                  aria-label={`Royalty percentage for collaborator ${i + 1}`}
                  aria-invalid={Boolean(editErrors.basisPoints)}
                  onKeyDown={handlePercentageKeyDown}
                  onChange={(e) => {
                    const { value } = e.target;
                    if (!isAllowedPercentageInput(value)) return;
                    setEditBuffer((prev) => ({ ...prev, basisPoints: value }));
                  }}
                  style={{ marginBottom: editErrors.basisPoints ? "0.25rem" : undefined }}
                />
                {editErrors.basisPoints && (
                  <span className="field-error">{editErrors.basisPoints}</span>
                )}
              </div>
              <button
                className="btn-primary"
                onClick={() => saveEdit(i)}
                aria-label={`Save collaborator ${i + 1}`}
              >
                Save
              </button>
              <button
                className="btn-secondary"
                onClick={cancelEdit}
                aria-label={`Cancel editing collaborator ${i + 1}`}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div
              className="collaborator-row collaborator-row--view"
              data-testid={`collaborator-view-${i}`}
            >
              <span
                className="collaborator-address"
                style={{ flex: 3, fontFamily: "monospace", fontSize: "0.85rem" }}
                title={c.address}
              >
                {c.address ? `${c.address.slice(0, 8)}…${c.address.slice(-4)}` : "(no address)"}
              </span>
              <span className="collaborator-pct" style={{ flex: 1 }}>
                {c.basisPoints ? `${c.basisPoints}%` : "(no %)"}
              </span>
              <button
                className="btn-secondary"
                onClick={() => startEdit(i)}
                aria-label={`Edit collaborator ${i + 1}`}
              >
                Edit
              </button>
              {collaborators.length > 1 && (
                <button
                  className="btn-danger"
                  onClick={() => removeRow(i)}
                  aria-label={`Remove collaborator ${i + 1}`}
                >
                  ✕
                </button>
              )}
            </div>
          )}
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
            {" "}({Math.round(total * 100) < 10_000 ? `${(100 - total).toFixed(2)}% remaining` : `${(total - 100).toFixed(2)}% over`})
          </span>
        )}
      </div>

      {collaborators.length >= MAX_COLLABORATORS - 5 && collaborators.length < MAX_COLLABORATORS && (
        <div className="status info">
          Approaching the limit — max {MAX_COLLABORATORS} collaborators allowed ({MAX_COLLABORATORS - collaborators.length} remaining).
        </div>
      )}
      {collaborators.length >= MAX_COLLABORATORS && (
        <div className="status error">
          Maximum of {MAX_COLLABORATORS} collaborators reached. Remove one to add another.
        </div>
      )}

      <div className="row">
        <button
          className="btn-add"
          onClick={addRow}
          disabled={collaborators.length >= MAX_COLLABORATORS}
        >
          + Add collaborator
        </button>
        <button
          className="btn-primary"
          onClick={submit}
          disabled={loading || hasUnsavedEdit || !allRowsCommitted}
        >
          {loading ? "Submitting…" : "Initialize contract"}
        </button>
      </div>

      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
