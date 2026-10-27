import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { S3Client } from '@aws-sdk/client-s3';
import type { WsServerEvent } from '@thechat/shared';
import { S3ObjectStore } from '../attachments/s3-object-store';
import { contextFromTraceContext, setTracerForTests, withSpan } from '../observability';
import { db } from '../db';
import { enqueueDomainEvent } from './outbox';
import { getQueueClient, QUEUES } from '../async/queue';
import { consumeDomainJob } from './runtime';
import { DomainEventRegistry } from './registry';
import { parseDomainEventEnvelope, type DomainEventEnvelope } from './envelope';
import { deliverWebSocketEvent } from '../ws/delivery';
const exporter=new InMemorySpanExporter();
const provider=new NodeTracerProvider({spanProcessors:[new SimpleSpanProcessor(exporter)]});
beforeAll(()=>{provider.register();setTracerForTests(provider.getTracer('queue-test'));});
afterEach(()=>exporter.reset());
afterAll(async()=>{setTracerForTests(null);await provider.shutdown();});
const event=():DomainEventEnvelope=>({id:crypto.randomUUID(),type:QUEUES.chat,version:1,aggregate:{type:'test',id:crypto.randomUUID()},occurredAt:new Date().toISOString(),payload:{}});
function span(name:string){const spans=exporter.getFinishedSpans().filter(s=>s.name===name);expect(spans.length).toBe(1);return spans[0];}
async function persisted() {
 const data=event();await withSpan('test.request',{},()=>db.transaction(tx=>enqueueDomainEvent(tx,data,{partitionKey:data.id})));
 const boss=await getQueueClient();const [job]=await boss.findJobs<DomainEventEnvelope>(QUEUES.chat,{id:data.id});
 await boss.deleteJob(QUEUES.chat,data.id);await provider.forceFlush();
 return {...job,signal:new AbortController().signal};
}

test('persists producer causal context and keeps consumer span open until effect settles',async()=>{
 const job=await persisted();const producer=span('domain_event.enqueue');
 expect(producer.kind).toBe(SpanKind.PRODUCER);expect(producer.parentSpanContext?.spanId).toBe(span('test.request').spanContext().spanId);
 expect(job.data.traceContext?.traceparent).toContain(producer.spanContext().spanId);
 expect(producer.attributes['thechat.queue.outcome']).toBe('staged');
 exporter.reset();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started=false;
 const registry=new DomainEventRegistry().register({type:job.data.type,version:1,parse:parseDomainEventEnvelope,async handle(){started=true;await gate;}});
 const work=consumeDomainJob(job,registry);while(!started)await Bun.sleep(1);
 expect(exporter.getFinishedSpans().filter(s=>s.name==='domain_event.consume')).toHaveLength(0);
 release();expect((await work)[0].status).toBe('completed');
 const consumer=span('domain_event.consume');expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);expect(consumer.kind).toBe(SpanKind.CONSUMER);
});

test('retry attempts are siblings and exceptions redact sensitive URLs and file names',async()=>{
 const job=await persisted();const producer=span('domain_event.enqueue');exporter.reset();
 const registry=new DomainEventRegistry().register({type:job.data.type,version:1,parse:parseDomainEventEnvelope,async handle(){throw Error('https://signed.invalid/?token=do-not-export filename=private.txt');}});
 for(const retryCount of [0,1])expect((await consumeDomainJob({...job,retryCount},registry))[0].status).toBe('failed');
 const consumers=exporter.getFinishedSpans().filter(s=>s.name==='domain_event.consume');expect(consumers).toHaveLength(2);
 for(const s of consumers){expect(s.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);expect(s.status.code).toBe(SpanStatusCode.ERROR);}
 expect(exporter.getFinishedSpans().reduce((n,s)=>n+s.events.length,0)).toBe(2);
 expect(JSON.stringify(exporter.getFinishedSpans().map(s=>({attributes:s.attributes,events:s.events,status:s.status})))).not.toMatch(/signed.invalid|do-not-export|private.txt/);
});

test('nested storage failures retain one sanitized leaf exception and all causal hops',async()=>{
 const job=await persisted();const producer=span('domain_event.enqueue');exporter.reset();
 const store=new S3ObjectStore({bucket:'test',region:'eu-central-1',client:{send:async()=>{throw Error('https://signed.invalid/?token=do-not-export filename=private.txt');}} as unknown as S3Client});
 const registry=new DomainEventRegistry().register({type:job.data.type,version:1,parse:parseDomainEventEnvelope,async handle(){await withSpan('attachment.validate_promote',{},()=>store.headObject({key:'synthetic',versionId:'1'}),{errorAttributes:{'thechat.attachment.outcome':'failed'}});}});
 expect((await consumeDomainJob(job,registry))[0].status).toBe('failed');
 const consumer=span('domain_event.consume'),handler=span('domain_event.handle'),attachment=span('attachment.validate_promote'),storage=span('attachment.s3.head');
 expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);expect(handler.parentSpanContext?.spanId).toBe(consumer.spanContext().spanId);expect(attachment.parentSpanContext?.spanId).toBe(handler.spanContext().spanId);expect(storage.parentSpanContext?.spanId).toBe(attachment.spanContext().spanId);
 for(const s of [consumer,handler,attachment,storage])expect(s.status.code).toBe(SpanStatusCode.ERROR);
 expect(handler.attributes['thechat.event.outcome']).toBe('failed');expect(attachment.attributes['thechat.attachment.outcome']).toBe('failed');expect(storage.attributes['thechat.storage.outcome']).toBe('failed');
 expect(storage.events).toHaveLength(1);expect([consumer,handler,attachment].flatMap(s=>s.events)).toHaveLength(0);
 expect(JSON.stringify([consumer,handler,attachment,storage].map(s=>({attributes:s.attributes,events:s.events,status:s.status})))).not.toMatch(/signed.invalid|do-not-export|private.txt/);
});

test('malformed envelopes are terminal, sanitized and cannot poison their key forever',async()=>{
 for(const data of [null,{}, {aggregate:null}]) {
  exporter.reset();const result=await consumeDomainJob({id:crypto.randomUUID(),name:QUEUES.chat,data,retryCount:0,signal:new AbortController().signal},new DomainEventRegistry());
  expect(result[0].status).toBe('deadletter');expect(span('domain_event.consume').status.code).toBe(SpanStatusCode.ERROR);
  expect(JSON.stringify(exporter.getFinishedSpans().map(s=>s.events))).not.toMatch(/postgres|password|token|payload/i);
 }
});

test('WebSocket producer carrier reaches the desktop hop without sensitive telemetry',async()=>{
 const outbound:string[]=[];
 await withSpan('realtime.receive',{},async()=>{
  const delivered=await deliverWebSocketEvent({type:'new_message',message:{id:crypto.randomUUID(),conversationId:crypto.randomUUID(),content:'safe'},conversationType:'channel'} as unknown as WsServerEvent,[{send:data=>outbound.push(data)}]);expect(delivered.sent).toBe(1);
  await withSpan('realtime.message.receive',{},()=>undefined,{kind:SpanKind.CONSUMER,parentContext:contextFromTraceContext(JSON.parse(outbound[0]).traceContext)});
 });
 const producer=span('realtime.websocket.send'),consumer=span('realtime.message.receive');expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);expect(producer.attributes['realtime.delivery.outcome']).toBe('delivered');
});
