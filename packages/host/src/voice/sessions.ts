/**
 * Voice sessions live in this process. One open session per person: a newer one ends the older
 * with `replaced`. The process cap is the hosted box's guard. Timers use the injected clock.
 */
import { randomBytes } from "node:crypto";
import type { TenantContext } from "@agentforge/core";
import { VOICE_LIMITS, type VoiceEndReason, type VoiceMode } from "@agentforge/core/voice";
import type { VoiceClock } from "./clock";
import { recordVoiceSeconds } from "./metering";
import type { Talker, Transcriber } from "./talker";
import type { VoiceLocale } from "./turns";
import { voiceWiring } from "./wiring";

export type VoiceLive = {
  shutdown(reason: VoiceEndReason): void;
};

export type VoiceSession = {
  readonly id: string;
  readonly tenant: TenantContext;
  readonly threadId: string;
  readonly locale: VoiceLocale;
  readonly model: string;
  readonly talker: Talker;
  readonly transcriber: Transcriber;
  /** What the transcriber's seconds are recorded under; the talker's `model` is what the session's are. */
  readonly transcriberModel: string;
  mode: VoiceMode;
  readonly createdAt: number;
  readonly endsAt: number;
  endedReason: VoiceEndReason | null;
  endedAt: number | null;
  minutes: number;
  attached: boolean;
  live: VoiceLive | null;
  /** Set once the seconds row is written, so a second end does not write another. */
  metered: boolean;
};

export type OpenVoiceSession = {
  readonly tenant: TenantContext;
  readonly threadId: string;
  readonly mode: VoiceMode;
  readonly locale: VoiceLocale;
  readonly model: string;
  readonly talker: Talker;
  readonly transcriber: Transcriber;
  readonly transcriberModel: string;
};

function ownerKey(tenant: Pick<TenantContext, "tenantId" | "organizationId" | "userId">): string {
  return `${tenant.tenantId}\0${tenant.organizationId}\0${tenant.userId}`;
}

export function sameVoiceOwner(session: VoiceSession, tenant: TenantContext): boolean {
  return (
    session.tenant.tenantId === tenant.tenantId &&
    session.tenant.organizationId === tenant.organizationId &&
    session.tenant.workspaceId === tenant.workspaceId &&
    session.tenant.userId === tenant.userId
  );
}

/** 128 bits, URL-safe, inside `VOICE_STREAM_PATH_PATTERN`. */
export function mintVoiceSessionId(): string {
  return randomBytes(16).toString("base64url");
}

function minutesBetween(start: number, end: number): number {
  const minutes = Math.max(0, end - start) / 60_000;
  return Math.round(minutes * 1000) / 1000;
}

class SessionRegistry {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly cancels = new Map<string, () => void>();
  private clock: VoiceClock;

  constructor(clock: VoiceClock) {
    this.clock = clock;
  }

  /** New timers read whatever clock the wiring has now. */
  private useClock(): VoiceClock {
    this.clock = voiceWiring().clock;
    return this.clock;
  }

  /** True when a new person would pass `maxOpenPerProcess`. Replacing one's own session does not. */
  atCap(tenant: TenantContext): boolean {
    const open = this.openSessions();
    if (open.length < VOICE_LIMITS.maxOpenPerProcess) return false;
    const key = ownerKey(tenant);
    return !open.some((session) => ownerKey(session.tenant) === key);
  }

  open(input: OpenVoiceSession): { ok: true; session: VoiceSession; replacedId: string | null } | { ok: false } {
    const clock = this.useClock();
    if (this.atCap(input.tenant)) return { ok: false };
    const key = ownerKey(input.tenant);
    let replacedId: string | null = null;
    for (const existing of this.openSessions()) {
      if (ownerKey(existing.tenant) !== key) continue;
      this.end(existing.id, "replaced");
      replacedId = existing.id;
    }
    const createdAt = clock.now();
    const session: VoiceSession = {
      id: mintVoiceSessionId(),
      tenant: input.tenant,
      threadId: input.threadId,
      locale: input.locale,
      model: input.model,
      talker: input.talker,
      transcriber: input.transcriber,
      transcriberModel: input.transcriberModel,
      mode: input.mode,
      createdAt,
      endsAt: createdAt + VOICE_LIMITS.maxSessionMs,
      endedReason: null,
      endedAt: null,
      minutes: 0,
      attached: false,
      live: null,
      metered: false,
    };
    this.sessions.set(session.id, session);
    const connect = clock.after(VOICE_LIMITS.connectMs, () => {
      if (!session.attached && !session.endedReason) this.end(session.id, "dropped");
    });
    const max = clock.after(VOICE_LIMITS.maxSessionMs, () => {
      if (!session.endedReason) this.end(session.id, "max_length");
    });
    this.cancels.set(session.id, () => {
      connect();
      max();
    });
    return { ok: true, session, replacedId };
  }

  get(id: string): VoiceSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** Bind the socket. False when the session is gone, ended, or already has one. */
  attach(id: string, live: VoiceLive): boolean {
    const session = this.sessions.get(id);
    if (!session || session.endedReason || session.attached) return false;
    session.attached = true;
    session.live = live;
    return true;
  }

  /**
   * End the session. A second call for the same id returns the minutes already recorded.
   * Unknown ids return null. The owner check is the caller's.
   */
  end(id: string, reason: VoiceEndReason): { minutes: number } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.endedReason) return { minutes: session.minutes };
    const endedAt = this.useClock().now();
    session.endedReason = reason;
    session.endedAt = endedAt;
    session.minutes = minutesBetween(session.createdAt, endedAt);
    this.cancels.get(id)?.();
    this.cancels.delete(id);
    const live = session.live;
    session.live = null;
    if (live) {
      try {
        live.shutdown(reason);
      } catch {
        this.meter(session);
      }
    } else {
      this.meter(session);
    }
    return { minutes: session.minutes };
  }

  /** The relay calls this from `shutdown` so a connected session is metered once. */
  meter(session: VoiceSession): void {
    if (session.metered) return;
    session.metered = true;
    const end = session.endedAt ?? this.useClock().now();
    const seconds = Math.max(0, end - session.createdAt) / 1000;
    recordVoiceSeconds(session.tenant, session.model, seconds);
  }

  openCount(): number {
    return this.openSessions().length;
  }

  private openSessions(): VoiceSession[] {
    return [...this.sessions.values()].filter((session) => !session.endedReason);
  }

  reset(): void {
    for (const id of [...this.sessions.keys()]) {
      const session = this.sessions.get(id);
      if (session && !session.endedReason) this.end(id, "dropped");
    }
    this.sessions.clear();
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
  }
}

let registry: SessionRegistry | null = null;

export function voiceSessions(): SessionRegistry {
  if (!registry) registry = new SessionRegistry(voiceWiring().clock);
  return registry;
}

export function resetVoiceSessionsForTests(): void {
  registry?.reset();
  registry = null;
}
