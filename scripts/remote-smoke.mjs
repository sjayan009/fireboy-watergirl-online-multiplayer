const serverUrl = process.env.GAME_SERVER_URL ?? "wss://fireboy-watergirl-game-host.fly.dev";
const wsUrl = new URL("/ws", serverUrl);
if (wsUrl.protocol === "https:") {
  wsUrl.protocol = "wss:";
}

if (wsUrl.protocol === "http:") {
  wsUrl.protocol = "ws:";
}

const room = process.env.SMOKE_ROOM ?? `PROD${Date.now()}`;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 45_000);
const targetFrames = Number(process.env.SMOKE_TARGET_FRAMES ?? 5);

const fireboy = connectClient("A", `smoke-a-${Date.now()}`);
const watergirl = connectClient("B", `smoke-b-${Date.now()}`);
const startedAt = Date.now();
let claimed = false;
let readied = false;
let finished = false;

const timer = setInterval(() => {
  if (fireboy.opened && watergirl.opened && !claimed) {
    claimed = true;
    fireboy.send({ type: "claim_role", role: "fireboy" });
    watergirl.send({ type: "claim_role", role: "watergirl" });
  }

  if (claimed && fireboy.players.length === 2 && watergirl.players.length === 2 && !readied) {
    readied = true;
    fireboy.send({ type: "ready", ready: true });
    watergirl.send({ type: "ready", ready: true });
  }

  if (
    fireboy.frames >= targetFrames &&
    watergirl.frames >= targetFrames &&
    fireboy.phase === "playing" &&
    watergirl.phase === "playing"
  ) {
    console.log("Production smoke passed", {
      room,
      fireboyFrames: fireboy.frames,
      watergirlFrames: watergirl.frames,
      phase: fireboy.phase
    });
    void finish(0);
  }

  if (Date.now() - startedAt > timeoutMs) {
    console.error("Production smoke timed out", {
      room,
      fireboyFrames: fireboy.frames,
      watergirlFrames: watergirl.frames,
      fireboyPhase: fireboy.phase,
      watergirlPhase: watergirl.phase,
      fireboyPlayers: fireboy.players,
      watergirlPlayers: watergirl.players,
      claimed,
      readied
    });
    void finish(1);
  }
}, 250);

function connectClient(name, playerId) {
  const client = {
    frames: 0,
    opened: false,
    phase: "lobby",
    players: [],
    ws: new WebSocket(wsUrl),
    send(payload) {
      this.ws.send(JSON.stringify(payload));
    }
  };

  client.ws.addEventListener("open", () => {
    client.opened = true;
    console.log(`${name} open`);
    client.send({ type: "join_room", room, playerId });
  });

  client.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "room_state") {
      client.phase = message.phase;
      client.players = message.players;
    }

    if (message.type === "frame") {
      client.frames += 1;
      if (client.frames === 1) {
        console.log(`${name} first frame`, message.width, message.height, message.data.length);
      }
    }

    if (message.type === "error") {
      console.log(`${name} error`, message.message);
    }
  });

  client.ws.addEventListener("close", (event) => {
    console.log(`${name} close`, event.code, event.reason);
  });

  client.ws.addEventListener("error", () => {
    console.log(`${name} websocket error`);
  });

  return client;
}

async function finish(code) {
  if (finished) {
    return;
  }

  finished = true;
  clearInterval(timer);
  await Promise.all([closeClient(fireboy), closeClient(watergirl)]);
  process.exit(code);
}

async function closeClient(client) {
  if (client.ws.readyState >= 2) {
    return;
  }

  await new Promise((resolve) => {
    const timerId = setTimeout(resolve, 1_000);
    client.ws.addEventListener("close", () => {
      clearTimeout(timerId);
      resolve();
    }, { once: true });
    client.ws.close();
  });
}
