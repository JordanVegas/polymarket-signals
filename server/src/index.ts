import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SharedAuthService } from "./auth.js";
import { config } from "./config.js";
import { PolymarketSignalService } from "./polymarket.js";

const app = express();
const auth = new SharedAuthService();
app.use(cors());
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use((_request, response, next) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests; block-all-mixed-content",
  );
  next();
});
app.use(auth.createSessionMiddleware());
app.use(auth.attachSessionUser());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, "../");
const builtClientIndex = path.join(clientDistDir, "index.html");
const hasBuiltClient = fs.existsSync(builtClientIndex);

const service = new PolymarketSignalService();

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/login", (request, response) => {
  auth.handleLoginPage(request, response);
});

app.post("/login", async (request, response) => {
  await auth.handleLogin(request, response);
});

app.get("/logout", (request, response) => {
  auth.handleLogout(request, response);
});

app.get("/api/snapshot", async (_request, response) => {
  response.json(await service.getSnapshot());
});

if (hasBuiltClient) {
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
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket) => {
  let unsubscribeSignal = () => {};

  void (async () => {
    socket.send(JSON.stringify({ type: "snapshot", payload: await service.getSnapshot() }));

    unsubscribeSignal = service.onSignal((signal) => {
      socket.send(JSON.stringify({ type: "signal", payload: signal }));
    });
  })();

  socket.on("close", () => {
    unsubscribeSignal();
  });
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  void (async () => {
    const sessionUser = await auth.getRequestUser(request);
    if (!sessionUser) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
    });
  })().catch(() => {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
  });
});

void (async () => {
  await auth.connect();
  await service.start();
})();

server.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});
