import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { PolymarketSignalService } from "./polymarket.js";

const app = express();
app.use(cors());
app.use((_request, response, next) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests; block-all-mixed-content",
  );
  next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, "../");
const builtClientIndex = path.join(clientDistDir, "index.html");

const service = new PolymarketSignalService();

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/snapshot", async (_request, response) => {
  response.json(await service.getSnapshot());
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDistDir));

  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api") || request.path === "/ws") {
      next();
      return;
    }

    response.sendFile(builtClientIndex);
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  let unsubscribe = () => {};

  void (async () => {
    socket.send(JSON.stringify({ type: "snapshot", payload: await service.getSnapshot() }));

    unsubscribe = service.onSignal((signal) => {
      socket.send(JSON.stringify({ type: "signal", payload: signal }));
    });
  })();

  socket.on("close", () => {
    unsubscribe();
  });
});

void service.start();

server.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});
