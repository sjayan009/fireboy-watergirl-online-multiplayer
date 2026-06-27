import "./styles.css";
import { keyLabels, roleKeys, roleLabels } from "./keys";
import { createRoomCode, getInitialRoom, getOrCreatePlayerId, roomUrl } from "./room";
import type { ConnectionState, Role } from "./types";

type Phase = "lobby" | "starting" | "playing";

type ServerMessage =
  | { type: "connected"; playerId: string }
  | { type: "room_state"; room: string; selfId: string; phase: Phase; startsAt: number | null; players: ServerPlayer[] }
  | { type: "frame"; mime: string; width: number; height: number; data: string }
  | { type: "start"; startsAt: number }
  | { type: "reset" }
  | { type: "error"; message: string }
  | { type: "pong"; sentAt: number; receivedAt: number };

type ServerPlayer = {
  id: string;
  role: Role | null;
  ready: boolean;
};

const playerId = getOrCreatePlayerId();
let room = getInitialRoom();
let selectedRole: Role | null = null;
let desiredReady = false;
let ready = false;
let phase: Phase = "lobby";
let startsAt: number | null = null;
let connectionState: ConnectionState = "connecting";
let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let pingTimer: number | null = null;
let toastTimer: number | null = null;
let lastLatencyMs: number | null = null;
let selfId = playerId;
let players: ServerPlayer[] = [];

const pressed = new Set<string>();
const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App mount not found.");
}

app.innerHTML = `
  <div class="app-shell">
    <aside class="panel" aria-label="Room controls">
      <div class="brand">
        <h1>Fireboy & Watergirl Online</h1>
        <p>One cloud-hosted game session, two remote controllers.</p>
      </div>

      <section class="section">
        <div class="label">Invite Room</div>
        <div class="room-row">
          <div id="room-code" class="room-code"></div>
          <button id="copy-link" type="button">Copy</button>
        </div>
        <button id="new-room" class="secondary" type="button">New Room</button>
        <div id="toast" class="toast" role="status"></div>
      </section>

      <section class="section">
        <div class="label">Choose Character</div>
        <div class="role-grid">
          <button id="role-fireboy" class="role-button fireboy" type="button">
            <span class="role-name">Fireboy</span>
            <span class="role-keys">Left / Up / Right</span>
          </button>
          <button id="role-watergirl" class="role-button watergirl" type="button">
            <span class="role-name">Watergirl</span>
            <span class="role-keys">A / W / D</span>
          </button>
        </div>
      </section>

      <section class="section">
        <div class="label">Session</div>
        <div class="status-grid">
          <div class="status-box">
            <span class="muted">Connection</span>
            <strong id="connection">Connecting</strong>
          </div>
          <div class="status-box">
            <span class="muted">Latency</span>
            <strong id="latency">--</strong>
          </div>
        </div>
        <div id="players" class="player-list"></div>
      </section>

      <section class="section actions">
        <button id="ready" type="button">Ready</button>
        <button id="reset" class="danger" type="button">Reset</button>
      </section>
    </aside>

    <section class="game-stage" aria-label="Game">
      <div class="game-toolbar">
        <div>
          <strong id="role-status">No character selected</strong>
          <span id="key-status" class="muted">Pick Fireboy or Watergirl.</span>
        </div>
        <button id="focus-game" class="secondary" type="button">Focus Game</button>
      </div>
      <div class="game-wrap">
        <div id="game-frame" class="game-frame">
          <canvas id="stream-canvas" width="640" height="480" aria-label="Cloud game stream"></canvas>
        </div>
      </div>
      <div id="overlay" class="overlay">
        <div class="overlay-card">
          <h2 id="overlay-title">Connecting</h2>
          <p id="overlay-copy" class="muted">Connecting to the cloud game host.</p>
          <button id="overlay-ready" type="button">Ready</button>
        </div>
      </div>
    </section>
  </div>
`;

const els = {
  roomCode: byId("room-code"),
  copyLink: byId<HTMLButtonElement>("copy-link"),
  newRoom: byId<HTMLButtonElement>("new-room"),
  toast: byId("toast"),
  roleFireboy: byId<HTMLButtonElement>("role-fireboy"),
  roleWatergirl: byId<HTMLButtonElement>("role-watergirl"),
  connection: byId("connection"),
  latency: byId("latency"),
  players: byId("players"),
  ready: byId<HTMLButtonElement>("ready"),
  reset: byId<HTMLButtonElement>("reset"),
  roleStatus: byId("role-status"),
  keyStatus: byId("key-status"),
  focusGame: byId<HTMLButtonElement>("focus-game"),
  canvas: byId<HTMLCanvasElement>("stream-canvas"),
  overlay: byId("overlay"),
  overlayTitle: byId("overlay-title"),
  overlayCopy: byId("overlay-copy"),
  overlayReady: byId<HTMLButtonElement>("overlay-ready")
};

const canvasContext = els.canvas.getContext("2d");

bindUi();
connect();
render();

