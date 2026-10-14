/**
 * The board's event bus (team-board-spec.md section 8.4). It carries ids only, never content: a
 * subscriber reads the `card_events` row itself and re-checks access for its own viewer.
 *
 * `InProcessBoardBus` is the one process K0 runs as. `PostgresBoardBus` (LISTEN/NOTIFY) replaces it
 * when the database moves (P1); nothing above this interface changes.
 */
export interface BoardBus {
  publish(tenantId: string, workspaceId: string, eventId: number): void;
  subscribe(tenantId: string, workspaceId: string, onEvent: (eventId: number) => void): () => void;
}

type Listener = (eventId: number) => void;

export class InProcessBoardBus implements BoardBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(tenantId: string, workspaceId: string, eventId: number): void {
    for (const listener of [...(this.listeners.get(channel(tenantId, workspaceId)) ?? [])]) {
      listener(eventId);
    }
  }

  subscribe(tenantId: string, workspaceId: string, onEvent: Listener): () => void {
    const key = channel(tenantId, workspaceId);
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(onEvent);
    this.listeners.set(key, set);
    return () => {
      set.delete(onEvent);
      if (set.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  /** How many subscribers a desk has. Tests read it to prove a closed stream left nothing behind. */
  listenerCount(tenantId: string, workspaceId: string): number {
    return this.listeners.get(channel(tenantId, workspaceId))?.size ?? 0;
  }
}

function channel(tenantId: string, workspaceId: string): string {
  return `${tenantId}\u0000${workspaceId}`;
}

const processBus = new InProcessBoardBus();

export function boardBus(): InProcessBoardBus {
  return processBus;
}
