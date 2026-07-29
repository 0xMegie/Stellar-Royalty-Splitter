// Minimal Express app for testing — no DB init, no listen
import express from "express";
import { initializeRouter } from "../src/routes/initialize.js";
import { distributeRouter } from "../src/routes/distribute.js";
import { collaboratorsRouter } from "../src/routes/collaborators.js";
import { simulateRouter } from "../src/routes/simulate.js";
import { metricsRouter } from "../src/routes/metrics.js";
import { notFoundHandler, errorHandler } from "../src/error-response.js";

const app = express();
app.use(express.json({ limit: "10kb" }));

app.use("/api/v1/initialize", initializeRouter);
app.use("/api/v1/distribute", distributeRouter);
app.use("/api/v1/collaborators", collaboratorsRouter);
app.use("/api/v1/simulate", simulateRouter);
app.use("/metrics", metricsRouter);

// Same standard-shape handlers production uses (#662), so tests against
// this harness exercise the real response format instead of a stand-in.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