function bindUi(): void {
  els.copyLink.addEventListener("click", async () => {
    await navigator.clipboard.writeText(roomUrl(room));
    showToast("Invite link copied.");
  });

  els.newRoom.addEventListener("click", () => {
    const nextRoom = createRoomCode();
    const url = new URL(window.location.href);
    url.searchParams.set("room", nextRoom);
    window.history.pushState(null, "", url);
    room = nextRoom;
    selectedRole = null;
    desiredReady = false;
    ready = false;
    phase = "lobby";
    startsAt = null;
    connect();
    render();
  });

  els.roleFireboy.addEventListener("click", () => chooseRole("fireboy"));
  els.roleWatergirl.addEventListener("click", () => chooseRole("watergirl"));
  els.ready.addEventListener("click", toggleReady);
  els.overlayReady.addEventListener("click", toggleReady);
  els.reset.addEventListener("click", () => send({ type: "reset" }));
  els.focusGame.addEventListener("click", () => els.canvas.focus());
  els.canvas.addEventListener("pointerdown", (event) => sendPointer("down", event));
  els.canvas.addEventListener("pointerup", (event) => sendPointer("up", event));
  els.canvas.addEventListener("pointercancel", (event) => sendPointer("up", event));
  els.canvas.tabIndex = 0;

  window.addEventListener("keydown", handleLocalKey, { capture: true });
  window.addEventListener("keyup", handleLocalKey, { capture: true });
}

function connect(): void {
  stopPing();
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  socket?.close();
  connectionState = "connecting";
  const url = gameServerUrl();

  if (!url) {
    connectionState = "offline";
    showToast("Set VITE_GAME_SERVER_URL to connect to the cloud host.");
    render();
    return;
  }

  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    connectionState = "connected";
    send({ type: "join_room", room });
    startPing();
    render();
  });

  socket.addEventListener("message", (event) => {
    handleServerMessage(JSON.parse(event.data as string) as ServerMessage);
  });

  socket.addEventListener("close", () => {
    connectionState = "degraded";
    stopPing();
    render();
    reconnectTimer = window.setTimeout(connect, 1500);
  });

  socket.addEventListener("error", () => {
    connectionState = "degraded";
    render();
  });
}

function handleServerMessage(message: ServerMessage): void {
  if (message.type === "connected") {
    selfId = message.playerId;
    return;
  }

  if (message.type === "room_state") {
    selfId = message.selfId;
    players = message.players;
    phase = message.phase;
    startsAt = message.startsAt;
    const own = players.find((player) => player.id === selfId);
    selectedRole = own?.role ?? selectedRole;
    ready = Boolean(own?.ready);
    reconcileDesiredState(own);
    render();
    return;
  }

  if (message.type === "frame") {
    drawFrame(message);
    return;
  }

  if (message.type === "start") {
    startsAt = message.startsAt;
    phase = "starting";
    render();
    return;
  }

  if (message.type === "reset") {
    pressed.clear();
    phase = "lobby";
    startsAt = null;
    desiredReady = false;
    ready = false;
    render();
    return;
  }

  if (message.type === "pong") {
    lastLatencyMs = Math.max(0, Date.now() - message.sentAt);
    render();
    return;
  }

  if (message.type === "error") {
    desiredReady = ready;
    showToast(message.message);
    render();
  }
}

function drawFrame(frame: Extract<ServerMessage, { type: "frame" }>): void {
  if (!canvasContext) {
    return;
  }

  const image = new Image();
  image.onload = () => {
    canvasContext.drawImage(image, 0, 0, els.canvas.width, els.canvas.height);
  };
  image.src = `data:${frame.mime};base64,${frame.data}`;
}

function chooseRole(role: Role): void {
  if (isRoleTaken(role) && selectedRole !== role) {
    showToast(`${roleLabels[role]} is already taken in this room.`);
    return;
  }

  const nextRole = selectedRole === role ? null : role;
  selectedRole = nextRole;
  desiredReady = false;
  ready = false;
  send({ type: "claim_role", role: nextRole });
  render();
}

function toggleReady(): void {
  if (!selectedRole) {
    showToast("Choose Fireboy or Watergirl first.");
    return;
  }

  desiredReady = !(desiredReady || ready);
  if (!send({ type: "ready", ready: desiredReady })) {
    showToast("Reconnecting. Ready will sync when the room reconnects.");
  }
  render();
}

function handleLocalKey(event: KeyboardEvent): void {
  if (!selectedRole || phase !== "playing" || !roleKeys[selectedRole].includes(event.code)) {
    return;
  }

  const action = event.type === "keydown" ? "down" : "up";
  if (action === "down" && pressed.has(event.code)) {
    event.preventDefault();
    return;
  }

  if (action === "down") {
    pressed.add(event.code);
  } else {
    pressed.delete(event.code);
  }

  event.preventDefault();
  send({ type: "input_key", code: event.code, action });
}

function sendPointer(action: "down" | "up", event: PointerEvent): void {
  if (phase !== "playing") {
    return;
  }

  const rect = els.canvas.getBoundingClientRect();
  send({
    type: "pointer",
    action,
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  });
  els.canvas.focus();
  event.preventDefault();
}

function startPing(): void {
  stopPing();
  pingTimer = window.setInterval(() => {
    send({ type: "ping", sentAt: Date.now() });
  }, 4000);
}

