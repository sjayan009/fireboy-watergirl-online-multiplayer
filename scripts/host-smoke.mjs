import { spawn, spawnSync } from "node:child_process";

const server = spawn("npm", ["run", "start:tsx"], {
  cwd: "server",
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "8080",
    FRAME_INTERVAL_MS: "250"
  }
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth();

  const room = `SMOKE${Date.now()}`;
  const fireboy = await connectClient(room);
  const watergirl = await connectClient(room);

  fireboy.send({ type: "claim_role", role: "fireboy" });
  watergirl.send({ type: "claim_role", role: "watergirl" });
  await waitFor(() => fireboy.state.players.length === 2 && watergirl.state.players.length === 2, 10_000);

  fireboy.send({ type: "ready", ready: true });
  watergirl.send({ type: "ready", ready: true });
  await waitFor(() => fireboy.state.phase === "playing" && watergirl.state.phase === "playing", 10_000);
  await waitFor(() => fireboy.frames > 0 && watergirl.frames > 0, 10_000);

  fireboy.ws.close();
  watergirl.ws.close();
  console.log(`Host smoke passed for ${room}`);
} finally {
  stopServer();
}

async function connectClient(room) {
  const state = { players: [], phase: "lobby" };
  const client = {
    frames: 0,
    state,
    ws: new WebSocket("ws://127.0.0.1:8080/ws"),
    send(payload) {
      this.ws.send(JSON.stringify(payload));
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out.")), 10_000);
    client.ws.addEventListener("open", () => {
      clearTimeout(timer);
      client.send({ type: "join_room", room });
      resolve();
    });
    client.ws.addEventListener("error", () => reject(new Error("WebSocket failed.")));
  });

  client.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "room_state") {
      state.players = message.players;
      state.phase = message.phase;
    }
    if (message.type === "frame") {
      client.frames += 1;
    }
  });

  return client;
}

async function waitForHealth() {
  await waitFor(async () => {
    try {
      const response = await fetch("http://127.0.0.1:8080/health");
      return response.ok;
    } catch {
      return false;
    }
  }, 45_000, () => {
    throw new Error(`Host server did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });
}

async function waitFor(predicate, timeoutMs, onTimeout) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (onTimeout) {
    onTimeout();
  }

  throw new Error("Timed out waiting for host smoke condition.");
}

function stopServer() {
  if (!server.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
      stdio: "ignore"
    });
    return;
  }

  server.kill("SIGTERM");
}
