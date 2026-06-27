import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";

type Role = "fireboy" | "watergirl";
type Phase = "lobby" | "starting" | "playing";
type InputAction = "down" | "up";

type ClientMessage =
  | { type: "join_room"; room: string }
  | { type: "claim_role"; role: Role | null }
  | { type: "ready"; ready: boolean }
  | { type: "input_key"; code: string; action: InputAction }
  | { type: "pointer"; action: "down" | "up" | "click"; x: number; y: number }
  | { type: "reset" }
  | { type: "ping"; sentAt: number };

type Client = {
  id: string;
  ws: WebSocket;
  room: Room | null;
  role: Role | null;
  ready: boolean;
  pressed: Set<string>;
};

type Room = {
  code: string;
  clients: Map<string, Client>;
  page: Page | null;
  phase: Phase;
  startsAt: number | null;
  frameTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  loading: Promise<void> | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const publicDir = existsSync(path.join(rootDir, "public"))
  ? path.join(rootDir, "public")
  : path.resolve(__dirname, "../public");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const rooms = new Map<string, Room>();
const clients = new Map<string, Client>();

let browser: Browser | null = null;

const server = createServer((req, res) => {
  void handleHttp(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const client: Client = {
    id: randomUUID(),
    ws,
    room: null,
    role: null,
    ready: false,
    pressed: new Set()
  };

  clients.set(client.id, client);

  ws.on("message", (raw) => {
    void handleMessage(client, raw.toString());
  });

  ws.on("close", () => {
    leaveRoom(client);
    clients.delete(client.id);
  });

  send(client, { type: "connected", playerId: client.id });
});

server.listen(port, host, () => {
  console.log(`Game host listening on http://${host}:${port}`);
});

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, rooms: rooms.size, clients: clients.size });
    return;
  }

  if (url.pathname === "/host.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(hostPageHtml());
    return;
  }

  const filePath = safePublicPath(url.pathname);
  if (!filePath) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "public, max-age=31536000, immutable"
    });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function handleMessage(client: Client, raw: string): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    sendError(client, "Malformed message.");
    return;
  }

  if (message.type === "join_room") {
    await joinRoom(client, normalizeRoom(message.room));
    return;
  }

  if (message.type === "ping") {
    send(client, { type: "pong", sentAt: message.sentAt, receivedAt: Date.now() });
    return;
  }

  if (!client.room) {
    sendError(client, "Join a room first.");
    return;
  }

  if (message.type === "claim_role") {
    claimRole(client, message.role);
    return;
  }

  if (message.type === "ready") {
    client.ready = Boolean(message.ready && client.role);
    broadcastRoomState(client.room);
    maybeStart(client.room);
    return;
  }

  if (message.type === "input_key") {
    await handleKeyInput(client, message.code, message.action);
    return;
  }

  if (message.type === "pointer") {
    await handlePointer(client, message.action, message.x, message.y);
    return;
  }

  if (message.type === "reset") {
    await resetRoom(client.room);
  }
}

async function joinRoom(client: Client, roomCode: string): Promise<void> {
  leaveRoom(client);

  const room = getRoom(roomCode);
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  try {
    client.room = room;
    room.clients.set(client.id, client);
    await ensureRoomPage(room);
    startFrameLoop(room);
    broadcastRoomState(room);
  } catch (error) {
    console.error(`Could not create room ${roomCode}`, error);
    room.clients.delete(client.id);
    client.room = null;
    sendError(client, "Could not start the cloud game host for this room.");
  }
}

function leaveRoom(client: Client): void {
  if (!client.room) {
    return;
  }

  releaseClientKeys(client);
  const room = client.room;
  room.clients.delete(client.id);
  client.room = null;
  client.role = null;
  client.ready = false;

  if (room.clients.size === 0) {
    room.cleanupTimer = setTimeout(() => {
      void disposeRoom(room);
    }, 30_000);
  } else {
    broadcastRoomState(room);
  }
}

