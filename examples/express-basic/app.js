// Runnable example for the docs site (docs/express.md, docs/deployment.md).
// Tested by tests/integration/docs-examples.test.ts: keep the two in sync.
import express from "express";
import { createAuditLogger, createRateLimiter } from "@bug-free-eureka/express";

export function createApp({
  trustProxy = 1,
  store,
  sink = (event) => console.log(JSON.stringify(event)),
} = {}) {
  // #region setup
  const app = express();
  app.set("trust proxy", trustProxy); // the exact number of proxies in front of the app

  app.use(createAuditLogger({ sink }));
  app.use(createRateLimiter({ limit: 100, windowMs: 60_000, store }));
  app.use(
    "/login",
    createRateLimiter({ name: "login", limit: 5, onStoreError: "fail-closed", store }),
  );
  // #endregion setup

  // Shows what Express derives from the proxy headers (docs/deployment.md).
  app.get("/whoami", (req, res) =>
    res.json({ ip: req.ip, protocol: req.protocol, secure: req.secure }),
  );
  app.get("/health", (_req, res) => res.send("ok"));
  app.post("/login", (_req, res) => res.send("checked"));
  return app;
}
