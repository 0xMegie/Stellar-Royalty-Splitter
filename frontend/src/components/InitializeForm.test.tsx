/**
 * Tests for the reusable royalty split templates feature (#652) embedded
 * in InitializeForm: listing, applying, saving, and deleting templates.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import InitializeForm from "./InitializeForm";

jest.mock("../api");
jest.mock("../context/NetworkContext", () => ({
  useNetwork: () => ({ network: "testnet", setNetwork: jest.fn() }),
}));
jest.mock("../stellar", () => ({
  signAndSubmitTransaction: jest.fn(),
}));

import { api } from "../api";

const mockApi = api as jest.Mocked<typeof api>;

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB_1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB_2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function renderForm() {
  return render(
    <InitializeForm
      contractId={CONTRACT_ID}
      walletAddress={WALLET_ADDRESS}
      onSuccess={jest.fn()}
    />,
  );
}

describe("InitializeForm royalty split templates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.listTemplates = jest.fn().mockResolvedValue({ success: true, data: [] });
    mockApi.createTemplate = jest.fn();
    mockApi.deleteTemplate = jest.fn();
  });

  test("shows empty state when the wallet has no saved templates", async () => {
    renderForm();

    await waitFor(() => {
      expect(screen.getByText(/No saved templates yet/i)).toBeInTheDocument();
    });
  });

  test("shows an error state when templates fail to load", async () => {
    mockApi.listTemplates = jest.fn().mockRejectedValue(new Error("network down"));

    renderForm();

    await waitFor(() => {
      expect(screen.getByText(/network down/i)).toBeInTheDocument();
    });
  });

  test("lists saved templates and applies one to the form", async () => {
    mockApi.listTemplates = jest.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: 1,
          walletAddress: WALLET_ADDRESS,
          name: "50/50 split",
          allocations: [
            { address: COLLAB_1, percentage: 60 },
            { address: COLLAB_2, percentage: 40 },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    renderForm();

    await waitFor(() => {
      expect(screen.getByText("50/50 split")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /apply/i }));

    const addressInputs = screen.getAllByPlaceholderText(
      "Wallet address (G...)",
    ) as HTMLInputElement[];
    expect(addressInputs.map((i) => i.value)).toEqual([COLLAB_1, COLLAB_2]);
    expect(screen.getByText(/Applied template "50\/50 split"/i)).toBeInTheDocument();
  });

  test("refuses to apply a template whose allocations no longer sum to 100%", async () => {
    mockApi.listTemplates = jest.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: 2,
          walletAddress: WALLET_ADDRESS,
          name: "stale split",
          allocations: [{ address: COLLAB_1, percentage: 40 }],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    renderForm();

    await waitFor(() => {
      expect(screen.getByText("stale split")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /apply/i }));

    expect(
      screen.getByText(/Cannot apply "stale split".*must sum to 100%/i),
    ).toBeInTheDocument();
  });

  test("deletes a template", async () => {
    mockApi.listTemplates = jest.fn().mockResolvedValue({
      success: true,
      data: [
        {
          id: 3,
          walletAddress: WALLET_ADDRESS,
          name: "to remove",
          allocations: [{ address: COLLAB_1, percentage: 100 }],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mockApi.deleteTemplate = jest.fn().mockResolvedValue({ success: true });

    renderForm();

    await waitFor(() => {
      expect(screen.getByText("to remove")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => {
      expect(mockApi.deleteTemplate).toHaveBeenCalledWith(3, WALLET_ADDRESS);
      expect(screen.queryByText("to remove")).not.toBeInTheDocument();
    });
  });

  test("blocks saving a template when the current split is invalid", async () => {
    renderForm();

    await waitFor(() => expect(mockApi.listTemplates).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText("Template name"), {
      target: { value: "My split" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /save current split as template/i }),
    );

    expect(
      screen.getByText(/Fix the collaborator allocation errors/i),
    ).toBeInTheDocument();
    expect(mockApi.createTemplate).not.toHaveBeenCalled();
  });

  test("saves the current valid split as a new template", async () => {
    mockApi.createTemplate = jest.fn().mockResolvedValue({
      success: true,
      data: {
        id: 4,
        walletAddress: WALLET_ADDRESS,
        name: "My split",
        allocations: [{ address: COLLAB_1, percentage: 100 }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    renderForm();
    await waitFor(() => expect(mockApi.listTemplates).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText("Wallet address (G...)"), {
      target: { value: COLLAB_1 },
    });
    fireEvent.change(screen.getByPlaceholderText("% (0–100)"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByPlaceholderText("Template name"), {
      target: { value: "My split" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /save current split as template/i }),
    );

    await waitFor(() => {
      expect(mockApi.createTemplate).toHaveBeenCalledWith({
        walletAddress: WALLET_ADDRESS,
        name: "My split",
        allocations: [{ address: COLLAB_1, percentage: 100 }],
      });
    });
  });
});
