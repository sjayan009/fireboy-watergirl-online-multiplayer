# Fireboy & Watergirl Online

A true remote co-op wrapper for the original Flash SWF.

The public Vercel site is only the viewer/controller. The actual game runs once in a persistent cloud host service, where a Playwright/Chromium page loads the SWF through Ruffle. Both players connect to that one hosted game session, watch the same frame stream, and send controls for their chosen character.

## Architecture

- Frontend: Vite + TypeScript, deployed on Vercel.
- Game host: Node + Playwright + WebSocket, intended for Fly.io.
- One room creates one server-side Chromium page.
- v1 runs as a single Fly machine because room state and Chromium pages are in memory.
- The Fly machine is configured with 2 GB RAM so Chromium/Ruffle cold starts have breathing room.
- Fireboy controls: ArrowLeft / ArrowUp / ArrowRight.
- Watergirl controls: A / W / D.
- Pointer events on the streamed game view are forwarded to the hosted game so players can click the in-game menu.

## Local Setup

Install frontend dependencies:

```bash
npm install
```

Install host dependencies:

```bash
npm install --prefix server
```

Copy `.env.example` to `.env` for production-style config, or use this for local development:

```bash
VITE_GAME_SERVER_URL=ws://127.0.0.1:8080
```

Run the host service:

```bash
npm run server:dev
```

Run the frontend in another terminal:

```bash
npm run dev
```

Open the same room URL from two browsers/devices.

## Verification

Frontend build:

```bash
npm run build
```

Host TypeScript build:

```bash
npm run server:build
```

End-to-end host smoke test:

```bash
npm run smoke:host
```

## Deployment

Deploy the host service to Fly.io from the repo root:

```bash
fly launch --copy-config
fly deploy
```

Set the Vercel frontend env var:

```bash
VITE_GAME_SERVER_URL=wss://fireboy-watergirl-game-host.fly.dev
```

Then redeploy Vercel.
