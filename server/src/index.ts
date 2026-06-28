import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";

type Role = "fireboy" | "watergirl";
type Phase = "lobby" | "starting" | "playing";
type InputAction = "down" | "up";
type ScreencastFramePayload = { data: string; sessionId: number };

type ClientMessage =
  | { type: "join_room"; room: string; playerId?: string }
  | { type: "claim_role"; role: Role | null }
  | { type: "ready"; ready: boolean }
  | { type: "input_key"; code: string; action: InputAction }
  | { type: "pointer"; action: "down" | "up" | "click"; x: number; y: number }
  | { type: "reset" }
  | { type: "ping"; sentAt: number }
  | { type: "frame_ack"; seq: number };

type Client = {
  id: string;
  ws: WebSocket;
  room: Room | null;
  role: Role | null;
  ready: boolean;
  pressed: Set<string>;
  lastSeen: number;
  // Per-client frame flow control. We only push a new frame once the client has
  // acked (decoded) earlier ones, so a slow downlink can't build an unbounded
  // backlog. `acksFrames` stays false for legacy clients that never ack, which
  // fall back to the buffer-only path so they keep streaming.
  framesInFlight: number;
  lastAckedSeq: number;
  lastFrameSentAt: number;
  acksFrames: boolean;
};

type Room = {
  code: string;
  clients: Map<string, Client>;
  page: Page | null;
  cdpSession: CDPSession | null;
  phase: Phase;
  startsAt: number | null;
  frameTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  loading: Promise<void> | null;
  frameFailures: number;
  recovering: boolean;
  screencasting: boolean;
  screencastHandler: ((frame: ScreencastFramePayload) => void) | null;
  lastFrameAt: number;
  lastSentAt: number;
  frameSeq: number;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const publicDir = existsSync(path.join(rootDir, "public"))
  ? path.join(rootDir, "public")
  : path.resolve(__dirname, "../public");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const localHost = host === "0.0.0.0" ? "127.0.0.1" : host;
const clientTimeoutMs = Number(process.env.CLIENT_TIMEOUT_MS ?? 30_000);
const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? 10_000);
// Primary backpressure: cap how many frames can be in flight (sent but not yet
// acked) to a client. The client acks each frame once it has decoded it, so the
// producer self-clocks to the client's true end-to-end rate and a slow downlink
// can never build an unbounded backlog. This works regardless of topology - unlike
// ws.bufferedAmount, which is blind when a fast local proxy (e.g. cloudflared over
// loopback) drains the host socket instantly and re-buffers downstream.
const maxFramesInFlight = Math.max(1, Number(process.env.MAX_FRAMES_IN_FLIGHT ?? 2));
// If a client's outstanding frame isn't acked within this long, assume the ack was
// lost (or the client stalled) and resume sending so the stream can't freeze.
const frameAckTimeoutMs = Number(process.env.FRAME_ACK_TIMEOUT_MS ?? 1_500);
// Secondary, cheap safety valve: skip a client whose local send buffer is backed up.
// Effective only when the slow consumer is the immediate socket peer; kept as a guard
// behind the ack-based control above.
const frameBufferLimit = Number(process.env.MAX_FRAME_BUFFER_BYTES ?? 512_000);
const rooms = new Map<string, Room>();
const clients = new Map<string, Client>();

let browser: Browser | null = null;
let activeRoomCode: string | null = null;

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
    pressed: new Set(),
    lastSeen: Date.now(),
    framesInFlight: 0,
    lastAckedSeq: 0,
    lastFrameSentAt: 0,
    acksFrames: false
  };

  clients.set(client.id, client);

  ws.on("message", (raw) => {
    client.lastSeen = Date.now();
    void handleMessage(client, raw.toString());
  });

  ws.on("pong", () => {
    client.lastSeen = Date.now();
  });

  ws.on("close", () => {
    leaveRoom(client);
    clients.delete(client.id);
  });

  send(client, { type: "connected", playerId: client.id });
});

