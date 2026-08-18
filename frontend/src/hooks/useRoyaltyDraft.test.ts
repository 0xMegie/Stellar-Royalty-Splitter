import { describe, test, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRoyaltyDraft, DRAFT_STORAGE_KEY } from "./useRoyaltyDraft";

const VALID_ADDRESS_A = `G${"A".repeat(55)}`;
const VALID_ADDRESS_B = `G${"B".repeat(55)}`;

const validCollaborators = [
  { address: VALID_ADDRESS_A, basisPoints: "60" },
  { address: VALID_ADDRESS_B, basisPoints: "40" },
];

function renderDraftHook(
  collaborators = [{ address: "", basisPoints: "" }],
  onRestore = vi.fn<(c: { address: string; basisPoints: string }[]) => void>(),
) {
  return renderHook(
    ({
      cols,
      restore,
    }: {
      cols: typeof collaborators;
      restore: typeof onRestore;
    }) => useRoyaltyDraft(cols, restore),
    { initialProps: { cols: collaborators, restore: onRestore } },
  );
}

describe("useRoyaltyDraft — autosave (#669)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns null pendingDraft when localStorage is empty", () => {
    const { result } = renderDraftHook();
    expect(result.current.pendingDraft).toBeNull();
  });

  test("autosaves collaborators to localStorage after the debounce delay", async () => {
    const { rerender } = renderDraftHook();

    rerender({ cols: validCollaborators, restore: vi.fn() });

    act(() => {
      vi.advanceTimersByTime(700);
    });

    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!);
    expect(saved.collaborators).toHaveLength(2);
    expect(saved.collaborators[0].address).toBe(VALID_ADDRESS_A);
  });

  test("does not save when all collaborators are empty", () => {
    const { rerender } = renderDraftHook();

    rerender({ cols: [{ address: "", basisPoints: "" }], restore: vi.fn() });

    act(() => {
      vi.advanceTimersByTime(700);
    });

    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  test("saved draft includes a savedAt timestamp", () => {
    const { rerender } = renderDraftHook();
    rerender({ cols: validCollaborators, restore: vi.fn() });

    act(() => {
      vi.advanceTimersByTime(700);
    });

    const saved = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!);
    expect(typeof saved.savedAt).toBe("string");
    expect(new Date(saved.savedAt).toString()).not.toBe("Invalid Date");
  });
});

describe("useRoyaltyDraft — restore (#669)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function seedDraft(collaborators = validCollaborators) {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ collaborators, savedAt: new Date().toISOString() }),
    );
  }

  test("exposes pendingDraft when a valid draft exists in localStorage", () => {
    seedDraft();
    const { result } = renderDraftHook();
    expect(result.current.pendingDraft).not.toBeNull();
    expect(result.current.pendingDraft?.collaborators).toHaveLength(2);
  });

  test("acceptDraft calls onRestore with draft collaborators", () => {
    seedDraft();
    const onRestore = vi.fn();
    const { result } = renderDraftHook(
      undefined,
      onRestore as unknown as Parameters<typeof renderDraftHook>[1],
    );

    act(() => {
      result.current.acceptDraft();
    });

    expect(onRestore).toHaveBeenCalledWith(validCollaborators);
  });

  test("acceptDraft clears pendingDraft", () => {
    seedDraft();
    const { result } = renderDraftHook();

    act(() => {
      result.current.acceptDraft();
    });

    expect(result.current.pendingDraft).toBeNull();
  });

  test("acceptDraft removes the draft from localStorage", () => {
    seedDraft();
    const { result } = renderDraftHook();

    act(() => {
      result.current.acceptDraft();
    });

    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  test("discardDraft clears pendingDraft without calling onRestore", () => {
    seedDraft();
    const onRestore = vi.fn();
    const { result } = renderDraftHook(
      undefined,
      onRestore as unknown as Parameters<typeof renderDraftHook>[1],
    );

    act(() => {
      result.current.discardDraft();
    });

    expect(result.current.pendingDraft).toBeNull();
    expect(onRestore).not.toHaveBeenCalled();
  });

  test("discardDraft removes the draft from localStorage", () => {
    seedDraft();
    const { result } = renderDraftHook();

    act(() => {
      result.current.discardDraft();
    });

    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });
});

describe("useRoyaltyDraft — validation (#669)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("ignores a draft where collaborators is not an array", () => {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        collaborators: "bad",
        savedAt: new Date().toISOString(),
      }),
    );
    const { result } = renderDraftHook();
    expect(result.current.pendingDraft).toBeNull();
  });

  test("ignores a draft with an invalid Stellar address", () => {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        collaborators: [{ address: "NOT_VALID", basisPoints: "100" }],
        savedAt: new Date().toISOString(),
      }),
    );
    const { result } = renderDraftHook();
    expect(result.current.pendingDraft).toBeNull();
  });

  test("ignores a draft that is not valid JSON", () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, "{ broken json");
    const { result } = renderDraftHook();
    expect(result.current.pendingDraft).toBeNull();
  });

  test("ignores a draft with an empty collaborators array", () => {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ collaborators: [], savedAt: new Date().toISOString() }),
    );
    const { result } = renderDraftHook();
    expect(result.current.pendingDraft).toBeNull();
  });
});
