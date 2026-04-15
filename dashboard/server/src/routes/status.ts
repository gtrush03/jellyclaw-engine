import { Hono } from "hono";
import { buildStatusSnapshot } from "../lib/log-parser.js";

export const statusRoutes = new Hono();

statusRoutes.get("/status", async (c) => {
  try {
    const snapshot = await buildStatusSnapshot();
    return c.json(snapshot);
  } catch (err) {
    console.error("[GET /api/status] failed:", err);
    return c.json({ error: "failed to compute status" }, 500);
  }
});
