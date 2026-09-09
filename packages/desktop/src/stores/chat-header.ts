import { useEffect } from "react";
import { create } from "zustand";

type DmHeaderIdentity = {
  conversationId: string;
  userId: string | null;
  token: string | null;
  title: string;
  context?: string;
};

export const useDmHeaderStore = create(() => ({
  identity: null as DmHeaderIdentity | null,
}));

/** The route owns this identity; an old cleanup must not clear a newer route. */
export function useDmHeaderIdentity({ conversationId, userId, token, title, context }: DmHeaderIdentity) {
  useEffect(() => {
    const identity = { conversationId, userId, token, title, context };
    useDmHeaderStore.setState({ identity });
    return () => {
      if (useDmHeaderStore.getState().identity === identity) {
        useDmHeaderStore.setState({ identity: null });
      }
    };
  }, [conversationId, userId, token, title, context]);
}