setInterval(() => {
  for (const client of clients.values()) {
    if (Date.now() - client.lastSeen > clientTimeoutMs) {
      leaveRoom(client);
      clients.delete(client.id);
      client.ws.terminate();
      continue;
    }

    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.ping();
    }
  }
}, heartbeatMs);

server.listen(port, host, () => {
  console.log(`Game host listening on http://${host}:${port}`);
});

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(statusPageHtml());
    return;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, rooms: rooms.size, clients: clients.size, activeRoom: activeRoomCode });
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
    adoptClientId(client, message.playerId);
    await joinRoom(client, normalizeRoom(message.room));
    return;
  }

  if (message.type === "ping") {
    send(client, { type: "pong", sentAt: message.sentAt, receivedAt: Date.now() });
    return;
  }

  if (message.type === "frame_ack") {
    handleFrameAck(client, message.seq);
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
  activateRoom(room);

  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  try {
    client.room = room;
    room.clients.set(client.id, client);
    await ensureRoomPage(room);
    if (!isActiveRoom(room)) {
      room.clients.delete(client.id);
      client.room = null;
      scheduleRoomCleanup(room);
      sendError(client, "This room is paused because another room started.");
      return;
    }

    startFrameLoop(room);
    broadcastRoomState(room);
  } catch (error) {
    console.error(`Could not create room ${roomCode}`, error);
    room.clients.delete(client.id);
    client.room = null;
    scheduleRoomCleanup(room);
    sendError(client, "Could not start the cloud game host for this room.");
  }
}

function activateRoom(activeRoom: Room): void {
  activeRoomCode = activeRoom.code;

  for (const room of [...rooms.values()]) {
    if (room.code === activeRoom.code) {
      continue;
    }

    pauseRoom(room, "This room is paused because another room started.");
  }
}

function pauseRoom(room: Room, message: string): void {
  stopScreencast(room);

  if (room.frameTimer) {
    clearInterval(room.frameTimer);
    room.frameTimer = null;
  }

  for (const client of room.clients.values()) {
    releaseClientKeys(client);
    client.ready = false;
    client.framesInFlight = 0;
    sendError(client, message);
  }

  const oldPage = room.page;
  const oldCdpSession = room.cdpSession;
  room.phase = "lobby";
  room.startsAt = null;
  room.frameFailures = 0;
  room.cdpSession = null;
  room.page = null;

  void oldCdpSession?.detach().catch(() => {});
  void oldPage?.close().catch(() => {});
  broadcastRoomState(room);
}

function isActiveRoom(room: Room): boolean {
  return activeRoomCode === room.code;
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
    scheduleRoomCleanup(room);
  } else {
    broadcastRoomState(room);
  }
}

function scheduleRoomCleanup(room: Room): void {
  if (room.cleanupTimer) {
    return;
  }

  room.cleanupTimer = setTimeout(() => {
    void disposeRoom(room);
  }, 15_000);
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
  if (!isActiveRoom(room) || room.phase !== "lobby") {
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
    if (isActiveRoom(room) && room.phase === "starting") {
      room.phase = "playing";
      broadcastRoomState(room);
    }
  }, 1200);
}

async function resetRoom(room: Room): Promise<void> {
  if (!isActiveRoom(room)) {
    for (const client of room.clients.values()) {
      sendError(client, "This room is paused because another room started.");
    }
    return;
  }

  for (const client of room.clients.values()) {
    releaseClientKeys(client);
    client.ready = false;
    client.framesInFlight = 0;
  }

  room.phase = "lobby";
  room.startsAt = null;

  stopScreencast(room);

  try {
    await room.page?.reload({ waitUntil: "domcontentloaded" });
    await room.page?.waitForSelector("#game-root ruffle-player", { timeout: 30_000 });
    room.frameFailures = 0;
  } catch (error) {
    console.error(`Reset reload failed for room ${room.code}`, error);
    await recreateRoomPage(room, "reset reload failure");
    return;
  }

  room.lastFrameAt = Date.now();
  await startScreencast(room);
  broadcast(room, { type: "reset" });
  broadcastRoomState(room);
}

