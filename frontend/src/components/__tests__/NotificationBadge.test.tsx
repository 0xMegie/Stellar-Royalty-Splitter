import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotificationBadge } from "../NotificationBadge";
import { api } from "../../api";

jest.mock("../../api");

const mockApi = api as jest.Mocked<typeof api>;
const WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("NotificationBadge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.getUnreadNotificationCount = jest.fn();
    mockApi.getNotifications = jest.fn();
    mockApi.markNotificationRead = jest.fn();
    mockApi.markAllNotificationsRead = jest.fn();
    mockApi.deleteNotification = jest.fn();
  });

  test("shows zero unread when no notifications", async () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({ success: true, count: 0 });

    render(<NotificationBadge walletAddress={WALLET} wsConnected={true} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Notifications/i)).toBeDefined();
    });
  });

  test("shows unread count badge", async () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({ success: true, count: 5 });

    render(<NotificationBadge walletAddress={WALLET} wsConnected={true} />);

    await waitFor(() => {
      const badge = screen.getByText("5");
      expect(badge).toBeDefined();
    });
  });

  test("shows WebSocket connection indicator", () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({ success: true, count: 0 });

    const { container } = render(
      <NotificationBadge walletAddress={WALLET} wsConnected={true} />
    );

    const indicator = container.querySelector(".ws-indicator.connected");
    expect(indicator).toBeDefined();
  });

  test("shows disconnected indicator when ws not connected", () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({ success: true, count: 0 });

    const { container } = render(
      <NotificationBadge walletAddress={WALLET} wsConnected={false} />
    );

    const indicator = container.querySelector(".ws-indicator.disconnected");
    expect(indicator).toBeDefined();
  });

  test("opens notification panel on click", async () => {
    mockApi.getUnreadNotificationCount.mockResolvedValue({ success: true, count: 1 });
    mockApi.getNotifications.mockResolvedValue({
      success: true,
      data: [],
      unreadCount: 0,
    });

    render(<NotificationBadge walletAddress={WALLET} wsConnected={true} />);

    const btn = screen.getByLabelText(/notifications/i);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockApi.getNotifications).toHaveBeenCalled();
    });
  });
});
