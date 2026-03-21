import express from "express";
import { createServer } from "node:http";
import { config } from "../config.js";
import { MarketIntelligenceService } from "./service.js";

const app = express();
const service = new MarketIntelligenceService();

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "market-intelligence" });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "market-intelligence" });
});

app.get("/api/snapshot", async (_request, response) => {
  response.json(await service.getSnapshot());
});

const server = createServer(app);

void service.start();

server.listen(config.marketIntelligencePort, () => {
  console.log(`Market intelligence listening on http://localhost:${config.marketIntelligencePort}`);
});
