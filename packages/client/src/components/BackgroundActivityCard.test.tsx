import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundActivityPublic } from "@thechat/shared";
import { HermesRuntimePanel } from "./HermesRuntimePanel";
import { BackgroundActivityCard } from "./BackgroundActivityCard";
import userEvent from "@testing-library/user-event";
vi.mock("../hooks/useScopedCommands", () => ({ useScopedCommands: () => {} }));
vi.mock("./ResponsiveShell", () => ({ useMediaQuery: () => false }));
afterEach(cleanup);
it("does not label an unknown owner as working in the background", () => {
 const t=task();t.parent.state="unknown";t.workers[0].state="unknown";t.canStop=false;
 render(<BackgroundActivityCard task={t}/>);
 expect(screen.getByRole("heading",{name:"Status unknown"})).toBeInTheDocument();
 expect(screen.queryByRole("heading",{name:"Working in background"})).not.toBeInTheDocument();
});
it("retains the immutable task handle on its rendered card for precise task selection", () => {
 const t = task({taskId:crypto.randomUUID()});
 render(<BackgroundActivityCard task={t}/>);
 expect(screen.getByTestId("background-activity-card")).toHaveAttribute("data-activity-task-id",t.taskId);
});
it.each([false,undefined])("does not offer task Stop for a legacy owner capability %s", canStop => {
 render(<HermesRuntimePanel botName="Hermes" runtime={{invocations:[],events:[],activity:[task({canStop})]}} loading={false} onStopBackground={vi.fn()}/>);
 expect(screen.getByText("Waiting for worker")).toBeVisible();
 expect(screen.queryByRole("button",{name:"Stop task"})).not.toBeInTheDocument();
});
export function task(overrides: Partial<BackgroundActivityPublic> = {}): BackgroundActivityPublic {
 const now = new Date().toISOString();
 return { botId:"bot", botUserId:"bot-user", botName:"Hermes", conversationId:"conversation", threadId:null, canStop:true, taskId:"task", sessionId:"owner-session", sequence:1, originInvocationId:"completed-invocation", observedAt:now, parent:{state:"waiting_worker",action:null,updatedAt:now}, workers:[{id:"child",kind:"subagent",parentId:null,goal:"Inspect the checkout",state:"running",action:"read_file",startedAt:now,updatedAt:now,lastActionAt:now}], activities:[{id:"quiet",workerId:"child",toolName:"terminal",state:"running",startedAt:now,finishedAt:null}], ...overrides };
}
it("shows durable background workers after the parent invocation ends", () => {
 render(<HermesRuntimePanel botName="Hermes" runtime={{invocations:[],events:[],activity:[task()]}} loading={false}/>);
 expect(screen.getByText("Working in background")).toBeInTheDocument();
 expect(screen.getByText("Waiting for worker")).toBeInTheDocument();
 expect(screen.getByText("Inspect the checkout")).toBeInTheDocument();
 expect(screen.getByText("read_file")).toBeInTheDocument();
 expect(screen.queryByText("No active runs")).not.toBeInTheDocument();
});
it("forwards the selected task to the authenticated stop callback without changing its state", async () => {
 const t = task(); const onStopBackground = vi.fn().mockResolvedValue(undefined);
 render(<HermesRuntimePanel botName="Hermes" runtime={{invocations:[],events:[],activity:[t]}} loading={false} onStopBackground={onStopBackground}/>);
 await userEvent.click(screen.getByRole("button",{name:"Stop task"}));
 expect(onStopBackground).toHaveBeenCalledWith(t);
 expect(screen.getByText("Stop requested")).toBeVisible();
});
it("shows activity on the owning task row after its message invocation finishes", () => {
 const now = new Date().toISOString();
 const threads = [{id:"other-thread",conversationId:"conversation",botId:"bot",title:"Other task",status:"active",createdAt:now,updatedAt:now,lastActivityAt:now}] as any;
 render(<HermesRuntimePanel botName="Hermes" runtime={{invocations:[],events:[],activity:[task({threadId:"other-thread"})]}} threads={threads} loading={false}/>);
 expect(screen.getByRole("button",{name:/Other task/})).toHaveTextContent("1");
 expect(screen.queryByText("Inspect the checkout")).not.toBeInTheDocument();
});
it("does not expose another thread's worker details in the selected scope", () => {
 render(<HermesRuntimePanel botName="Hermes" runtime={{invocations:[],events:[],activity:[task({threadId:"other-thread"})]}} loading={false}/>);
 expect(screen.queryByText("Inspect the checkout")).not.toBeInTheDocument();
 expect(screen.queryByTestId("background-activity-card")).not.toBeInTheDocument();
});
it("labels task-wide stop as requested until the owner reports stopped", async () => {
 const t = task(); const onStop = vi.fn().mockResolvedValue(undefined);
 const {rerender} = render(<BackgroundActivityCard task={t} onStop={onStop}/>);
 await userEvent.click(screen.getByRole("button", {name:"Stop task"}));
 expect(onStop).toHaveBeenCalledWith(t);
 expect(screen.getByText("Stop requested")).toBeInTheDocument();
 expect(screen.queryByRole("heading", {name:"Stopped"})).not.toBeInTheDocument();
 expect(screen.getByRole("button", {name:"Stop requested"})).toBeDisabled();
 rerender(<BackgroundActivityCard task={{...t,sequence:2,parent:{...t.parent,state:"stopped"}}} onStop={onStop}/>);
 expect(screen.getByRole("heading", {name:"Stopped"})).toBeInTheDocument();
 expect(screen.queryByRole("button", {name:"Stop task"})).not.toBeInTheDocument();
});
it("shows connection loss instead of claiming progress after a stale heartbeat", () => {
 const old = new Date(Date.now() - 120_000).toISOString();
 render(<BackgroundActivityCard task={task({observedAt:old})}/>);
 expect(screen.getByText("Status unknown / connection lost")).toBeInTheDocument();
 expect(screen.getByText("Inspect the checkout")).toBeInTheDocument();
});
it("keeps completed child results in parent verification with a keyboard-accessible quiet tool timeline", async () => {
 const now = new Date().toISOString();
 const t = task({parent:{state:"verifying",action:"Inspect test results",updatedAt:now}});
 t.workers[0].state = "finished";
 render(<BackgroundActivityCard task={t}/>);
 expect(screen.getByText("Verifying results")).toBeInTheDocument();
 expect(screen.queryByText("Finished")).not.toBeInTheDocument();
 const disclosure = screen.getByRole("button", {name:"Recent activity"});
 expect(disclosure).toHaveAttribute("aria-expanded", "false");
 disclosure.focus(); await userEvent.keyboard("{Enter}");
 expect(disclosure).toHaveAttribute("aria-expanded", "true");
 expect(screen.getByText("terminal · running")).toBeInTheDocument();
});
