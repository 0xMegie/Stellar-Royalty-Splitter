import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import InitializeForm from "../InitializeForm";

jest.mock("../../api");
jest.mock("../../stellar");

import { api } from "../../api";
import { signAndSubmitTransaction } from "../../stellar";

const mockApi = api as jest.Mocked<typeof api>;
const mockSign = signAndSubmitTransaction as jest.MockedFunction<typeof signAndSubmitTransaction>;

const VALID_ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CONTRACT_ID = "CAFQE4X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const mockNetworkContextValue = { network: "testnet" as const, setNetwork: jest.fn() };

jest.mock("../../context/NetworkContext", () => ({
  useNetwork: () => mockNetworkContextValue,
}));

function setup(props = {}) {
  return render(
    <InitializeForm
      contractId={CONTRACT_ID}
      walletAddress={WALLET}
      onSuccess={jest.fn()}
      {...props}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("InitializeForm — editing", () => {
  test("first row starts in edit mode", () => {
    setup();
    expect(screen.getByTestId("collaborator-edit-0")).toBeDefined();
  });

  test("Save button commits the row to view mode", async () => {
    setup();
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));

    await waitFor(() => {
      expect(screen.getByTestId("collaborator-view-0")).toBeDefined();
    });
  });

  test("Cancel button discards unsaved changes", async () => {
    setup();
    const addressInput = screen.getByLabelText(/wallet address for collaborator 1/i);
    fireEvent.change(addressInput, { target: { value: "GINVALID" } });
    fireEvent.click(screen.getByLabelText(/cancel editing collaborator 1/i));

    await waitFor(() => {
      // Row returns to view mode showing the original empty value
      expect(screen.getByTestId("collaborator-view-0")).toBeDefined();
    });
    // The invalid address is not committed
    expect(screen.queryByText("GINVALID")).toBeNull();
  });

  test("Edit button on view row re-opens edit mode", async () => {
    setup();
    // Save a valid row first
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));

    await waitFor(() => expect(screen.getByTestId("collaborator-view-0")).toBeDefined());

    fireEvent.click(screen.getByLabelText(/edit collaborator 1/i));
    expect(screen.getByTestId("collaborator-edit-0")).toBeDefined();
  });

  test("Cancel on edit restores the previously committed address", async () => {
    setup();
    // Commit a valid address
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));
    await waitFor(() => expect(screen.getByTestId("collaborator-view-0")).toBeDefined());

    // Re-open edit and type something different
    fireEvent.click(screen.getByLabelText(/edit collaborator 1/i));
    const addrInput = screen.getByLabelText(/wallet address for collaborator 1/i);
    fireEvent.change(addrInput, { target: { value: "GDIFFERENT" } });

    // Cancel — should revert to original
    fireEvent.click(screen.getByLabelText(/cancel editing collaborator 1/i));
    await waitFor(() => expect(screen.getByTestId("collaborator-view-0")).toBeDefined());
    expect(screen.queryByText(/GDIFFERENT/)).toBeNull();
  });

  test("shows validation error for invalid address on Save", async () => {
    setup();
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: "bad-address" },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));

    await waitFor(() => {
      expect(screen.getByText(/Must be a valid Stellar address/i)).toBeDefined();
    });
    // Row stays in edit mode
    expect(screen.getByTestId("collaborator-edit-0")).toBeDefined();
  });

  test("shows validation error for invalid percentage on Save", async () => {
    setup();
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    // Leave percentage empty
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));

    await waitFor(() => {
      expect(screen.getByText(/Percentage is required/i)).toBeDefined();
    });
  });

  test("Add collaborator creates a new row in edit mode", async () => {
    setup();
    // Save the first row
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));
    await waitFor(() => expect(screen.getByTestId("collaborator-view-0")).toBeDefined());

    fireEvent.click(screen.getByText(/\+ Add collaborator/i));
    expect(screen.getByTestId("collaborator-edit-1")).toBeDefined();
  });

  test("share total updates in real time while editing", async () => {
    setup();
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "75" },
    });

    const total = screen.getByTestId("share-total");
    expect(total.textContent).toContain("75.00%");
  });

  test("submit is blocked when a row is in edit mode", async () => {
    setup();
    // Row 0 is already in edit mode with unsaved data
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "100" },
    });
    // Do NOT save — submit button should be disabled
    const submitBtn = screen.getByText(/Initialize contract/i);
    expect(submitBtn).toBeDisabled();
  });

  test("submit is enabled after all rows are saved and total is 100%", async () => {
    setup();
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));
    await waitFor(() => expect(screen.getByTestId("collaborator-view-0")).toBeDefined());

    const submitBtn = screen.getByText(/Initialize contract/i);
    expect(submitBtn).not.toBeDisabled();
  });

  test("remove row while another is in edit mode adjusts editingIndex", async () => {
    setup();
    // Save row 0
    fireEvent.change(screen.getByLabelText(/wallet address for collaborator 1/i), {
      target: { value: VALID_ADDRESS },
    });
    fireEvent.change(screen.getByLabelText(/royalty percentage for collaborator 1/i), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByLabelText(/save collaborator 1/i));
    await waitFor(() => expect(screen.getByTestId("collaborator-view-0")).toBeDefined());

    // Add row 1 (now in edit mode)
    fireEvent.click(screen.getByText(/\+ Add collaborator/i));
    expect(screen.getByTestId("collaborator-edit-1")).toBeDefined();

    // Remove row 0 — row 1 becomes row 0, editingIndex adjusts
    fireEvent.click(screen.getByLabelText(/remove collaborator 1/i));
    await waitFor(() => {
      expect(screen.getByTestId("collaborator-edit-0")).toBeDefined();
    });
  });
});