async function handleKeyInput(client: Client, code: string, action: InputAction): Promise<void> {
  const room = client.room;
  if (!room?.page || !isActiveRoom(room) || room.phase !== "playing" || !client.role || !isRoleKey(client.role, code)) {
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
  if (!room?.page || !isActiveRoom(room) || room.phase !== "playing") {
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
    cdpSession: null,
    phase: "lobby",
    startsAt: null,
    frameTimer: null,
    cleanupTimer: null,
    loading: null,
    frameFailures: 0,
    recovering: false,
    screencasting: false,
    screencastHandler: null,
    lastFrameAt: 0,
    lastSentAt: 0,
    frameSeq: 0
  };

  rooms.set(code, room);
  return room;
}

async function ensureRoomPage(room: Room): Promise<void> {
  if (!isActiveRoom(room)) {
    throw new Error(`Room ${room.code} is paused.`);
  }

  if (room.page?.isClosed()) {
    room.page = null;
    room.cdpSession = null;
  }

  if (room.page) {
    return;
  }

  if (room.loading) {
    await room.loading;
    if (!isActiveRoom(room) || !room.page) {
      throw new Error(`Room ${room.code} did not finish as the active room.`);
    }
    return;
  }

  room.loading = (async () => {
    if (!isActiveRoom(room)) {
      throw new Error(`Room ${room.code} is paused.`);
    }

    if (!browser || !browser.isConnected()) {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"]
      });
    }

    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    try {
      await page.goto(`http://${localHost}:${port}/host.html`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#game-root ruffle-player", { timeout: 30_000 });

      if (!isActiveRoom(room)) {
        await page.close().catch(() => {});
        return;
      }

      room.page = page;
      room.cdpSession = await page.context().newCDPSession(page);
      room.frameFailures = 0;
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  })();

  try {
    await room.loading;
    if (!isActiveRoom(room) || !room.page) {
      throw new Error(`Room ${room.code} did not finish as the active room.`);
    }
  } finally {
    room.loading = null;
  }
}

async function recreateRoomPage(room: Room, reason: string): Promise<void> {
  if (room.recovering) {
    return;
  }

  room.recovering = true;

  stopScreencast(room);

  if (room.frameTimer) {
    clearInterval(room.frameTimer);
    room.frameTimer = null;
  }

  for (const client of room.clients.values()) {
    releaseClientKeys(client);
    client.ready = false;
    client.framesInFlight = 0;
  }

  const oldPage = room.page;
  const oldCdpSession = room.cdpSession;
  room.page = null;
  room.cdpSession = null;
  room.phase = "lobby";
  room.startsAt = null;
  room.frameFailures = 0;

  await oldCdpSession?.detach().catch(() => {});
  await oldPage?.close().catch(() => {});

  try {
    if (isActiveRoom(room)) {
      await ensureRoomPage(room);
      startFrameLoop(room);
      broadcast(room, { type: "reset" });
      broadcastRoomState(room);
    }
  } catch (error) {
    console.error(`Could not recover room ${room.code} after ${reason}`, error);
    for (const client of room.clients.values()) {
      sendError(client, "The cloud game host restarted. Reconnecting the room.");
    }
  } finally {
    room.recovering = false;
  }
}

function startFrameLoop(room: Room): void {
  if (!isActiveRoom(room) || !room.page) {
    return;
  }

  void startScreencast(room);
  startWatchdog(room);
}

async function startScreencast(room: Room): Promise<void> {
  if (!isActiveRoom(room) || !room.page || !room.cdpSession || room.screencasting) {
    return;
  }

  const session = room.cdpSession;
  const handler = (frame: ScreencastFramePayload): void => {
    void onScreencastFrame(room, session, frame);
  };

  session.on("Page.screencastFrame", handler);
  room.screencastHandler = handler;
  room.screencasting = true;
  room.lastFrameAt = Date.now();

  try {
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: Number(process.env.FRAME_QUALITY ?? 60),
      maxWidth: 640,
      maxHeight: 480,
      everyNthFrame: Number(process.env.SCREENCAST_NTH ?? 1)
    });
  } catch (error) {
    console.error(`Could not start screencast for room ${room.code}`, error);
    stopScreencast(room);
  }
}

