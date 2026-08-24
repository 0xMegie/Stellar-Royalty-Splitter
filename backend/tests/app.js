// Minimal Express app for testing — no DB init, no listen
import express from "express";
import { createBodySizeLimiters } from "../src/body-size-limit.js";
import { initializeRouter } from "../src/routes/initialize.js";
import { distributeRouter } from "../src/routes/distribute.js";
import { collaboratorsRouter } from "../src/routes/collaborators.js";
import { simulateRouter } from "../src/routes/simulate.js";
import { metricsRouter } from "../src/routes/metrics.js";
import { sendError } from "../src/error-response.js";

const app = express();

// Body size limits mirror production: 10 KB JSON, 50 KB multipart (#426)
app.use(...createBodySizeLimiters());

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);
app.use("/api/v1/simulate", simulateRouter);
app.use("/metrics", metricsRouter);

app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    return sendError(res, 413, "payload_too_large", "Payload too large");
  }
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

export default app;
