import type { SuggestionOptions } from "@tiptap/suggestion";
import { MentionList, type MentionUser } from "./MentionList";
import { rankMentionCandidates } from "./mention-ranking";
import { suggestionPopup } from "./suggestion-popup";

export function createMentionSuggestion(
  getMentions: () => MentionUser[]
): Omit<SuggestionOptions<MentionUser>, "editor"> {
  return {
    char: "@",
    items: ({ query }) => rankMentionCandidates(getMentions(), query),
    render: suggestionPopup(MentionList, (props) => props),
  };
}