function stopScreencast(room: Room): void {
  const session = room.cdpSession;
  const handler = room.screencastHandler;

  if (session && handler) {
    session.off("Page.screencastFrame", handler);
    void session.send("Page.stopScreencast").catch(() => {});
  }

  room.screencastHandler = null;
  room.screencasting = false;
}

async function onScreencastFrame(
  room: Room,
  session: CDPSession,
  frame: ScreencastFramePayload
): Promise<void> {
  // The screencast pipeline stalls unless every frame is acknowledged, so ack first -
  // even for frames we throttle away below.
  try {
    await session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  } catch {
    return;
  }

  if (!isActiveRoom(room) || room.cdpSession !== session) {
    return;
  }

  const now = Date.now();
  room.lastFrameAt = now;
  room.frameFailures = 0;

  if (room.clients.size === 0 || !frame.data) {
    return;
  }

  const minInterval = Number(process.env.FRAME_INTERVAL_MS ?? 150);
  if (now - room.lastSentAt < minInterval) {
    return;
  }
  room.lastSentAt = now;

  const seq = ++room.frameSeq;
  broadcastFrame(room, now, seq, {
    type: "frame",
    seq,
    mime: "image/jpeg",
    width: 640,
    height: 480,
    data: frame.data
  });
}

function startWatchdog(room: Room): void {
  if (room.frameTimer) {
    return;
  }

  room.frameTimer = setInterval(() => {
    void checkStream(room);
  }, Number(process.env.WATCHDOG_INTERVAL_MS ?? 2_000));
}

async function checkStream(room: Room): Promise<void> {
  if (!isActiveRoom(room)) {
    if (room.frameTimer) {
      clearInterval(room.frameTimer);
      room.frameTimer = null;
    }
    return;
  }

  if (!room.page || room.clients.size === 0 || room.recovering) {
    return;
  }

  const stallMs = Number(process.env.FRAME_TIMEOUT_MS ?? 8_000);
  if (Date.now() - room.lastFrameAt < stallMs) {
    return;
  }

  room.frameFailures += 1;
  console.error(`Frame stream stalled for room ${room.code} (strike ${room.frameFailures}).`);

  const maxStrikes = Number(process.env.FRAME_MAX_STRIKES ?? 4);
  if (room.frameFailures >= maxStrikes) {
    await recreateRoomPage(room, "frame stream stalled");
    return;
  }

  // A transient stall just restarts the screencast; only repeated strikes recreate the page.
  stopScreencast(room);
  room.lastFrameAt = Date.now();
  await startScreencast(room);
}

function adoptClientId(client: Client, requestedId: string | undefined): void {
  const nextId = normalizePlayerId(requestedId);
  if (!nextId || nextId === client.id) {
    return;
  }

  const existing = clients.get(nextId);
  if (existing && existing !== client) {
    leaveRoom(existing);
    clients.delete(existing.id);
    existing.ws.close(4000, "Reconnected from another socket");
  }

  clients.delete(client.id);
  client.id = nextId;
  clients.set(client.id, client);
}

function normalizePlayerId(playerId: string | undefined): string | null {
  const normalized = String(playerId || "")
    .replace(/[^A-Za-z0-9-]/g, "")
    .slice(0, 80);

  return normalized.length >= 8 ? normalized : null;
}

