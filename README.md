# Fireboy & Watergirl Online

A two-player online wrapper for the original Flash SWF using Ruffle, Vite, and Supabase Realtime.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in:

   ```bash
   VITE_SUPABASE_URL=
   VITE_SUPABASE_PUBLISHABLE_KEY=
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open two browser windows to the same room URL and choose different roles.

## Multiplayer Model

- Room URLs use `/?room=ABC123`.
- Supabase Broadcast carries input events.
- Supabase Presence carries role, ready, and connection state.
- The SWF remains closed-source, so both browsers run local Ruffle instances and receive the same input stream.

If Ruffle/browser synthetic keyboard events stop being accepted in a future Ruffle build, the fallback is to rebuild the game in a modern engine with authoritative networked state.

## Vercel

Set these environment variables in Vercel:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Build command: `npm run build`

Output directory: `dist`
