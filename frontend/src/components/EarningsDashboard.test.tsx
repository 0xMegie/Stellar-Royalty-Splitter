import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import "@testing-library/jest-dom";
import { EarningsDashboard } from "./EarningsDashboard";

// Mock the API module
vi.mock("../api", () => ({
  api: {
    getAnalytics: vi.fn(),
    getCollaborators: vi.fn(),
    getRoyaltyStats: vi.fn(),
    getTransactionHistory: vi.fn(),
    getSecondarySales: vi.fn(),
  },
}));

import { api } from "../api";

vi.mock("../context/SettingsContext", () => ({
  useSettings: () => ({
    settings: { displayCurrency: "XLM" },
    updateSettings: vi.fn(),
  }),
}));

const mockGetAnalytics = api.getAnalytics as Mock;
const mockGetCollaborators = api.getCollaborators as Mock;
const mockGetRoyaltyStats = api.getRoyaltyStats as Mock;
const mockGetTransactionHistory = api.getTransactionHistory as Mock;
const mockGetSecondarySales = api.getSecondarySales as Mock;

const MOCK_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MOCK_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MOCK_COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const mockCollaborators = [
  { address: MOCK_WALLET, basisPoints: 6000 },
  { address: MOCK_COLLAB1, basisPoints: 4000 },
];

const mockAnalyticsData = {
  success: true,
  data: {
    totalDistributed: 1000,
    primaryRoyaltiesTotal: 700,
    secondaryRoyaltiesTotal: 300,
    collaboratorStats: [
      { address: MOCK_WALLET, totalEarned: 600, payoutCount: 3 },
      { address: MOCK_COLLAB1, totalEarned: 400, payoutCount: 2 },
    ],
  },
};

const mockTransactionHistory = {
  success: true,
  data: [
    {
      id: 1,
      type: "distribute",
      requestedAmount: "500",
      timestamp: "2026-08-01T12:00:00Z",
      status: "confirmed",
      txHash: "hash123456789",
    },
  ],
};

const mockSecondarySales = {
  sales: [
    {
      id: 1,
      nftId: "nft-101",
      royaltyAmount: "300",
      timestamp: "2026-08-01T14:00:00Z",
      transactionHash: "salehash98765",
    },
  ],
};

describe("EarningsDashboard Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when contractId is not provided", () => {
    render(<EarningsDashboard contractId="" />);
    expect(screen.getByTestId("earnings-dashboard-empty")).toBeInTheDocument();
    expect(screen.getByText(/Please select or initialize a contract/i)).toBeInTheDocument();
  });

  it("renders loading skeleton initially when contractId is provided", () => {
    mockGetAnalytics.mockReturnValue(new Promise(() => {}));
    mockGetCollaborators.mockReturnValue(new Promise(() => {}));
    mockGetRoyaltyStats.mockReturnValue(new Promise(() => {}));
    mockGetTransactionHistory.mockReturnValue(new Promise(() => {}));
    mockGetSecondarySales.mockReturnValue(new Promise(() => {}));

    render(<EarningsDashboard contractId={MOCK_CONTRACT} />);
    expect(screen.getByTestId("earnings-dashboard-loading")).toBeInTheDocument();
  });

  it("renders dashboard with KPIs, collaborators, and payouts after data loads", async () => {
    mockGetAnalytics.mockResolvedValue(mockAnalyticsData);
    mockGetCollaborators.mockResolvedValue(mockCollaborators);
    mockGetRoyaltyStats.mockResolvedValue({ totalRoyaltiesGenerated: "300" });
    mockGetTransactionHistory.mockResolvedValue(mockTransactionHistory);
    mockGetSecondarySales.mockResolvedValue(mockSecondarySales);

    render(<EarningsDashboard contractId={MOCK_CONTRACT} walletAddress={MOCK_WALLET} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
    });

    expect(screen.getByText("Collaborator Earnings Dashboard")).toBeInTheDocument();

    // Verify KPI Values exist
    expect(screen.getByText("Total Distributed")).toBeInTheDocument();
    expect(screen.getByText("Primary Royalties")).toBeInTheDocument();
    expect(screen.getByText("Secondary Royalties")).toBeInTheDocument();

    // Verify Collaborator rows
    expect(screen.getByText("You")).toBeInTheDocument(); // Badge for connected wallet
    expect(screen.getByText("60.00%")).toBeInTheDocument();
    expect(screen.getByText("40.00%")).toBeInTheDocument();
  });

  it("filters collaborators by search query", async () => {
    mockGetAnalytics.mockResolvedValue(mockAnalyticsData);
    mockGetCollaborators.mockResolvedValue(mockCollaborators);
    mockGetRoyaltyStats.mockResolvedValue({});
    mockGetTransactionHistory.mockResolvedValue({ data: [] });
    mockGetSecondarySales.mockResolvedValue({ sales: [] });

    render(<EarningsDashboard contractId={MOCK_CONTRACT} walletAddress={MOCK_WALLET} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search by address/i);
    fireEvent.change(searchInput, { target: { value: MOCK_COLLAB1.slice(0, 8) } });

    expect(screen.getByText(/40.00%/)).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  it("filters recent payouts using tab buttons", async () => {
    mockGetAnalytics.mockResolvedValue(mockAnalyticsData);
    mockGetCollaborators.mockResolvedValue(mockCollaborators);
    mockGetRoyaltyStats.mockResolvedValue({});
    mockGetTransactionHistory.mockResolvedValue(mockTransactionHistory);
    mockGetSecondarySales.mockResolvedValue(mockSecondarySales);

    render(<EarningsDashboard contractId={MOCK_CONTRACT} walletAddress={MOCK_WALLET} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard")).toBeInTheDocument();
    });

    const primaryTab = screen.getByRole("tab", { name: "Primary" });
    fireEvent.click(primaryTab);

    expect(screen.getByText("Primary Royalty Distribution")).toBeInTheDocument();
    expect(screen.queryByText(/NFT Resale/i)).not.toBeInTheDocument();
  });

  it("renders error state when API fails", async () => {
    mockGetAnalytics.mockRejectedValue(new Error("Network Error"));
    mockGetCollaborators.mockRejectedValue(new Error("Network Error"));

    render(<EarningsDashboard contractId={MOCK_CONTRACT} />);

    await waitFor(() => {
      expect(screen.getByTestId("earnings-dashboard-error")).toBeInTheDocument();
    });

    expect(screen.getByText(/Error Loading Dashboard/i)).toBeInTheDocument();
  });
});
