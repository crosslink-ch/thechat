/**
 * Integration test: full workspace chat flow between two users.
 *
 * Steps tested:
 *  1. Register User A and User B
 *  2. User A creates a workspace
 *  3. User A invites User B to the workspace
 *  4. User B accepts the invitation
 *  5. Both users open the "general" channel (render ChannelChatView)
 *  6. User A sends a message (types in textarea + presses Enter)
 *  7. User B receives the message via WebSocket and sees it in the DOM
 *
 * Requires:
 *  - API server running on port 3000 (with PostgreSQL)
 *
 * Run:
 *   pnpm test:integration
 *   # or:
 *   INTEGRATION=true pnpm test:desktop -- src/hooks/workspace-chat-flow.integration.test.tsx
 */
import { describe, test, expect, afterAll } from "vitest";
import {
  render,
  within,
  waitFor,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { treaty } from "@elysiajs/eden";
import type { App } from "@thechat/api";
import {
  forwardRef,
  useImperativeHandle,
  type Ref,
} from "react";
import { useChannelChat } from "./useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import type { ChatMessage } from "@thechat/shared";
import WS from "ws";

const INTEGRATION = process.env.INTEGRATION === "true";

const API_URL = "http://localhost:3000";
const WS_URL = "ws://localhost:3000";

const api = treaty<App>(API_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

let emailCounter = 0;
function uniqueEmail() {
  return `flow-${Date.now()}-${++emailCounter}@test.com`;
}

/**
 * Unwrap an Eden Treaty response, throwing on error.
 * Eliminates `(data as any)` casts throughout the test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(result: { data: any; error: unknown }): any {
  if (result.error)
    throw new Error(`API error: ${JSON.stringify(result.error)}`);
  return result.data;
}

const createdEmails: string[] = [];
let createdWorkspaceId: string | undefined;

// ---------------------------------------------------------------------------
// WebSocket helpers (same pattern as useChannelChat.integration.test.ts)
// ---------------------------------------------------------------------------

function connectWs(token: string): Promise<WS> {
  return new Promise((resolve, reject) => {
    const ws = new WS(`${WS_URL}/ws`);
    const timeout = setTimeout(
      () => reject(new Error("WebSocket connection timeout")),
      5000,
    );

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    });
    ws.on("message", function handler(data) {
      const raw = typeof data === "string" ? data : data.toString();
      const event = JSON.parse(raw);
      if (event.type === "auth_ok") {
        clearTimeout(timeout);
        ws.removeListener("message", handler);
        resolve(ws);
      } else if (event.type === "auth_error") {
        clearTimeout(timeout);
        reject(new Error("WebSocket auth failed"));
      }
    });
    ws.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    });
  });
}

function onWsMessage(ws: WS, callback: (event: any) => void) {
  ws.on("message", (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    const event = JSON.parse(raw);
    callback(event);
  });
}

// ---------------------------------------------------------------------------
// Test wrapper: renders ChannelChatView powered by useChannelChat
// ---------------------------------------------------------------------------

interface TestChannelViewHandle {
  addMessage: (msg: ChatMessage) => void;
}

const TestChannelView = forwardRef(function TestChannelView(
  props: {
    conversationId: string;
    token: string;
    wsSendMessage: (conversationId: string, content: string) => void;
  },
  ref: Ref<TestChannelViewHandle>,
) {
  const chat = useChannelChat(props);

  useImperativeHandle(ref, () => ({ addMessage: chat.addMessage }));

  return (
    <ChannelChatView
      messages={chat.messages}
      loading={chat.loading}
      typingUsers={new Map()}
      onSend={chat.sendMessage}
    />
  );
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (!INTEGRATION) return;
  const { cleanupWorkspace, cleanupUserByEmail } = await import(
    "@thechat/api/test-helpers"
  );

  if (createdWorkspaceId) {
    await cleanupWorkspace(createdWorkspaceId);
  }
  for (const email of createdEmails) {
    await cleanupUserByEmail(email);
  }
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {};

describe.skipIf(!INTEGRATION)(
  "Workspace chat flow: invite, join, message (rendered)",
  () => {
    let userA: {
      token: string;
      user: { id: string; name: string; email: string | null };
    };
    let userB: {
      token: string;
      user: { id: string; name: string; email: string | null };
    };
    let workspaceId: string;
    let generalChannelId: string;

    // -- Fixture setup (API calls) ------------------------------------------

    test("1. Register User A and User B", async () => {
      const emailA = uniqueEmail();
      const emailB = uniqueEmail();
      createdEmails.push(emailA, emailB);

      const dataA = unwrap(
        await api.auth.register.post({
          name: "Alice",
          email: emailA,
          password: "password123",
        }),
      );
      expect(dataA.accessToken).toBeTruthy();
      expect(dataA.user!.name).toBe("Alice");
      userA = { token: dataA.accessToken!, user: dataA.user! };

      const dataB = unwrap(
        await api.auth.register.post({
          name: "Bob",
          email: emailB,
          password: "password123",
        }),
      );
      expect(dataB.accessToken).toBeTruthy();
      expect(dataB.user!.name).toBe("Bob");
      userB = { token: dataB.accessToken!, user: dataB.user! };
    });

    test("2. User A creates a workspace", async () => {
      const data = unwrap(
        await api.workspaces.create.post(
          { name: "Flow Test Workspace" },
          auth(userA.token),
        ),
      );
      expect(data.id).toBeTruthy();
      expect(data.name).toBe("Flow Test Workspace");

      workspaceId = data.id;
      createdWorkspaceId = workspaceId;
    });

    test("3. User A invites User B to the workspace", async () => {
      const data = unwrap(
        await api.invites.create.post(
          { workspaceId, email: userB.user.email! },
          auth(userA.token),
        ),
      );
      expect(data.id).toBeTruthy();
      expect(data.workspaceId).toBe(workspaceId);
    });

    test("4. User B accepts the invitation", async () => {
      const pending = unwrap(
        await api.invites.pending.get(auth(userB.token)),
      );

      const invite = (pending as any[]).find(
        (i: any) => i.workspaceId === workspaceId,
      );
      expect(invite).toBeDefined();

      const data = unwrap(
        await api.invites.accept.post(
          { inviteId: invite.id },
          auth(userB.token),
        ),
      );
      expect(data.success).toBe(true);

      // Verify membership
      const workspaces = unwrap(
        await api.workspaces.list.get(auth(userB.token)),
      );
      const membership = (workspaces as any[]).find(
        (w: any) => w.id === workspaceId,
      );
      expect(membership).toBeDefined();
    });

    // -- Discover the general channel ----------------------------------------

    test("5. Discover the general channel", async () => {
      const data = unwrap(
        await api.workspaces({ id: workspaceId }).get(auth(userA.token)),
      );
      const channels = data.channels;
      const general = channels.find(
        (c: { name: string }) => c.name === "general",
      );
      expect(general).toBeDefined();
      generalChannelId = general!.id;
    });

    // -- Render phase: components + DOM assertions ----------------------------

    test("6. Both users open the channel and see the empty state", async () => {
      const refA = { current: null as TestChannelViewHandle | null };
      const refB = { current: null as TestChannelViewHandle | null };

      const wsSendA = (_convId: string, _content: string) => {};
      const wsSendB = (_convId: string, _content: string) => {};

      const viewA = render(
        <TestChannelView
          ref={refA}
          conversationId={generalChannelId}
          token={userA.token}
          wsSendMessage={wsSendA}
        />,
      );

      const viewB = render(
        <TestChannelView
          ref={refB}
          conversationId={generalChannelId}
          token={userB.token}
          wsSendMessage={wsSendB}
        />,
      );

      // Both should show the empty state after loading
      await waitFor(() => {
        expect(
          within(viewA.container).getByText(/no messages yet/i),
        ).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(
          within(viewB.container).getByText(/no messages yet/i),
        ).toBeInTheDocument();
      });

      viewA.unmount();
      viewB.unmount();
    });

    test("7. User A sends a message and User B sees it in the DOM", async () => {
      const wsA = await connectWs(userA.token);
      const wsB = await connectWs(userB.token);

      try {
        const refA = { current: null as TestChannelViewHandle | null };
        const refB = { current: null as TestChannelViewHandle | null };

        // Wire wsSendMessage for User A to actually send via WebSocket
        const wsSendA = (convId: string, content: string) => {
          wsA.send(
            JSON.stringify({
              type: "send_message",
              conversationId: convId,
              content,
            }),
          );
        };

        const viewA = render(
          <TestChannelView
            ref={refA}
            conversationId={generalChannelId}
            token={userA.token}
            wsSendMessage={wsSendA}
          />,
        );

        const viewB = render(
          <TestChannelView
            ref={refB}
            conversationId={generalChannelId}
            token={userB.token}
            wsSendMessage={() => {}}
          />,
        );

        // Wait for both views to finish loading
        await waitFor(() => {
          expect(
            within(viewA.container).queryByText(/loading messages/i),
          ).not.toBeInTheDocument();
        });
        await waitFor(() => {
          expect(
            within(viewB.container).queryByText(/loading messages/i),
          ).not.toBeInTheDocument();
        });

        // Wire User B's WebSocket → addMessage so incoming messages render
        onWsMessage(wsB, (event) => {
          if (
            event.type === "new_message" &&
            event.message.conversationId === generalChannelId &&
            refB.current
          ) {
            act(() => refB.current!.addMessage(event.message));
          }
        });

        // Also wire User A's WebSocket so they see their own message
        onWsMessage(wsA, (event) => {
          if (
            event.type === "new_message" &&
            event.message.conversationId === generalChannelId &&
            refA.current
          ) {
            act(() => refA.current!.addMessage(event.message));
          }
        });

        // User A types a message and presses Enter
        const user = userEvent.setup();
        const textareaA = within(viewA.container).getByPlaceholderText(
          /send a message/i,
        );
        await user.click(textareaA);
        await user.type(textareaA, "Hello from Alice!");
        await user.keyboard("{Enter}");

        // User A sees their own message in the DOM
        await waitFor(() => {
          expect(
            within(viewA.container).getByText("Hello from Alice!"),
          ).toBeInTheDocument();
        });

        // User B sees Alice's message in the DOM
        await waitFor(() => {
          expect(
            within(viewB.container).getByText("Hello from Alice!"),
          ).toBeInTheDocument();
        });

        // Verify sender name is visible in User B's view
        expect(
          within(viewB.container).getByText("Alice"),
        ).toBeInTheDocument();

        viewA.unmount();
        viewB.unmount();
      } finally {
        wsA.close();
        wsB.close();
      }
    });
  },
);
