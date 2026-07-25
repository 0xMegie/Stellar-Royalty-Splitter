import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: mockLogger,
}));

const { default: rateLimit, ipKeyGenerator } = await import("express-rate-limit");
const express = (await import("express")).default;
const { sendError } = await import("../src/error-response.js");

function buildApp(generalMax, writeMax, enableWriteRoutes = false) {
  const app = express();

  // Simulate the same generalLimiter pattern from index.js
  const generalLimiter = rateLimit({
    windowMs: 60_000,
    max: (req) => {
      if (req.headers["x-api-key"]) return generalMax * 10;
      return generalMax;
    },
    keyGenerator: (req) => req.headers["x-api-key"] || ipKeyGenerator(req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      mockLogger.warn("Rate limit exceeded", {
        ip: req.ip,
        path: req.originalUrl,
        method: req.method,
        apiKey: req.headers["x-api-key"] ? "present" : "none",
      });
      res.set("Retry-After", "60");
      sendError(res, 429, "too_many_requests", "Too many requests, please try again later.");
    },
    skip: (req) => req.path === "/api/v1/health",
  });

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: writeMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      mockLogger.warn("Write rate limit exceeded", {
        ip: req.ip,
        path: req.originalUrl,
        method: req.method,
      });
      res.set("Retry-After", "60");
      sendError(res, 429, "too_many_requests", "Too many write requests, please slow down.");
    },
  });

  app.use(generalLimiter);
  app.use(express.json());

  app.get("/api/v1/test", (_req, res) => res.json({ ok: true }));
  app.get("/api/v1/health", (_req, res) => res.json({ status: "ok" }));

  if (enableWriteRoutes) {
    app.use("/api/v1/initialize", writeLimiter);
    app.post("/api/v1/initialize", (_req, res) => res.json({ ok: true }));
  }

  return app;
}

describe("Public rate limiter (IP-based)", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp(3, 2);
  });

  test("under limit succeeds", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request(app).get("/api/v1/test");
      expect(res.status).toBe(200);
    }
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test("at limit — Nth request succeeds", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/api/v1/test");
      expect(res.status).toBe(200);
    }
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test("over limit returns 429 with Retry-After header", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).get("/api/v1/test");
    }

    const res = await request(app).get("/api/v1/test");
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      status: 429,
      code: "too_many_requests",
    });
    expect(res.headers["retry-after"]).toBe("60");
    expect(mockLogger.warn).toHaveBeenCalledWith("Rate limit exceeded", expect.objectContaining({
      ip: expect.any(String),
      path: "/api/v1/test",
      method: "GET",
      apiKey: "none",
    }));
  });

  test("health endpoint is not rate limited", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get("/api/v1/health");
      expect(res.status).toBe(200);
    }
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("Authenticated rate limiter (API key-based)", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp(3, 2);
  });

  test("authenticated requests have higher limit", async () => {
    // Public limit is 3, but with API key it's 3 * 10 = 30
    // We just verify that more than the public limit works
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get("/api/v1/test")
        .set("x-api-key", "test-key-123");
      expect(res.status).toBe(200);
    }
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test("authenticated requests count separately per API key", async () => {
    // Exhaust public limit
    for (let i = 0; i < 3; i++) {
      await request(app).get("/api/v1/test");
    }

    // Public should now be blocked
    const publicRes = await request(app).get("/api/v1/test");
    expect(publicRes.status).toBe(429);

    // But API key requests should still work (separate counter)
    const authRes = await request(app)
      .get("/api/v1/test")
      .set("x-api-key", "test-key-123");
    expect(authRes.status).toBe(200);
  });

  test("different API keys have independent counters", async () => {
    // Exhaust key1
    for (let i = 0; i < 31; i++) {
      const res = await request(app)
        .get("/api/v1/test")
        .set("x-api-key", "key1");
      if (res.status === 429) break;
    }

    // key2 should still work
    const res = await request(app)
      .get("/api/v1/test")
      .set("x-api-key", "key2");
    expect(res.status).toBe(200);
  });
});

describe("Write rate limiter", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp(100, 2, true);
  });

  test("under write limit succeeds", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post("/api/v1/initialize")
        .set("Content-Type", "application/json")
        .send({});
      expect(res.status).toBe(200);
    }
  });

  test("over write limit returns 429", async () => {
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post("/api/v1/initialize")
        .set("Content-Type", "application/json")
        .send({});
    }

    const res = await request(app)
      .post("/api/v1/initialize")
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("too_many_requests");
    expect(res.headers["retry-after"]).toBe("60");
  });
});
