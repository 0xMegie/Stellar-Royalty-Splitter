/**
 * Tests for TransactionHistory loading states (#714).
 *
 * Note: `npm test` in this package currently points at a stale `react-scripts`
 * script left over from before the frontend moved to Vite; there is no
 * vitest/jest runner wired up yet, so this suite (like the other *.test.tsx
 * files here) cannot be executed as-is. Verified by manual trace against
 * TransactionHistory.tsx instead — see PR description for details.
 */

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionHistory } from "./TransactionHistory";

jest.mock("../api");

import { api } from "../api";

const mockGetTransactionHistory = api.getTransactionHistory as jest.Mock;

const MOCK_CONTRACT =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const mockTransactions = [
  {
    id: 1,
    txHash: "abc123",
    contractId: MOCK_CONTRACT,
    type: "distribute" as const,
    initiatorAddress: "GALAXY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZAAAA",
    requestedAmount: "1000",
    tokenId: "native",
    timestamp: new Date().toISOString(),
    blockTime: new Date().toISOString(),
    status: "confirmed" as const,
    errorMessage: null,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("TransactionHistory loading states", () => {
  it("shows a skeleton placeholder (not blank) on initial load", () => {
    mockGetTransactionHistory.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    const { container } = render(
      <TransactionHistory contractId={MOCK_CONTRACT} />,
    );

    expect(container.querySelectorAll(".list-skeleton-item").length).toBe(5);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("replaces the skeleton with the transactions table once data loads", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: mockTransactions,
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    render(<TransactionHistory contractId={MOCK_CONTRACT} />);

    expect(screen.getByRole("status")).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });

    expect(screen.getByText(/Showing/i)).toBeTruthy();
  });

  it("shows the empty state (not a skeleton) once loaded with no results", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: [],
      pagination: { limit: 50, offset: 0, total: 0 },
    });

    render(<TransactionHistory contractId={MOCK_CONTRACT} />);

    await waitFor(() => {
      expect(screen.getByTestId("history-empty-state")).toBeTruthy();
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps existing rows visible (no skeleton) while refreshing", async () => {
    mockGetTransactionHistory.mockResolvedValue({
      success: true,
      data: mockTransactions,
      pagination: { limit: 50, offset: 0, total: 1 },
    });

    render(<TransactionHistory contractId={MOCK_CONTRACT} />);

    await waitFor(() => {
      expect(screen.getByText(/Showing/i)).toBeTruthy();
    });

    // Trigger a refresh that never resolves.
    mockGetTransactionHistory.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    const refreshBtn = screen.getByText("Refresh");
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText("Refreshing...")).toBeTruthy();
    });

    // The already-loaded table stays put; no skeleton replaces it.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/Showing/i)).toBeTruthy();
  });
});
