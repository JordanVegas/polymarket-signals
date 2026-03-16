import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MongoClient } from "mongodb";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

const APP_ID = "polysignals";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 14;

type AuthorizedUser = {
  id: string;
  username: string;
  allowedApps: string[];
};

type SessionPayload = {
  username: string;
  expiresAt: number;
};

type WebUserRecord = {
  _id: unknown;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  allowedApps?: string[];
};

declare global {
  namespace Express {
    interface Request {
      sessionUser?: AuthorizedUser & { expiresAt: number };
    }
  }
}

function parseCookies(header = "") {
  const cookies: Record<string, string> = {};
  for (const chunk of String(header).split(";")) {
    const [name, ...rest] = chunk.trim().split("=");
    if (!name) {
      continue;
    }

    cookies[name] = decodeURIComponent(rest.join("="));
  }

  return cookies;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeAllowedApps(value?: string[]) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function canAccessApp(user: Pick<WebUserRecord, "allowedApps"> | null, appId: string) {
  const allowedApps = normalizeAllowedApps(user?.allowedApps);
  if (!allowedApps.length) {
    return true;
  }

  return allowedApps.includes(appId);
}

function derivePasswordHash(password: string, salt: string) {
  return crypto.scryptSync(String(password), String(salt), 64).toString("hex");
}

function signSessionPayload(payload: string) {
  return crypto
    .createHmac("sha256", config.webSessionSecret)
    .update(payload)
    .digest("hex");
}

function createSessionToken(username: string) {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const payload = `${username}.${expiresAt}`;
  const signature = signSessionPayload(payload);
  return `${payload}.${signature}`;
}

function readSessionFromCookies(cookieHeader = ""): SessionPayload | null {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[config.webSessionCookieName];
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 3) {
    return null;
  }

  const signature = parts.pop();
  const expiresAt = Number(parts.pop());
  const username = parts.join(".");
  const payload = `${username}.${expiresAt}`;

  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return null;
  }

  if (!safeEqual(signSessionPayload(payload), signature)) {
    return null;
  }

  return { username, expiresAt };
}

function buildCookie(request: IncomingMessage, rawValue: string, maxAgeSeconds: number) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const isSecure = forwardedProto === "https";
  const cookie = [
    `${config.webSessionCookieName}=${rawValue}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (config.webCookieDomain) {
    cookie.push(`Domain=${config.webCookieDomain}`);
  }

  if (isSecure) {
    cookie.push("Secure");
  }

  return cookie.join("; ");
}

function setSessionCookie(request: IncomingMessage, response: ServerResponse, username: string) {
  const token = encodeURIComponent(createSessionToken(username));
  response.setHeader(
    "Set-Cookie",
    buildCookie(request, token, Math.floor(SESSION_DURATION_MS / 1000)),
  );
}

function clearSessionCookie(request: IncomingMessage, response: ServerResponse) {
  response.setHeader("Set-Cookie", buildCookie(request, "", 0));
}

function buildLoginHtml(error: boolean, nextPath: string) {
  const safeNext = nextPath.startsWith("/") ? nextPath : "/";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Polysignals Login</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet" />
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Space Grotesk", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(0, 190, 165, 0.28), transparent 28%),
          radial-gradient(circle at 85% 20%, rgba(31, 92, 255, 0.24), transparent 22%),
          linear-gradient(180deg, #061017 0%, #081722 45%, #050b12 100%);
        color: #eff8ff;
      }
      .shell {
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 28px;
        background: rgba(7, 16, 24, 0.8);
        border: 1px solid rgba(183, 228, 255, 0.12);
        box-shadow: 0 30px 80px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(14px);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 1.8rem;
      }
      p {
        margin: 0 0 18px;
        color: #b8cfdb;
      }
      form {
        display: grid;
        gap: 14px;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 0.95rem;
      }
      input {
        min-height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: inherit;
        padding: 0 14px;
        font: inherit;
      }
      button {
        min-height: 46px;
        border-radius: 999px;
        border: 0;
        font: inherit;
        font-weight: 700;
        background: linear-gradient(135deg, rgba(67, 232, 154, 0.92), rgba(74, 168, 255, 0.92));
        color: #031018;
        cursor: pointer;
      }
      .error {
        margin-bottom: 14px;
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(255, 90, 90, 0.12);
        border: 1px solid rgba(255, 90, 90, 0.2);
        color: #ffd9d9;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <h1>Polysignals</h1>
      <p>Sign in with your shared TUF account to access the live signal feed.</p>
      ${error ? '<div class="error">Invalid credentials or access not granted for Polysignals.</div>' : ""}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${safeNext}" />
        <label>
          Username
          <input name="username" type="text" autocomplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Enter</button>
      </form>
    </main>
  </body>
</html>`;
}