function claimRole(client: Client, role: Role | null): void {
  if (!client.room) {
    return;
  }

  if (role && role !== "fireboy" && role !== "watergirl") {
    sendError(client, "Invalid role.");
    return;
  }

  if (role && [...client.room.clients.values()].some((other) => other.id !== client.id && other.role === role)) {
    sendError(client, `${role} is already taken.`);
    return;
  }

  client.role = role;
  client.ready = false;
  broadcastRoomState(client.room);
}

function maybeStart(room: Room): void {
  if (room.phase !== "lobby") {
    return;
  }

  const players = [...room.clients.values()];
  const hasFireboy = players.some((player) => player.role === "fireboy" && player.ready);
  const hasWatergirl = players.some((player) => player.role === "watergirl" && player.ready);

  if (!hasFireboy || !hasWatergirl) {
    return;
  }

  room.phase = "starting";
  room.startsAt = Date.now() + 1200;
  broadcast(room, { type: "start", startsAt: room.startsAt });
  broadcastRoomState(room);

  setTimeout(() => {
    if (room.phase === "starting") {
      room.phase = "playing";
      broadcastRoomState(room);
    }
  }, 1200);
}

async function resetRoom(room: Room): Promise<void> {
  for (const client of room.clients.values()) {
    releaseClientKeys(client);
    client.ready = false;
  }

  room.phase = "lobby";
  room.startsAt = null;
  await room.page?.reload({ waitUntil: "domcontentloaded" });
  broadcast(room, { type: "reset" });
  broadcastRoomState(room);
}

async function handleKeyInput(client: Client, code: string, action: InputAction): Promise<void> {
  const room = client.room;
  if (!room?.page || room.phase !== "playing" || !client.role || !isRoleKey(client.role, code)) {
    return;
  }

  const key = playwrightKey(code);
  if (!key) {
    return;
  }

  const pressKey = `${client.id}:${code}`;
  if (action === "down") {
    if (client.pressed.has(pressKey)) {
      return;
    }
    client.pressed.add(pressKey);
    await room.page.keyboard.down(key);
    return;
  }

  client.pressed.delete(pressKey);
  await room.page.keyboard.up(key);
}

async function handlePointer(client: Client, action: "down" | "up" | "click", x: number, y: number): Promise<void> {
  const room = client.room;
  if (!room?.page || room.phase !== "playing") {
    return;
  }

  const px = clamp(x, 0, 1) * 640;
  const py = clamp(y, 0, 1) * 480;

  if (action === "down") {
    await room.page.mouse.move(px, py);
    await room.page.mouse.down();
    return;
  }

  if (action === "up") {
    await room.page.mouse.move(px, py);
    await room.page.mouse.up();
    return;
  }

  await room.page.mouse.click(px, py);
}

function releaseClientKeys(client: Client): void {
  const page = client.room?.page;
  if (!page) {
    client.pressed.clear();
    return;
  }

  for (const pressKey of client.pressed) {
    const [, code] = pressKey.split(":");
    const key = playwrightKey(code);
    if (key) {
      void page.keyboard.up(key);
    }
  }

  client.pressed.clear();
}

function getRoom(code: string): Room {
  const existing = rooms.get(code);
  if (existing) {
    return existing;
  }

  const room: Room = {
    code,
    clients: new Map(),
    page: null,
    phase: "lobby",
    startsAt: null,
    frameTimer: null,
    cleanupTimer: null,
    loading: null
  };

  rooms.set(code, room);
  return room;
}

