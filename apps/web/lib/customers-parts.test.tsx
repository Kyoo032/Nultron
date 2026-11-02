/**
 * The Customers page's drawing, through its parts: what the owner sees for a connected and an
 * unconnected desk, an open and a closed reply window, a failed send, and a hostile customer name.
 * Fetching and polling are the page's and are checked live against the sandbox.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectCard, ConversationList, ThreadPane, TodayStrip } from "@/components/customers-parts";
import type { CustomerConversation, CustomerMessage, InboxSummary, WhatsAppConnection } from "./customers-client";
import { applyLocale, resetLocaleForTests } from "./i18n";

const NOW = new Date(2026, 10, 2, 15, 30, 0).getTime();
const HOUR = 60 * 60 * 1000;

const CONNECTED: WhatsAppConnection = {
  connected: true,
  webhookReady: true,
  phoneNumberId: "105550000000001",
  displayPhone: "+62 812-0000-0001",
  verifiedName: "Sandbox Coffee",
  connectedAt: NOW - HOUR,
  fingerprint: "sha256:ab12cd34",
  pinnedOrigin: true,
};

const SUMMARY: InboxSummary = {
  needsYou: 2,
  withYou: 1,
  closed: 4,
  unread: 3,
  receivedToday: 9,
  sentToday: 5,
  medianFirstReplySeconds: 240,
};

function conversation(over: Partial<CustomerConversation> = {}): CustomerConversation {
  return {
    id: "conv_1",
    kind: "whatsapp",
    contactId: "6281200000001",
    contactName: "Dewi",
    state: "needs_you",
    unreadCount: 2,
    lastMessageAt: NOW - 5 * 60 * 1000,
    lastMessagePreview: "Ada kopi?",
    lastMessageDirection: "in",
    lastInboundAt: NOW - 5 * 60 * 1000,
    window: { open: true, closesAt: NOW + 23 * HOUR },
    createdAt: NOW - 2 * HOUR,
    ...over,
  };
}

function message(over: Partial<CustomerMessage> = {}): CustomerMessage {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    direction: "in",
    sentBy: "customer",
    kind: "text",
    text: "Ada kopi?",
    delivery: null,
    deliveryError: null,
    at: NOW - 5 * 60 * 1000,
    ...over,
  };
}

function thread(over: Partial<Parameters<typeof ThreadPane>[0]> = {}): string {
  return renderToStaticMarkup(
    <ThreadPane
      conversation={conversation()}
      messages={[message()]}
      now={NOW}
      draft=""
      busy={false}
      canSend
      onDraft={() => undefined}
      onSend={() => undefined}
      onState={() => undefined}
      {...over}
    />,
  );
}

beforeEach(() => {
  resetLocaleForTests();
});

describe("Today strip", () => {
  it("shows the counts and the typical first reply", () => {
    const html = renderToStaticMarkup(<TodayStrip summary={SUMMARY} />);
    expect(html).toContain('data-testid="customers-stat-needs-you"');
    expect(html).toContain('data-hot="true"');
    expect(html).toContain("4 min");
    expect(html).toContain("Received today");
  });

  it("draws dashes before the host has answered, and says so when nobody has been answered yet", () => {
    expect(renderToStaticMarkup(<TodayStrip summary={null} />)).toContain("–");
    const none = renderToStaticMarkup(<TodayStrip summary={{ ...SUMMARY, medianFirstReplySeconds: null }} />);
    expect(none).toContain("No replies yet");
  });
});

describe("Connect card", () => {
  const noop = () => undefined;

  it("asks for the number id and the token, with the token hidden", () => {
    const html = renderToStaticMarkup(
      <ConnectCard connection={{ ...CONNECTED, connected: false }} busy={false} onConnect={noop} onDisconnect={noop} />,
    );
    expect(html).toContain('data-testid="customers-phone-number-id"');
    expect(html).toMatch(/type="password"[^>]*data-testid="customers-access-token"|data-testid="customers-access-token"[^>]*type="password"/);
    expect(html).not.toContain('data-testid="customers-disconnect"');
  });

  it("shows the connected number and a fingerprint, never a token", () => {
    const html = renderToStaticMarkup(
      <ConnectCard connection={CONNECTED} busy={false} onConnect={noop} onDisconnect={noop} />,
    );
    expect(html).toContain("Connected: +62 812-0000-0001");
    expect(html).toContain("Sandbox Coffee");
    expect(html).toContain("sha256:ab12cd34");
    expect(html).not.toContain('data-testid="customers-access-token"');
  });

  it("shows why a connect failed, inside the card", () => {
    const html = renderToStaticMarkup(
      <ConnectCard
        connection={{ ...CONNECTED, connected: false }}
        busy={false}
        error="WhatsApp did not accept that number and token."
        onConnect={noop}
        onDisconnect={noop}
      />,
    );
    expect(html).toContain('data-testid="customers-connect-error"');
    expect(html).toContain("did not accept that number");
  });

  it("lists the callback path Meta must be given", () => {
    const html = renderToStaticMarkup(
      <ConnectCard connection={CONNECTED} busy={false} onConnect={noop} onDisconnect={noop} />,
    );
    expect(html).toContain("/api/v1/channels/whatsapp/webhook");
  });

  it("warns when the server cannot take Meta's calls yet, and when it is pointed at a mock", () => {
    const html = renderToStaticMarkup(
      <ConnectCard
        connection={{ ...CONNECTED, webhookReady: false, pinnedOrigin: false }}
        busy={false}
        onConnect={noop}
        onDisconnect={noop}
      />,
    );
    expect(html).toContain('data-testid="customers-not-ready"');
    expect(html).toContain('data-testid="customers-sandbox-note"');
    const clean = renderToStaticMarkup(
      <ConnectCard connection={CONNECTED} busy={false} onConnect={noop} onDisconnect={noop} />,
    );
    expect(clean).not.toContain("customers-not-ready");
    expect(clean).not.toContain("customers-sandbox-note");
  });
});

describe("Conversation list", () => {
  function list(conversations: CustomerConversation[], over: Partial<Parameters<typeof ConversationList>[0]> = {}) {
    return renderToStaticMarkup(
      <ConversationList
        conversations={conversations}
        selectedId={null}
        filter="all"
        query=""
        now={NOW}
        onFilter={() => undefined}
        onQuery={() => undefined}
        onSelect={() => undefined}
        {...over}
      />,
    );
  }

  it("shows the name, the preview and the unread badge, and prefixes the owner's own last line", () => {
    const html = list([
      conversation(),
      conversation({ id: "conv_2", contactName: "", contactId: "6281200000002", unreadCount: 0, lastMessageDirection: "out", lastMessagePreview: "On our way" }),
    ]);
    expect(html).toContain("Dewi");
    expect(html).toContain("2 new");
    expect(html).toContain("+6281200000002");
    expect(html).toContain("You: On our way");
  });

  it("says nothing matches when a filter or search is on, and explains the empty inbox otherwise", () => {
    expect(list([], { filter: "closed" })).toContain("Nothing matches that.");
    expect(list([], { query: "zzz" })).toContain("Nothing matches that.");
    expect(list([])).toContain("Messages your customers send to the connected number appear here.");
  });

  it("marks the open conversation and the active filter", () => {
    const html = list([conversation()], { selectedId: "conv_1", filter: "needs_you" });
    expect(html).toContain('data-on="true"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="customers-filter-needs_you"/);
  });
});

describe("Thread", () => {
  it("asks the owner to pick a conversation when none is open", () => {
    expect(thread({ conversation: null, messages: [] })).toContain("Pick a conversation to read it.");
  });

  it("lets the owner reply while the window is open, and shows the time left", () => {
    const html = thread();
    expect(html).toContain("You can reply freely for 23 h 0 min more.");
    expect(html).toContain('data-window="open"');
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it("shows only minutes in the last hour", () => {
    const html = thread({ conversation: conversation({ window: { open: true, closesAt: NOW + 20 * 60 * 1000 } }) });
    expect(html).toContain("You can reply freely for 20 min more.");
  });

  it("explains a closed window and turns the composer off", () => {
    const html = thread({ conversation: conversation({ window: { open: false, closesAt: NOW - HOUR } }) });
    expect(html).toContain('data-window="closed"');
    expect(html).toContain("The 24-hour window has closed.");
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="customers-send"/);
  });

  it("lets a desk with no connected number read but not reply", () => {
    const html = thread({ canSend: false });
    expect(html).toContain('data-testid="customers-needs-number"');
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });

  it("shows delivery under the owner's replies and the reason a send failed", () => {
    const html = thread({
      messages: [
        message(),
        message({ id: "msg_2", direction: "out", sentBy: "owner", text: "Ada", delivery: "read" }),
        message({ id: "msg_3", direction: "out", sentBy: "owner", text: "Lagi", delivery: "failed", deliveryError: "Message undeliverable" }),
      ],
    });
    expect(html).toContain("Read");
    expect(html).toContain("Not delivered");
    expect(html).toContain("Message undeliverable");
  });

  it("shows why a reply failed, above the composer", () => {
    const html = thread({ error: "The 24-hour window has closed, so a free-form reply cannot be sent." });
    expect(html).toContain('role="alert"');
    expect(html.indexOf("customers-error")).toBeLessThan(html.indexOf("customers-composer"));
    expect(thread()).not.toContain("customers-error");
  });

  it("offers Reopen on a finished conversation and Mark done on a live one", () => {
    expect(thread()).toContain("Mark done");
    expect(thread({ conversation: conversation({ state: "closed" }) })).toContain("Reopen");
  });

  it("renders a hostile name and message as text, never as markup", () => {
    const html = thread({
      conversation: conversation({ contactName: '<img src=x onerror="alert(1)">' }),
      messages: [message({ text: "<script>alert(1)</script>" })],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    expect(thread()).toContain("Anda bisa membalas bebas selama 23 jam 0 menit lagi.");
  });
});
