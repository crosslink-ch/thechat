import { AppViewport } from "@thechat/client/components/AppViewport";
import { createRoot } from 'react-dom/client';
import React, { useMemo, useState } from 'react';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, useRouterState } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResponsiveShell, NavigationToggle } from '@thechat/client/components/ResponsiveShell';
import { Sidebar } from '@thechat/client/components/Sidebar';
import { ChatHeader } from '@thechat/client/components/ChatHeader';
import { InputBar } from '@thechat/client/components/InputBar';
import { SharedChatMessage } from '@thechat/client/components/SharedChatMessage';
import { Markdown } from '@thechat/client/components/Markdown';
import { HermesRuntimePanel } from '@thechat/client/components/HermesRuntimePanel';
import { HermesProgressInline } from '@thechat/client/components/HermesProgressInline';
import { WorkspaceModal, openWorkspaceModal } from '@thechat/client/components/WorkspaceModal';
import { BotRequestTimelineItems, useBotRequestTimeline } from '@thechat/client/components/BotRequestTimeline';
import { BotRequestAnswererContext, useBotRequestsStore } from '@thechat/client/stores/bot-requests';
import { messageText } from '@thechat/client/lib/composer-parts';
import { useAuthStore } from '@thechat/client/stores/auth';
import { useWorkspacesStore } from '@thechat/client/stores/workspaces';
import './fixture.css';

// Synthetic store state only. No API, auth, WebSocket or bot execution in this fixture.
useAuthStore.setState({ user: {id:'fixture-user', name:'Mobile tester', email:'fixture@example.test'}, token: null, loading: false });
const workspace = {id:'fixture', name:'Day-one mobile workspace', channels:[{id:'general',name:'general'}, {id:'long',name:'a-very-long-channel-name-with-no-natural-short-label'}], members:[{userId:'fixture-user',role:'owner',user:{id:'fixture-user',name:'Mobile tester',type:'human'}}]};
useWorkspacesStore.setState({activeWorkspace:workspace,workspaces:[workspace]});
const invocation = {id:'fixture-run',botId:'bot',botUserId:'bot-user',botName:'Hermes fixture',botKind:'hermes',conversationId:'fixture-dm',threadId:null,triggerMessageId:'trigger',adapterKind:'hermes',status:'running',createdAt:'2026-09-07T08:00:00Z',updatedAt:'2026-09-07T08:00:00Z'};
// Approvals and questions are bot request rows; their cards render from the
// request timeline, not from progress events.
const asked = {botId:'bot',botUserId:'bot-user',botName:'Hermes fixture',botAvatar:null,conversationId:'fixture-dm',conversationType:'direct',conversationName:null,workspaceId:null,threadId:null,threadTitle:null,invocationId:'fixture-run',orderGroup:null,audienceUserId:null,status:'open',answer:null,answeredBy:null,answeredAt:null,deliveredAt:null,deliveryApplied:null,deliveryNote:null,cancelReason:null,expiresAt:null,createdAt:'2026-09-07T08:00:01Z',updatedAt:'2026-09-07T08:00:01Z'};
for (const request of [
 {...asked,id:'approve-fixture',kind:'approval',title:'This is only a synthetic approval UI fixture',body:'Please review the proposed action before approving.',details:{command:'echo synthetic'},response:{type:'choice',choices:['once','session','deny']}},
 {...asked,id:'clarify-fixture',kind:'question',title:'Which approach should the mobile rollout use?',body:null,details:null,response:{type:'choice',choices:['Careful verification of all important user journeys','Fast'],allowText:true},createdAt:'2026-09-07T08:00:02Z',updatedAt:'2026-09-07T08:00:02Z'},
]) useBotRequestsStore.getState().upsert(request);
function RequestArea() {
  const timeline = useBotRequestTimeline({scope:{conversationId:'fixture-dm',threadId:null},messages:[]});
  return <BotRequestTimelineItems requests={timeline.trailing} blocked={timeline.blocked}/>;
}
function Fixture() {
  const key = useRouterState({select:s=>s.location.href});
  const [thread,setThread] = useState(null);
  const [sent,setSent] = useState('');
  const [interaction,setInteraction] = useState('');
  const [reactions,setReactions] = useState([]);
  // Local answerer: records the answer and stores the row as answered, as the API would.
  const answerer = useMemo(() => ({local:true, answer: async (requestId, answer) => {
    const request = useBotRequestsStore.getState().byId[requestId];
    setInteraction(request.kind+':'+(answer.choice ?? answer.text));
    const answered = {...request,status:'answered',answer,answeredBy:{id:'fixture-user',name:'Mobile tester'},answeredAt:new Date().toISOString()};
    useBotRequestsStore.getState().upsert(answered);
    return answered;
  }}), []);
  const content='This is a synthetic component fixture, not end-to-end.\n\n'+'long-unbroken-content-'.repeat(12)+'\n\n```ts\n'+ 'const longCode = "'+'x'.repeat(160)+'";\n```';
  return <BotRequestAnswererContext.Provider value={answerer}><AppViewport className="fixture-frame relative flex h-screen flex-col bg-base">
    <ResponsiveShell navigation={<Sidebar/>} routeKey={key}>
      <ChatHeader/>
      <div className="shared-dm-layout flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="fixture-messages min-h-0 flex-1 overflow-y-auto">
            <button onClick={openWorkspaceModal}>Open workspace dialog</button>
            <p data-testid="thread-selection">{thread ?? 'General'}</p>
            <SharedChatMessage message={{id:'fixture-message', senderId:'fixture-user', senderName:'Long sender name '.repeat(5),senderType:'human',content,createdAt:'2026-09-07T08:00:00Z',reactions}} onSetReaction={(_id,emoji,active)=>setReactions(active?[{emoji,count:1,reactedByMe:true,userNames:['Mobile tester']}]:[])}><Markdown content={content}/></SharedChatMessage>
            <HermesProgressInline invocations={[{invocation,events:[]}]}/>
            <RequestArea/>
            <output data-testid="interaction">{interaction}</output>
            <output data-testid="sent">{sent}</output>
          </div>
          <InputBar convId={undefined} draftKey="fixture" onSend={message=>{setSent(messageText(message));return true;}} onStop={()=>{}}/>
        </div>
        <HermesRuntimePanel botName="Hermes fixture" runtime={null} loading={false} threads={[{id:'task-one',title:'Plan the mobile rollout with a very long thread title',lastActivityAt:'2026-09-07T08:00:00Z',createdAt:'2026-09-07T08:00:00Z',updatedAt:'2026-09-07T08:00:00Z'}]} activeThreadId={thread} onSelectThread={setThread} onCreateThread={()=>setThread('New task')}/>
      </div>
    </ResponsiveShell>
    <WorkspaceModal/>
  </AppViewport></BotRequestAnswererContext.Provider>;
}
const rootRoute=createRootRoute({component:Fixture});
const route=createRoute({getParentRoute:()=>rootRoute,path:'/channel/$id'});
const router=createRouter({routeTree:rootRoute.addChildren([route]), history:createMemoryHistory({initialEntries:['/channel/general']})});
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router}/></QueryClientProvider>);
