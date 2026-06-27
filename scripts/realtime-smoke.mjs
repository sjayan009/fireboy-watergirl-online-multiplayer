import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

loadDotEnv();

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.");
}

const room = `smoke-${Date.now()}`;
const topic = `fw-room:${room}`;
const playerA = crypto.randomUUID();
const playerB = crypto.randomUUID();

const clientA = createClient(url, key);
const clientB = createClient(url, key);
const channelA = clientA.channel(topic, {
  config: { presence: { key: playerA }, broadcast: { self: false, ack: true } }
});
const channelB = clientB.channel(topic, {
  config: { presence: { key: playerB }, broadcast: { self: false, ack: true } }
});

let broadcastReceived = false;

channelA.on("presence", { event: "sync" }, () => {});
channelB.on("presence", { event: "sync" }, () => {});
channelB.on("broadcast", { event: "game" }, ({ payload }) => {
  broadcastReceived = payload?.type === "input" && payload?.code === "ArrowRight";
});

await Promise.all([subscribe(channelA), subscribe(channelB)]);

await channelA.track(presence(playerA, "fireboy"));
await channelB.track(presence(playerB, "watergirl"));

await waitFor(() => countPresence(channelA) >= 2 && countPresence(channelB) >= 2, 8000);

const sendStatus = await channelA.send({
  type: "broadcast",
  event: "game",
  payload: {
    type: "input",
    playerId: playerA,
    role: "fireboy",
    code: "ArrowRight",
    action: "down",
    seq: 1,
    sentAt: Date.now()
  }
});

if (sendStatus !== "ok") {
  throw new Error(`Broadcast send failed: ${sendStatus}`);
}

await waitFor(() => broadcastReceived, 8000);

await Promise.all([channelA.unsubscribe(), channelB.unsubscribe()]);
await Promise.all([clientA.realtime.disconnect(), clientB.realtime.disconnect()]);

console.log(`Realtime smoke passed for ${topic}`);

function presence(playerId, role) {
  return {
    playerId,
    name: "Smoke",
    role,
    ready: false,
    startedAt: null,
    onlineAt: new Date().toISOString()
  };
}

function countPresence(channel) {
  return Object.values(channel.presenceState()).reduce((total, presences) => total + presences.length, 0);
}

function subscribe(channel) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime subscribe timed out.")), 10000);
    channel.subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      }

      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        reject(error ?? new Error(`Realtime subscribe failed: ${status}`));
      }
    });
  });
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for Realtime smoke condition.");
}

function loadDotEnv() {
  if (!fs.existsSync(".env")) {
    return;
  }

  const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) {
      continue;
    }

    process.env[match[1]] = match[2];
  }
}
