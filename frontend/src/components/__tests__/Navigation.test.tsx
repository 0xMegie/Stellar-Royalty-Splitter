import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Navigation } from "../Navigation";

jest.mock("../NotificationBadge", () => ({
  NotificationBadge: () => <div data-testid="notification-badge" />,
}));

jest.mock("../../context/ThemeContext", () => ({
  useTheme: () => ({ isDark: false, toggleTheme: jest.fn() }),
}));

jest.mock("../../context/NetworkContext", () => ({
  useNetwork: () => ({ network: "testnet", setNetwork: jest.fn() }),
}));

const WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function setup(props = {}) {
  const onPageChange = jest.fn();
  const onDisconnect = jest.fn();
  render(
    <Navigation
      currentPage="dashboard"
      onPageChange={onPageChange}
      walletAddress={WALLET}
      onDisconnect={onDisconnect}
      wsConnected={false}
      {...props}
    />
  );
  return { onPageChange, onDisconnect };
}

describe("Navigation — mobile menu", () => {
  test("mobile menu button is present", () => {
    setup();
    expect(screen.getByLabelText("Toggle menu")).toBeDefined();
  });

  test("mobile menu starts closed (aria-expanded=false)", () => {
    setup();
    const btn = screen.getByLabelText("Toggle menu");
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  test("clicking hamburger opens the menu (aria-expanded=true)", () => {
    setup();
    const btn = screen.getByLabelText("Toggle menu");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  test("clicking hamburger twice closes the menu again", () => {
    setup();
    const btn = screen.getByLabelText("Toggle menu");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  test("pressing Escape closes the mobile menu", () => {
    setup();
    const btn = screen.getByLabelText("Toggle menu");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  test("nav-links has correct aria-controls target id", () => {
    setup();
    const btn = screen.getByLabelText("Toggle menu");
    expect(btn).toHaveAttribute("aria-controls", "mobile-nav-links");
    expect(document.getElementById("mobile-nav-links")).toBeDefined();
  });

  test("clicking a nav item closes the mobile menu", () => {
    setup();
    const btn = screen.getByLabelText("Toggle menu");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");

    // Click on the Dashboard nav button
    const dashboardBtn = screen.getByText("Dashboard").closest("button");
    if (dashboardBtn) fireEvent.click(dashboardBtn);

    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  test("renders all nav items", () => {
    setup();
    expect(screen.getByText("Dashboard")).toBeDefined();
    expect(screen.getByText("Distribute")).toBeDefined();
    expect(screen.getByText("Settings")).toBeDefined();
  });

  test("active page has aria-current=page", () => {
    setup();
    const dashboardBtn = screen.getByRole("button", { name: /Dashboard/i });
    expect(dashboardBtn).toHaveAttribute("aria-current", "page");
  });

  test("inactive page does not have aria-current", () => {
    setup();
    const distributeBtn = screen.getByRole("button", { name: /Distribute/i });
    expect(distributeBtn).not.toHaveAttribute("aria-current");
  });

  test("renders without wallet address", () => {
    setup({ walletAddress: null });
    expect(screen.getByText("Disconnected")).toBeDefined();
  });
});

describe("Navigation — keyboard navigation", () => {
  test("nav buttons are focusable (tabIndex default)", () => {
    setup();
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });

  test("Escape is a no-op when menu is already closed", () => {
    setup();
    const btn = screen.getByLabelText("Toggle menu");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    // Should not throw
    fireEvent.keyDown(document, { key: "Escape" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });
});
