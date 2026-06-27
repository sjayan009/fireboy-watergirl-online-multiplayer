const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function getOrCreatePlayerId(): string {
  return crypto.randomUUID();
}

export function getInitialRoom(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = normalizeRoom(params.get("room"));
  if (fromUrl) {
    return fromUrl;
  }

  const room = createRoomCode();
  params.set("room", room);
  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  return room;
}

export function createRoomCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

export function normalizeRoom(room: string | null): string | null {
  if (!room) {
    return null;
  }

  const normalized = room.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  return normalized.length >= 4 ? normalized : null;
}

export function roomUrl(room: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("room", room);
  return url.toString();
}
