import type { UiRound } from "../../../lib/chat/messages/uiMessages";

import { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";
import { RoundContent } from "./assistant-bubble/RoundContent";

export { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";
export { CompactingText, VibingText } from "./assistant-bubble/StatusText";

export function AssistantBubble(props: {
  rounds: (UiRound & {
    runningToolCallIds?: string[];
    thinkingOpen?: boolean;
  })[];
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
}) {
  const { rounds, showUsage, usageContextWindow, isLive, toolStatus, toolStatusVariant } = props;
  const showLabels = rounds.length > 1;

  return (
    <div className="flex w-full max-w-full items-start gap-3">
      <AssistantAvatar />
      <div className="min-w-0 flex-1 space-y-3 pt-0.5">
        {rounds.map((round, idx) => (
          <RoundContent
            key={round.key}
            round={round}
            showLabel={showLabels}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            isLive={isLive}
            isActive={isLive && idx === rounds.length - 1}
            toolStatus={idx === rounds.length - 1 ? toolStatus : null}
            toolStatusVariant={idx === rounds.length - 1 ? toolStatusVariant : "default"}
            runningToolCallIds={round.runningToolCallIds ?? []}
            thinkingOpen={round.thinkingOpen}
          />
        ))}
      </div>
    </div>
  );
}
