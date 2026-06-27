import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import "./styles.css";
import { keyLabels, roleForKey, roleKeys, roleLabels } from "./keys";
import { createRoomCode, getInitialRoom, getOrCreatePlayerId, roomUrl } from "./room";
import { RuffleHost } from "./ruffle";
import type {
  ConnectionState,
  GameEvent,
  PlayerPresence,
  ReadyPayload,
  Role,
  RolePayload,
  StartPayload
} from "./types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const hasSupabaseConfig = Boolean(supabaseUrl && supabaseKey);

const playerId = getOrCreatePlayerId();
let room = getInitialRoom();
let selectedRole: Role | null = null;
let ready = false;
let startedAt: number | null = null;
let connectionState: ConnectionState = hasSupabaseConfig ? "connecting" : "offline";
let channel: RealtimeChannel | null = null;
let ruffleHost: RuffleHost | null = null;
let seq = 0;
let lastLatencyMs: number | null = null;
let pingTimer: number | null = null;
let toastTimer: number | null = null;

const remoteSeq = new Map<string, number>();
const pressed = new Set<string>();
let players = new Map<string, PlayerPresence>();

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App mount not found.");
}

app.innerHTML = `
  <div class="app-shell">
    <aside class="panel" aria-label="Room controls">
      <div class="brand">
        <h1>Fireboy & Watergirl Online</h1>
        <p>Two-player remote co-op through a shared invite room.</p>
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
        <div id="game-frame" class="game-frame"></div>
      </div>
      <div id="overlay" class="overlay">
        <div class="overlay-card">
          <h2 id="overlay-title">Waiting for players</h2>
          <p id="overlay-copy" class="muted">Choose a character, share the room link, and press ready when both of you are here.</p>
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
  gameFrame: byId("game-frame"),
  overlay: byId("overlay"),
  overlayTitle: byId("overlay-title"),
  overlayCopy: byId("overlay-copy"),
  overlayReady: byId<HTMLButtonElement>("overlay-ready")
};

void boot();

async function boot(): Promise<void> {
  ruffleHost = new RuffleHost(els.gameFrame);
  try {
    await ruffleHost.load();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not load the game.");
  }

  bindUi();
  render();

  if (hasSupabaseConfig) {
    await connectRoom(room);
  } else {
    players.set(playerId, ownPresence());
    showToast("Add Supabase env vars to enable online rooms.");
    render();
  }
}

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
    ready = false;
    startedAt = null;
    void connectRoom(room);
    render();
  });

  els.roleFireboy.addEventListener("click", () => chooseRole("fireboy"));
  els.roleWatergirl.addEventListener("click", () => chooseRole("watergirl"));
  els.ready.addEventListener("click", toggleReady);
  els.overlayReady.addEventListener("click", toggleReady);
  els.reset.addEventListener("click", () => sendReset());
  els.focusGame.addEventListener("click", () => ruffleHost?.focus());
  els.gameFrame.addEventListener("pointerdown", () => ruffleHost?.focus());

  window.addEventListener("keydown", handleLocalKey, { capture: true });
  window.addEventListener("keyup", handleLocalKey, { capture: true });
}

async function connectRoom(nextRoom: string): Promise<void> {
  stopPing();
  players = new Map();
  remoteSeq.clear();

  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }

  if (!hasSupabaseConfig) {
    connectionState = "offline";
    players.set(playerId, ownPresence());
    render();
    return;
  }

  connectionState = "connecting";
  render();

  const supabase = createClient(supabaseUrl!, supabaseKey!);
  channel = supabase.channel(`fw-room:${nextRoom}`, {
    config: {
      presence: { key: playerId },
      broadcast: { self: false, ack: true }
    }
  });

  channel
    .on("presence", { event: "sync" }, syncPresence)
    .on("presence", { event: "join" }, syncPresence)
    .on("presence", { event: "leave" }, syncPresence)
    .on("broadcast", { event: "game" }, ({ payload }) => handleRemoteEvent(payload as GameEvent))
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        connectionState = "connected";
        await trackPresence();
        startPing();
        render();
        return;
      }

      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        connectionState = "degraded";
        render();
      }
    });
}

function syncPresence(): void {
  if (!channel) {
    return;
  }

  const state = channel.presenceState<PlayerPresence>();
  const nextPlayers = new Map<string, PlayerPresence>();

  for (const [key, presences] of Object.entries(state)) {
    const latest = presences[presences.length - 1];
    if (latest) {
      nextPlayers.set(latest.playerId || key, latest);
    }
  }

  players = nextPlayers;
  render();
}

async function trackPresence(): Promise<void> {
  if (!channel) {
    players.set(playerId, ownPresence());
    return;
  }

  await channel.track(ownPresence());
}

function ownPresence(): PlayerPresence {
  return {
    playerId,
    name: "Player",
    role: selectedRole,
    ready,
    startedAt,
    onlineAt: new Date().toISOString()
  };
}

function chooseRole(role: Role): void {
  if (isRoleTaken(role) && selectedRole !== role) {
    showToast(`${roleLabels[role]} is already taken in this room.`);
    return;
  }

  selectedRole = selectedRole === role ? null : role;
  ready = false;
  void trackPresence();
  void sendGameEvent({
    type: "role",
    playerId,
    role: selectedRole,
    seq: nextSeq()
  } satisfies RolePayload);
  render();
}

function toggleReady(): void {
  if (!selectedRole) {
    showToast("Choose Fireboy or Watergirl first.");
    return;
  }

  ready = !ready;
  void trackPresence();
  void sendGameEvent({
    type: "ready",
    playerId,
    ready,
    seq: nextSeq()
  } satisfies ReadyPayload);

  if (ready && canStart()) {
    const startsAt = Date.now() + 1200;
    startedAt = startsAt;
    void trackPresence();
    void sendGameEvent({
      type: "start",
      playerId,
      startsAt,
      seq: nextSeq()
    } satisfies StartPayload);
    scheduleStart(startsAt);
  }

  render();
}

function canStart(): boolean {
  const present = [...players.values()];
  const roles = new Set(present.map((player) => player.role).filter(Boolean));
  return present.length >= 2 && roles.has("fireboy") && roles.has("watergirl") && present.every((player) => player.ready);
}

function handleRemoteEvent(event: GameEvent): void {
  if (event.playerId === playerId) {
    return;
  }

  const lastSeq = remoteSeq.get(event.playerId) ?? -1;
  if ("seq" in event && event.seq <= lastSeq) {
    return;
  }
  if ("seq" in event) {
    remoteSeq.set(event.playerId, event.seq);
  }

  if (event.type === "input") {
    ruffleHost?.inject(event.code, event.action);
    if (event.action === "down") {
      pressed.add(`${event.playerId}:${event.code}`);
    } else {
      pressed.delete(`${event.playerId}:${event.code}`);
    }
    return;
  }

  if (event.type === "start") {
    startedAt = event.startsAt;
    scheduleStart(event.startsAt);
    render();
    return;
  }

  if (event.type === "reset") {
    ready = false;
    startedAt = event.startsAt;
    releaseAllKeys();
    ruffleHost?.reload();
    void trackPresence();
    render();
    return;
  }

  if (event.type === "ping") {
    void sendGameEvent({
      type: "pong",
      playerId,
      to: event.playerId,
      sentAt: event.sentAt,
      receivedAt: Date.now(),
      seq: nextSeq()
    });
    return;
  }

  if (event.type === "pong" && event.to === playerId) {
    lastLatencyMs = Math.max(0, Date.now() - event.sentAt);
    render();
  }
}

function handleLocalKey(event: KeyboardEvent): void {
  if (!event.isTrusted || !selectedRole || !startedAt || Date.now() < startedAt) {
    return;
  }

  const keyRole = roleForKey(event.code);
  if (keyRole !== selectedRole) {
    return;
  }

  const action = event.type === "keydown" ? "down" : "up";
  const pressKey = `${playerId}:${event.code}`;
  if (action === "down" && pressed.has(pressKey)) {
    event.preventDefault();
    return;
  }

  if (action === "down") {
    pressed.add(pressKey);
  } else {
    pressed.delete(pressKey);
  }

  event.preventDefault();
  ruffleHost?.inject(event.code, action);

  void sendGameEvent({
    type: "input",
    playerId,
    role: selectedRole,
    code: event.code,
    action,
    seq: nextSeq(),
    sentAt: Date.now()
  });
}

async function sendGameEvent(payload: GameEvent): Promise<void> {
  if (!channel || connectionState !== "connected") {
    return;
  }

  const status = await channel.send({
    type: "broadcast",
    event: "game",
    payload
  });

  if (status !== "ok") {
    connectionState = "degraded";
    render();
  }
}

function sendReset(): void {
  ready = false;
  startedAt = null;
  releaseAllKeys();
  ruffleHost?.reload();
  void trackPresence();
  void sendGameEvent({
    type: "reset",
    playerId,
    startsAt: null,
    seq: nextSeq()
  });
  render();
}

function scheduleStart(startsAtValue: number): void {
  const delay = Math.max(0, startsAtValue - Date.now());
  window.setTimeout(() => {
    ruffleHost?.focus();
    render();
  }, delay);
}

function releaseAllKeys(): void {
  for (const value of pressed) {
    const [, code] = value.split(":");
    if (code) {
      ruffleHost?.inject(code, "up");
    }
  }
  pressed.clear();
}

function startPing(): void {
  stopPing();
  pingTimer = window.setInterval(() => {
    void sendGameEvent({
      type: "ping",
      playerId,
      sentAt: Date.now(),
      seq: nextSeq()
    });
  }, 4000);
}

function stopPing(): void {
  if (pingTimer !== null) {
    window.clearInterval(pingTimer);
    pingTimer = null;
  }
}

function render(): void {
  const own = ownPresence();
  if (!channel) {
    players.set(playerId, own);
  }

  els.roomCode.textContent = room;
  els.connection.textContent = connectionLabel(connectionState);
  els.latency.textContent = lastLatencyMs === null ? "--" : `${lastLatencyMs} ms`;

  els.roleFireboy.classList.toggle("is-selected", selectedRole === "fireboy");
  els.roleWatergirl.classList.toggle("is-selected", selectedRole === "watergirl");
  els.roleFireboy.disabled = isRoleTaken("fireboy") && selectedRole !== "fireboy";
  els.roleWatergirl.disabled = isRoleTaken("watergirl") && selectedRole !== "watergirl";

  els.ready.textContent = ready ? "Unready" : "Ready";
  els.overlayReady.textContent = ready ? "Unready" : "Ready";
  els.ready.disabled = !selectedRole;
  els.overlayReady.disabled = !selectedRole;

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
  const rows = [...players.values()]
    .sort((a, b) => a.playerId.localeCompare(b.playerId))
    .map((player) => {
      const roleClass = player.role ?? "";
      const role = player.role ? roleLabels[player.role] : "No role";
      const self = player.playerId === playerId ? "You" : "Partner";
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
  const startInMs = startedAt ? startedAt - Date.now() : null;
  const hasStarted = startedAt !== null && startInMs !== null && startInMs <= 0;

  els.overlay.hidden = hasStarted;

  if (hasStarted) {
    return;
  }

  if (!selectedRole) {
    els.overlayTitle.textContent = "Choose your character";
    els.overlayCopy.textContent = "Pick Fireboy or Watergirl before you press ready.";
    return;
  }

  if (startedAt && startInMs !== null && startInMs > 0) {
    els.overlayTitle.textContent = "Starting together";
    els.overlayCopy.textContent = `Game starts in ${(startInMs / 1000).toFixed(1)} seconds.`;
    window.setTimeout(render, 150);
    return;
  }

  if (!canStart()) {
    els.overlayTitle.textContent = ready ? "Waiting for your partner" : "Ready up";
    els.overlayCopy.textContent =
      "Both players need different characters and ready status before the game starts.";
    return;
  }

  els.overlayTitle.textContent = "Ready";
  els.overlayCopy.textContent = "Press ready to synchronize the start.";
}

function isRoleTaken(role: Role): boolean {
  return [...players.values()].some((player) => player.playerId !== playerId && player.role === role);
}

function nextSeq(): number {
  seq += 1;
  return seq;
}

function connectionLabel(state: ConnectionState): string {
  if (state === "offline") {
    return "Local only";
  }

  if (state === "connecting") {
    return "Connecting";
  }

  if (state === "degraded") {
    return "Degraded";
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
