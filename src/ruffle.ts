import { keyboardInitFor } from "./keys";

type RuffleWindow = Window &
  typeof globalThis & {
    RufflePlayer?: {
      newest: () => {
        createPlayer: () => HTMLElement & {
          load?: (source: string | { url: string }) => Promise<void> | void;
          ruffle?: () => {
            load: (source: string | { url: string }) => Promise<void> | void;
          };
          play?: () => void;
        };
      };
      config?: Record<string, unknown>;
    };
  };

const RUFFLE_SCRIPT = "/ruffle/ruffle.js";

export class RuffleHost {
  private player: HTMLElement | null = null;

  constructor(private readonly mount: HTMLElement) {}

  async load(): Promise<void> {
    await ensureRuffle();
    this.mount.replaceChildren();

    const ruffle = (window as RuffleWindow).RufflePlayer?.newest();
    if (!ruffle) {
      throw new Error("Ruffle did not initialize.");
    }

    const player = ruffle.createPlayer();
    player.id = "ruffle-player";
    player.style.width = "100%";
    player.style.height = "100%";
    player.tabIndex = 0;
    this.mount.append(player);
    if (player.ruffle) {
      await player.ruffle().load("/game.swf");
    } else if (player.load) {
      await player.load({ url: "/game.swf" });
    } else {
      throw new Error("This Ruffle build does not expose a load API.");
    }

    this.player = player;
    this.focus();
  }

  focus(): void {
    this.player?.focus();
  }

  reload(): void {
    void this.load();
  }

  inject(code: string, action: "down" | "up"): void {
    const type = action === "down" ? "keydown" : "keyup";
    const init = keyboardInitFor(code);
    const event = new KeyboardEvent(type, init);

    this.player?.dispatchEvent(event);
    this.mount.dispatchEvent(new KeyboardEvent(type, init));
    document.dispatchEvent(new KeyboardEvent(type, init));
    window.dispatchEvent(new KeyboardEvent(type, init));
  }
}

async function ensureRuffle(): Promise<void> {
  const currentWindow = window as RuffleWindow;
  if (currentWindow.RufflePlayer) {
    return;
  }

  currentWindow.RufflePlayer = currentWindow.RufflePlayer ?? ({} as RuffleWindow["RufflePlayer"]);
  currentWindow.RufflePlayer!.config = {
    autoplay: "on",
    unmuteOverlay: "hidden",
    warnOnUnsupportedContent: false,
    letterbox: "on"
  };

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = RUFFLE_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Ruffle from the CDN."));
    document.head.append(script);
  });
}
