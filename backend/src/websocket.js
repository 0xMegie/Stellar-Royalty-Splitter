import { WebSocketServer } from "ws";
import logger from "./logger.js";

const clients = new Map();

export function initializeWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.info("WebSocket client connected", { ip });

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "subscribe" && msg.walletAddress) {
          ws.walletAddress = msg.walletAddress;
          if (!clients.has(msg.walletAddress)) {
            clients.set(msg.walletAddress, new Set());
          }
          clients.get(msg.walletAddress).add(ws);
          ws.send(JSON.stringify({ type: "subscribed", walletAddress: msg.walletAddress }));
          logger.info("Wallet subscribed to notifications", { walletAddress: msg.walletAddress });
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (err) {
        logger.error("WebSocket message error", { error: err.message });
      }
    });

    ws.on("close", () => {
      if (ws.walletAddress && clients.has(ws.walletAddress)) {
        clients.get(ws.walletAddress).delete(ws);
        if (clients.get(ws.walletAddress).size === 0) {
          clients.delete(ws.walletAddress);
        }
      }
      logger.info("WebSocket client disconnected", { ip });
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(interval));

  logger.info("WebSocket server initialized on /ws");
  return wss;
}

export function sendNotification(walletAddress, notification) {
  if (!clients.has(walletAddress)) return false;
  const message = JSON.stringify({
    type: "notification",
    data: notification,
  });
  let sent = 0;
  clients.get(walletAddress).forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(message);
      sent++;
    }
  });
  return sent > 0;
}

export function broadcastToContract(contractId, notification) {
  const message = JSON.stringify({
    type: "notification",
    data: { ...notification, contractId },
  });
  let sent = 0;
  clients.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === 1 && ws.walletAddress) {
        ws.send(message);
        sent++;
      }
    });
  });
  return sent;
}
