export type Role = "fireboy" | "watergirl";

export type ConnectionState =
  | "offline"
  | "connecting"
  | "connected"
  | "degraded";

export type PlayerPresence = {
  playerId: string;
  name: string;
  role: Role | null;
  ready: boolean;
  startedAt: number | null;
  onlineAt: string;
};

export type InputPayload = {
  type: "input";
  playerId: string;
  role: Role;
  code: string;
  action: "down" | "up";
  seq: number;
  sentAt: number;
};

export type RolePayload = {
  type: "role";
  playerId: string;
  role: Role | null;
  seq: number;
};

export type ReadyPayload = {
  type: "ready";
  playerId: string;
  ready: boolean;
  seq: number;
};

export type StartPayload = {
  type: "start";
  playerId: string;
  startsAt: number;
  seq: number;
};

export type ResetPayload = {
  type: "reset";
  playerId: string;
  startsAt: number | null;
  seq: number;
};

export type PingPayload = {
  type: "ping";
  playerId: string;
  sentAt: number;
  seq: number;
};

export type PongPayload = {
  type: "pong";
  playerId: string;
  to: string;
  sentAt: number;
  receivedAt: number;
  seq: number;
};

export type GameEvent =
  | InputPayload
  | RolePayload
  | ReadyPayload
  | StartPayload
  | ResetPayload
  | PingPayload
  | PongPayload;