async function disposeRoom(room: Room): Promise<void> {
  stopScreencast(room);

  if (room.frameTimer) {
    clearInterval(room.frameTimer);
    room.frameTimer = null;
  }

  await room.cdpSession?.detach().catch(() => {});
  await room.page?.close().catch(() => {});
  rooms.delete(room.code);

  if (activeRoomCode === room.code) {
    activeRoomCode = null;
  }
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

// Frames are high-rate and large, so they get their own path: serialize once, and
// only send to clients that can take another frame right now (see canSendFrameTo).
// Skipping a frame keeps every downstream buffer bounded so control messages -
// including the latency ping's pong - stay near real time. A live stream is always
// better served by the next fresh frame than a stale queued one.
function broadcastFrame(room: Room, now: number, seq: number, payload: unknown): void {
  let message: string | null = null;

  for (const client of room.clients.values()) {
    if (!canSendFrameTo(client, now)) {
      continue;
    }

    if (message === null) {
      message = JSON.stringify(payload);
    }
    client.ws.send(message);
    client.framesInFlight += 1;
    client.lastFrameSentAt = now;
  }
}

function canSendFrameTo(client: Client, now: number): boolean {
  if (client.ws.readyState !== client.ws.OPEN) {
    return false;
  }

  // Cheap secondary guard: don't pile onto an already-backed-up local socket buffer.
  if (client.ws.bufferedAmount > frameBufferLimit) {
    return false;
  }

  // Legacy clients that never ack frames fall back to the buffer-only path so they
  // keep streaming instead of stalling on an in-flight cap they can't satisfy.
  if (!client.acksFrames) {
    return true;
  }

  if (client.framesInFlight < maxFramesInFlight) {
    return true;
  }

  // At the cap: only resume if the outstanding frame has gone unacked too long, so a
  // lost ack (or a brief client stall) can't freeze the stream permanently.
  if (now - client.lastFrameSentAt >= frameAckTimeoutMs) {
    client.framesInFlight = 0;
    return true;
  }

  return false;
}

// Each ack means the client has decoded one frame, freeing an in-flight slot. The
// first ack switches the client onto the ack-gated path (and resets stale bootstrap
// accounting); the monotonic seq guard ignores duplicate or out-of-order acks.
function handleFrameAck(client: Client, seq: number): void {
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    return;
  }

  if (!client.acksFrames) {
    client.acksFrames = true;
    client.framesInFlight = 0;
    client.lastAckedSeq = seq;
    return;
  }

  if (seq <= client.lastAckedSeq) {
    return;
  }

  client.lastAckedSeq = seq;
  if (client.framesInFlight > 0) {
    client.framesInFlight -= 1;
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

function statusPageHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Fireboy & Watergirl Game Host</title>
    <style>
      :root { color-scheme: dark; font-family: Arial, sans-serif; background: #0b0d12; color: #f4f6fb; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { width: min(560px, calc(100vw - 32px)); border: 1px solid #2a3140; border-radius: 8px; padding: 28px; background: #141821; }
      h1 { margin: 0 0 10px; font-size: 28px; }
      p { margin: 8px 0; color: #b7bfce; line-height: 1.5; }
      a { color: #ffdc6b; font-weight: 700; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 14px; margin: 20px 0 0; }
      dt { color: #8d96a8; }
      dd { margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>Game host online</h1>
      <p>This Fly.io service runs the shared cloud game session. Open the public Vercel app to play.</p>
      <p><a href="https://fireboy-watergirl-the-forest-temple.vercel.app">Open Fireboy & Watergirl Online</a></p>
      <dl>
        <dt>Rooms</dt><dd>${rooms.size}</dd>
        <dt>Clients</dt><dd>${clients.size}</dd>
        <dt>Health</dt><dd><a href="/health">/health</a></dd>
      </dl>
    </main>
  </body>
</html>`;
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
