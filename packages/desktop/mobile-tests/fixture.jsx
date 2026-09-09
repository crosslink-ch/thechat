import { AppViewport } from "../src/components/AppViewport";
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, useRouterState } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ResponsiveShell, NavigationToggle } from '../src/components/ResponsiveShell';
import { Sidebar } from '../src/components/Sidebar';
import { ChatHeader } from '../src/components/ChatHeader';
import { InputBar } from '../src/components/InputBar';
import { SharedChatMessage } from '../src/components/SharedChatMessage';
import { Markdown } from '../src/components/Markdown';
import { HermesRuntimePanel } from '../src/components/HermesRuntimePanel';
import { HermesProgressInline } from '../src/components/HermesProgressInline';
import { WorkspaceModal, openWorkspaceModal } from '../src/components/WorkspaceModal';
import { useAuthStore } from '../src/stores/auth';
import { useWorkspacesStore } from '../src/stores/workspaces';
import './fixture.css';

// Synthetic store state only. No API, auth, WebSocket or bot execution in this fixture.
useAuthStore.setState({ user: {id:'fixture-user', name:'Mobile tester', email:'fixture@example.test'}, token: null, loading: false });
const workspace = {id:'fixture', name:'Day-one mobile workspace', channels:[{id:'general',name:'general'}, {id:'long',name:'a-very-long-channel-name-with-no-natural-short-label'}], members:[{userId:'fixture-user',role:'owner',user:{id:'fixture-user',name:'Mobile tester',type:'human'}}]};
useWorkspacesStore.setState({activeWorkspace:workspace,workspaces:[workspace]});
const invocation = {id:'fixture-run',botId:'bot',botUserId:'bot-user',botName:'Hermes fixture',botKind:'hermes',conversationId:'fixture-dm',threadId:null,triggerMessageId:'trigger',adapterKind:'hermes',status:'running',createdAt:'2026-09-07T08:00:00Z',updatedAt:'2026-09-07T08:00:00Z'};
const event = {invocationId:'fixture-run',botId:'bot',conversationId:'fixture-dm',threadId:null,status:'waiting',createdAt:'2026-09-07T08:00:00Z',occurredAt:'2026-09-07T08:00:00Z'};
const events = [
 {...event,id:'approval',sequence:1,type:'approval.request',payload:{requestId:'approve-fixture',sessionKey:'fixture-session',command:'This is only a synthetic approval UI fixture',description:'Please review the proposed action before approving.',choices:['once','session','deny']}},
 {...event,id:'clarify',sequence:2,type:'clarify.request',payload:{requestId:'clarify-fixture',sessionKey:'fixture-session',question:'Which approach should the mobile rollout use?',choices:['Careful verification of all important user journeys','Fast'],allowOther:true,multiSelect:false}}
];
function Fixture() {
  const key = useRouterState({select:s=>s.location.href});
  const [thread,setThread] = useState(null);
  const [sent,setSent] = useState('');
  const [interaction,setInteraction] = useState('');
  const [reactions,setReactions] = useState([]);
  const content='This is a synthetic component fixture, not end-to-end.\n\n'+'long-unbroken-content-'.repeat(12)+'\n\n```ts\n'+ 'const longCode = "'+'x'.repeat(160)+'";\n```';
  return <AppViewport className="fixture-frame relative flex h-screen flex-col bg-base">
    <ResponsiveShell navigation={<Sidebar/>} routeKey={key}>
      <ChatHeader/>
      <div className="shared-dm-layout flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="fixture-messages min-h-0 flex-1 overflow-y-auto">
            <button onClick={openWorkspaceModal}>Open workspace dialog</button>
            <p data-testid="thread-selection">{thread ?? 'General'}</p>
            <SharedChatMessage message={{id:'fixture-message', senderId:'fixture-user', senderName:'Long sender name '.repeat(5),senderType:'human',content,createdAt:'2026-09-07T08:00:00Z',reactions}} onSetReaction={(_id,emoji,active)=>setReactions(active?[{emoji,count:1,reactedByMe:true,userNames:['Mobile tester']}]:[])}><Markdown content={content}/></SharedChatMessage>
            <HermesProgressInline invocations={[{invocation,events}]} onInteraction={(event,response)=>setInteraction(event.id+':'+response)}/>
            <output data-testid="interaction">{interaction}</output>
            <output data-testid="sent">{sent}</output>
          </div>
          <InputBar convId={undefined} draftKey="fixture" onSend={text=>{setSent(text);return true;}} onStop={()=>{}}/>
        </div>
        <HermesRuntimePanel botName="Hermes fixture" runtime={null} loading={false} threads={[{id:'task-one',title:'Plan the mobile rollout with a very long thread title',lastActivityAt:'2026-09-07T08:00:00Z',createdAt:'2026-09-07T08:00:00Z',updatedAt:'2026-09-07T08:00:00Z'}]} activeThreadId={thread} onSelectThread={setThread} onCreateThread={()=>setThread('New task')}/>
      </div>
    </ResponsiveShell>
    <WorkspaceModal/>
  </AppViewport>;
}
const rootRoute=createRootRoute({component:Fixture});
const route=createRoute({getParentRoute:()=>rootRoute,path:'/channel/$id'});
const router=createRouter({routeTree:rootRoute.addChildren([route]), history:createMemoryHistory({initialEntries:['/channel/general']})});
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router}/></QueryClientProvider>);