async function ensureRoomPage(room: Room): Promise<void> {
  if (room.page) {
    return;
  }

  if (room.loading) {
    await room.loading;
    return;
  }

  room.loading = (async () => {
    browser ??= await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.goto(`http://${host}:${port}/host.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#game-root ruffle-player", { timeout: 20_000 });
    room.page = page;
  })();

  try {
    await room.loading;
  } finally {
    room.loading = null;
  }
}

function startFrameLoop(room: Room): void {
  if (room.frameTimer || !room.page) {
    return;
  }

  room.frameTimer = setInterval(() => {
    void sendFrame(room);
  }, Number(process.env.FRAME_INTERVAL_MS ?? 100));
}

async function sendFrame(room: Room): Promise<void> {
  if (!room.page || room.clients.size === 0) {
    return;
  }

  try {
    const frame = await room.page.locator("#game-root").screenshot({
      type: "jpeg",
      quality: Number(process.env.FRAME_QUALITY ?? 62)
    });
    broadcast(room, {
      type: "frame",
      mime: "image/jpeg",
      width: 640,
      height: 480,
      data: frame.toString("base64")
    });
  } catch (error) {
    console.error(`Frame capture failed for room ${room.code}`, error);
  }
}

async function disposeRoom(room: Room): Promise<void> {
  if (room.frameTimer) {
    clearInterval(room.frameTimer);
    room.frameTimer = null;
  }

  await room.page?.close().catch(() => {});
  rooms.delete(room.code);
}

function broadcastRoomState(room: Room): void {
  for (const client of room.clients.values()) {
    send(client, {
      type: "room_state",
      room: room.code,
      selfId: client.id,
      phase: room.phase,
      startsAt: room.startsAt,
      players: [...room.clients.values()].map((player) => ({
        id: player.id,
        role: player.role,
        ready: player.ready
      }))
    });
  }
}

function broadcast(room: Room, payload: unknown): void {
  for (const client of room.clients.values()) {
    send(client, payload);
  }
}

function send(client: Client, payload: unknown): void {
  if (client.ws.readyState === client.ws.OPEN) {
    client.ws.send(JSON.stringify(payload));
  }
}

function sendError(client: Client, message: string): void {
  send(client, { type: "error", message });
}

function normalizeRoom(room: string): string {
  return String(room || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16) || "ROOM";
}

function isRoleKey(role: Role, code: string): boolean {
  if (role === "fireboy") {
    return ["ArrowLeft", "ArrowUp", "ArrowRight"].includes(code);
  }

  return ["KeyA", "KeyW", "KeyD"].includes(code);
}

function playwrightKey(code: string): string | null {
  const keys: Record<string, string> = {
    ArrowLeft: "ArrowLeft",
    ArrowUp: "ArrowUp",
    ArrowRight: "ArrowRight",
    KeyA: "a",
    KeyW: "w",
    KeyD: "d"
  };

  return keys[code] ?? null;
}

function safePublicPath(urlPath: string): string | null {
  const cleanPath = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, cleanPath || "index.html");
  return filePath.startsWith(publicDir) ? filePath : null;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".swf": "application/x-shockwave-flash",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".css": "text/css; charset=utf-8"
  };

  return types[ext] ?? "application/octet-stream";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function hostPageHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=640,height=480,initial-scale=1" />
    <style>
      html, body { margin: 0; width: 640px; height: 480px; overflow: hidden; background: #05070a; }
      #game-root { width: 640px; height: 480px; overflow: hidden; background: #05070a; }
      ruffle-player { width: 640px; height: 480px; display: block; }
    </style>
  </head>
  <body>
    <div id="game-root"></div>
    <script>
      window.RufflePlayer = window.RufflePlayer || {};
      window.RufflePlayer.config = {
        autoplay: "on",
        unmuteOverlay: "hidden",
        warnOnUnsupportedContent: false,
        letterbox: "on"
      };
      window.addEventListener("DOMContentLoaded", async () => {
        const ruffle = window.RufflePlayer.newest();
        const player = ruffle.createPlayer();
        player.tabIndex = 0;
        document.getElementById("game-root").append(player);
        await player.ruffle().load("/game.swf");
        player.focus();
      });
    </script>
    <script src="/ruffle/ruffle.js"></script>
  </body>
</html>`;
}