function stopPing(): void {
  if (pingTimer !== null) {
    window.clearInterval(pingTimer);
    pingTimer = null;
  }
}

function send(payload: unknown): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }

  return false;
}

function render(): void {
  const readyPending = desiredReady && !ready && phase !== "playing";
  els.roomCode.textContent = room;
  els.connection.textContent = connectionLabel(connectionState);
  els.latency.textContent = lastLatencyMs === null ? "--" : `${lastLatencyMs} ms`;

  els.roleFireboy.classList.toggle("is-selected", selectedRole === "fireboy");
  els.roleWatergirl.classList.toggle("is-selected", selectedRole === "watergirl");
  els.roleFireboy.disabled = isRoleTaken("fireboy") && selectedRole !== "fireboy";
  els.roleWatergirl.disabled = isRoleTaken("watergirl") && selectedRole !== "watergirl";

  const readyLabel = ready ? "Unready" : readyPending ? "Syncing..." : "Ready";
  els.ready.textContent = readyLabel;
  els.overlayReady.textContent = readyLabel;
  els.ready.disabled = !selectedRole || phase === "playing";
  els.overlayReady.disabled = !selectedRole || phase === "playing";

  els.roleStatus.textContent = selectedRole
    ? `You are ${roleLabels[selectedRole]}`
    : "No character selected";
  els.keyStatus.textContent = selectedRole
    ? `${roleLabels[selectedRole]} controls: ${roleKeys[selectedRole].map((key) => keyLabels[key]).join(" / ")}`
    : "Pick Fireboy or Watergirl.";

  renderPlayers();
  renderOverlay();
}

function renderPlayers(): void {
  const rows = players
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((player) => {
      const roleClass = player.role ?? "";
      const role = player.role ? roleLabels[player.role] : "No role";
      const self = player.id === selfId ? "You" : "Partner";
      return `
        <div class="player-row">
          <div>
            <strong>${self}</strong>
            <div class="muted">${role}</div>
          </div>
          <div>
            <span class="pill ${roleClass}">${role}</span>
            <span class="pill ${player.ready ? "ready" : ""}">${player.ready ? "Ready" : "Waiting"}</span>
          </div>
        </div>
      `;
    })
    .join("");

  els.players.innerHTML = rows || `<div class="muted">No players connected yet.</div>`;
}

function renderOverlay(): void {
  if (connectionState !== "connected") {
    els.overlay.hidden = false;
    els.overlayTitle.textContent = "Connecting";
    els.overlayCopy.textContent = "Connecting to the cloud game host.";
    return;
  }

  if (phase === "playing") {
    els.overlay.hidden = true;
    return;
  }

  els.overlay.hidden = false;

  if (!selectedRole) {
    els.overlayTitle.textContent = "Choose your character";
    els.overlayCopy.textContent = "Pick Fireboy or Watergirl before you press ready.";
    return;
  }

  if (phase === "starting" && startsAt) {
    const startInMs = Math.max(0, startsAt - Date.now());
    els.overlayTitle.textContent = "Starting together";
    els.overlayCopy.textContent = `Game unlocks in ${(startInMs / 1000).toFixed(1)} seconds.`;
    window.setTimeout(render, 150);
    return;
  }

  if (desiredReady && !ready) {
    els.overlayTitle.textContent = "Syncing ready state";
    els.overlayCopy.textContent = "Confirming your ready status with the shared game host.";
    return;
  }

  els.overlayTitle.textContent = ready ? "Waiting for your partner" : "Ready up";
  els.overlayCopy.textContent =
    "Both players need different characters and ready status before the shared game unlocks.";
}

function isRoleTaken(role: Role): boolean {
  return players.some((player) => player.id !== selfId && player.role === role);
}

function reconcileDesiredState(own: ServerPlayer | undefined): void {
  if (phase === "playing") {
    desiredReady = ready;
    return;
  }

  const serverRole = own?.role ?? null;
  const serverReady = Boolean(own?.ready);

  if (selectedRole && serverRole !== selectedRole && !isRoleTaken(selectedRole)) {
    send({ type: "claim_role", role: selectedRole });
    return;
  }

  if (desiredReady && !serverReady && serverRole) {
    window.setTimeout(() => {
      if (desiredReady && !ready && phase === "lobby") {
        send({ type: "ready", ready: true });
      }
    }, 250);
  }
}

function gameServerUrl(): string | null {
  const configured = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;
  const base =
    configured ||
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? "ws://127.0.0.1:8080"
      : "");

  if (!base) {
    return null;
  }

  const url = new URL(base);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.pathname === "/" || !url.pathname) {
    url.pathname = "/ws";
  }
  return url.toString();
}

function connectionLabel(state: ConnectionState): string {
  if (state === "offline") {
    return "No host";
  }

  if (state === "connecting") {
    return "Connecting";
  }

  if (state === "degraded") {
    return "Reconnecting";
  }

  return "Connected";
}

function showToast(message: string): void {
  els.toast.textContent = message;

  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    els.toast.textContent = "";
    toastTimer = null;
  }, 3200);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }

  return element as T;
}
