import type { Role } from "./types";

export const roleKeys: Record<Role, string[]> = {
  fireboy: ["ArrowLeft", "ArrowUp", "ArrowRight"],
  watergirl: ["KeyA", "KeyW", "KeyD"]
};

export const roleLabels: Record<Role, string> = {
  fireboy: "Fireboy",
  watergirl: "Watergirl"
};

export const keyLabels: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowUp: "Up",
  ArrowRight: "Right",
  KeyA: "A",
  KeyW: "W",
  KeyD: "D"
};

export function roleForKey(code: string): Role | null {
  if (roleKeys.fireboy.includes(code)) {
    return "fireboy";
  }

  if (roleKeys.watergirl.includes(code)) {
    return "watergirl";
  }

  return null;
}

export function keyboardInitFor(code: string): KeyboardEventInit {
  const keyByCode: Record<string, string> = {
    ArrowLeft: "ArrowLeft",
    ArrowUp: "ArrowUp",
    ArrowRight: "ArrowRight",
    KeyA: "a",
    KeyW: "w",
    KeyD: "d"
  };

  return {
    key: keyByCode[code] ?? code,
    code,
    bubbles: true,
    cancelable: true,
    composed: true
  };
}