export class SharedAuthService {
  private client: MongoClient | null = null;

  async connect() {
    if (this.client) {
      return;
    }

    this.client = new MongoClient(config.authMongoUri);
    await this.client.connect();
  }

  async close() {
    await this.client?.close();
    this.client = null;
  }

  async authenticateUser(username: string, password: string): Promise<AuthorizedUser | null> {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername || !password) {
      return null;
    }

    const user = await this.findUser(normalizedUsername);
    if (!user) {
      return null;
    }

    const passwordHash = derivePasswordHash(password, user.passwordSalt);
    if (!safeEqual(user.passwordHash, passwordHash)) {
      return null;
    }

    if (!canAccessApp(user, APP_ID)) {
      return null;
    }

    return {
      id: String(user._id),
      username: user.username,
      allowedApps: normalizeAllowedApps(user.allowedApps),
    };
  }

  async getAuthorizedUser(username: string): Promise<AuthorizedUser | null> {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername) {
      return null;
    }

    const user = await this.findUser(normalizedUsername);
    if (!user || !canAccessApp(user, APP_ID)) {
      return null;
    }

    return {
      id: String(user._id),
      username: user.username,
      allowedApps: normalizeAllowedApps(user.allowedApps),
    };
  }

  readSession(request: IncomingMessage) {
    return readSessionFromCookies(request.headers.cookie || "");
  }

  async getRequestUser(request: IncomingMessage) {
    const session = this.readSession(request);
    if (!session) {
      return null;
    }

    const user = await this.getAuthorizedUser(session.username);
    if (!user) {
      return null;
    }

    return { ...user, expiresAt: session.expiresAt };
  }

  createSessionMiddleware() {
    return async (request: Request, response: Response, next: NextFunction) => {
      const openPaths = new Set(["/login", "/logout", "/health", "/api/health"]);
      if (openPaths.has(request.path)) {
        next();
        return;
      }

      const sessionUser = await this.getRequestUser(request);
      if (sessionUser) {
        request.sessionUser = sessionUser;
        next();
        return;
      }

      clearSessionCookie(request, response);
      if (request.path.startsWith("/api")) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }

      const nextPath = encodeURIComponent(request.originalUrl || "/");
      response.redirect(`/login?next=${nextPath}`);
    };
  }

  attachSessionUser() {
    return async (request: Request, _response: Response, next: NextFunction) => {
      if (request.sessionUser) {
        next();
        return;
      }

      const sessionUser = await this.getRequestUser(request);
      if (sessionUser) {
        request.sessionUser = sessionUser;
      }

      next();
    };
  }

  handleLoginPage(request: Request, response: Response) {
    const nextPath =
      typeof request.query.next === "string" && request.query.next.startsWith("/")
        ? request.query.next
        : "/";
    const hasError = request.query.error === "1";
    response.type("html").send(buildLoginHtml(hasError, nextPath));
  }

  async handleLogin(request: Request, response: Response) {
    const username = String(request.body.username || "");
    const password = String(request.body.password || "");
    const nextPath =
      typeof request.body.next === "string" && request.body.next.startsWith("/")
        ? request.body.next
        : "/";

    const user = await this.authenticateUser(username, password);
    if (!user) {
      response.redirect(`/login?error=1&next=${encodeURIComponent(nextPath)}`);
      return;
    }

    setSessionCookie(request, response, user.username);
    response.redirect(nextPath);
  }

  handleLogout(request: Request, response: Response) {
    clearSessionCookie(request, response);
    response.redirect("/login");
  }

  private async findUser(username: string): Promise<WebUserRecord | null> {
    if (!this.client) {
      throw new Error("Shared auth service is not connected");
    }

    return this.client
      .db()
      .collection<WebUserRecord>("webusers")
      .findOne({ username });
  }
}
