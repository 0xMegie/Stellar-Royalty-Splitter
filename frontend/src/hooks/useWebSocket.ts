import { useEffect, useRef, useCallback, useState } from "react";

interface WebSocketMessage {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  walletAddress: string | null;
  onNotification?: (notification: unknown) => void;
  enabled?: boolean;
}

export function useWebSocket({ walletAddress, onNotification, enabled = true }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const [connected, setConnected] = useState(false);
  const [lastPong, setLastPong] = useState<number>(Date.now());

  const connect = useCallback(() => {
    if (!walletAddress || !enabled) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const url = `${protocol}//${host}/ws`;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", walletAddress }));
      };

      ws.onmessage = (event) => {
        try {
          const msg: WebSocketMessage = JSON.parse(event.data);
          if (msg.type === "pong") {
            setLastPong(Date.now());
          } else if (msg.type === "notification" && onNotification) {
            onNotification(msg.data);
          } else if (msg.type === "subscribed") {
            setConnected(true);
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (enabled && walletAddress) {
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      /* connection error */
    }
  }, [walletAddress, enabled, onNotification]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const ping = useCallback(() => {
    send({ type: "ping" });
  }, [send]);

  return { connected, send, ping, lastPong };
}
