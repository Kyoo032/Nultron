import { SHELL_LAYOUT } from "@agentforge/core/product-modes";
import { useSearchParams } from "@/lib/nav";
import { AgentChatPane } from "@/components/agent-chat-pane";
import { ChatSession } from "@/components/chat-session";
import { agentIdFromSearch } from "@/lib/virtual-agents";

export function ChatPage() {
  const params = useSearchParams();
  const thread = params.get("thread") ?? undefined;
  if (SHELL_LAYOUT === "chat-first") {
    // Tester code: `/chat` is every virtual agent's address. `?agent=<mode>` names one; none is the generalist.
    return <AgentChatPane agentMode={agentIdFromSearch(params)} threadId={thread} />;
  }
  // Every Chat session lives in the left rail since 2026-09-17, so the pane owns the whole width.
  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ChatSession initialThreadId={thread} />
      </div>
    </div>
  );
}
