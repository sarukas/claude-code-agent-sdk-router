import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createGateway } from '../../src/core/server';
import { AnthropicTransformer } from '../../src/core/transformers/anthropic';
import { OpenRouterTransformer } from '../../src/core/transformers/openrouter';

const model = 'google/gemini-3.8-flash';
const provider: any = {name:'openrouter', api_key:'offline', api_base_url:'http://unused.invalid'};
const details = [
  {type:'reasoning.text', text:'synthetic summary', signature:null, id:'r1', index:0, format:'google-gemini-v1'},
  {type:'reasoning.encrypted', data:'OPAQUE+/==', id:'call_a', index:1, format:'google-gemini-v1'},
  {type:'reasoning.encrypted', data:'SECOND==', id:'call_b', index:2, format:'google-gemini-v1'},
];
const call = {index:0,id:'call_a',type:'function',function:{name:'lookup',arguments:'{}'}};
function jsonResponse(value: any) { return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}}); }
function chunk(delta: any, finish_reason: string | null = null) {return {id:'g1',model,choices:[{index:0,delta,finish_reason}]};}
function sseResponse(chunks: any[]) {
  // Deliberately fragment across JSON and UTF-8 boundaries and omit final newline.
  const bytes = new TextEncoder().encode(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]');
  let offset=0;
  return new Response(new ReadableStream({pull(c){if(offset===bytes.length)return c.close();c.enqueue(bytes.slice(offset,offset+=Math.min(7,bytes.length-offset)));}}),{headers:{'Content-Type':'text/event-stream'}});
}
function assistantFromSse(text: string) {
  let model: string | undefined;
  const blocks:any[]=[];const open = new Set<number>();
  for(const line of text.split('\n')) {
    if(!line.startsWith('data: {'))continue;
    const e=JSON.parse(line.slice(6));
    if(e.type==='message_start')model=e.message.model;
    if(e.type==='content_block_start'){assert.equal(open.size,0,'content blocks must be sequential');open.add(e.index);blocks[e.index]=e.content_block;}
    if(e.type==='content_block_delta'){
      assert(open.has(e.index),'delta must target an open block');const b=blocks[e.index];const d=e.delta;
      if(d.type==='text_delta')b.text+=d.text;
      if(d.type==='thinking_delta')b.thinking+=d.thinking;
      if(d.type==='signature_delta')b.signature=(b.signature||'')+d.signature;
      if(d.type==='input_json_delta')b.raw=(b.raw||'')+d.partial_json;
    }
    if(e.type==='content_block_stop'){assert(open.delete(e.index),'block must close exactly once');}
  }
  assert.equal(open.size,0);
  return {role:'assistant',model,content:blocks.map(b=>{if(b.raw){b.input=JSON.parse(b.raw);delete b.raw;}return b;})};
}
async function roundTrip(upstream:Response, stream:boolean) {
  const router=new OpenRouterTransformer();
  await router.transformRequestIn({model,messages:[]},provider);
  const converted=await new AnthropicTransformer().transformResponseIn(await router.transformResponseOut(upstream));
  const assistant=stream?assistantFromSse(await converted.text()):await converted.json();
  // No transformer state survives: emulate SDK serialization and a router restart.
  const persisted=JSON.parse(JSON.stringify(assistant));
  const unified=await new AnthropicTransformer().transformRequestOut({model,messages:[persisted]});
  const {body}=await new OpenRouterTransformer().transformRequestIn(unified,provider);
  return {assistant:persisted, message:body.messages[0]};
}

test('mandatory Gemini 3.8 reasoning overrides disabled/none; optional models unchanged',async()=>{
  for(const reasoning of [{enabled:false,effort:'high'},{enabled:true,effort:'none'},{enabled:false,max_tokens:0}]) {
    const {body}=await new OpenRouterTransformer().transformRequestIn({model,messages:[],reasoning} as any,provider);
    assert.equal(body.reasoning.enabled,true);assert.notEqual(body.reasoning.effort,'none');assert.notEqual(body.reasoning.max_tokens,0);
  }
  for(const optional of ['google/gemini-2.5-flash','anthropic/claude-sonnet-4.6','openai/gpt-4.1']) {
    const {body}=await new OpenRouterTransformer().transformRequestIn({model:optional,messages:[],reasoning:{enabled:false,effort:'none'}},provider);
    assert.deepEqual(body.reasoning,{enabled:false,effort:'none'});
  }
});

test('non-streaming encrypted reasoning survives serialization and a fresh transformer',async()=>{
  const {message,assistant}=await roundTrip(jsonResponse({id:'g1',model,choices:[{message:{role:'assistant',content:'answer',reasoning:'summary',reasoning_details:details,tool_calls:[call]},finish_reason:'tool_calls'}]}),false);
  assert.deepEqual(message.reasoning_details,details);assert.equal(message.reasoning,'summary');assert.equal(message.tool_calls[0].id,'call_a');
  // An envelope for one model must not be replayed as another model's signature.
  const other=await new AnthropicTransformer().transformRequestOut({model:'google/gemini-2.5-flash',messages:[assistant]});
  assert.equal((other.messages[0] as any).reasoning_details,undefined);
});

test('streaming preserves ordered detail chunks, late metadata, tool and text deltas',async()=>{
  const {message,assistant}=await roundTrip(sseResponse([
    chunk({reasoning:'sum',reasoning_details:[details[0]],content:'café '}),
    chunk({reasoning:'mary',tool_calls:[call],reasoning_details:[details[1]]}),
    chunk({reasoning_details:[details[2]]},'tool_calls'),
    {id:'g1',model,choices:[],usage:{prompt_tokens:10,completion_tokens:5}},
  ]),true);
  assert.equal(assistant.content[0].type,'redacted_thinking');assert.equal(assistant.content.at(-1).type,'tool_use');
  assert.deepEqual(message.reasoning_details,details);assert.equal(message.reasoning,'summary');assert.equal(message.content,'café ');assert.equal(message.tool_calls[0].function.name,'lookup');
});

test('reasoning-only and encrypted-only responses survive with no text or tool',async()=>{
  for(const delta of [{reasoning_details:[details[1]]},{reasoning:'summary'}]) {
    const {message}=await roundTrip(sseResponse([chunk(delta,'stop')]),true);
    if('reasoning_details' in delta)assert.deepEqual(message.reasoning_details,delta.reasoning_details);
    else assert.equal(message.reasoning,'summary');
  }
});

for(const stream of [false,true])test(`HTTP concurrent sessions restore their own tool names (stream=${stream})`,{timeout:10000},async()=>{
  const pending:Array<{body:any,res:any}>=[];
  const upstream=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    pending.push({body:JSON.parse(raw),res});
    if(pending.length!==2)return;
    for(const p of [...pending].reverse()) {
      const tool={...call,function:{name:p.body.tools[0].function.name,arguments:'{}'}};
      if(stream){p.res.writeHead(200,{'Content-Type':'text/event-stream'});p.res.end('data: '+JSON.stringify(chunk({tool_calls:[tool]},'tool_calls'))+'\n\ndata: [DONE]\n\n');}
      else {p.res.writeHead(200,{'Content-Type':'application/json'});p.res.end(JSON.stringify({id:'g1',model,choices:[{message:{tool_calls:[tool]},finish_reason:'tool_calls'}]}));}
    }
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const port=(upstream.address() as any).port;
  const gateway=await createGateway({providers:{openrouter:'offline'},providerUrls:{openrouter:`http://127.0.0.1:${port}`},logToConsole:false});
  try {
    const names=['mcp__alpha__lookup','mcp__beta__lookup'];
    const responses=await Promise.all(names.map(async name=>{
      const r=await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'openrouter,'+model,stream,max_tokens:50,messages:[{role:'user',content:'test'}],tools:[{name,input_schema:{type:'object',properties:{}}}]})});
      assert.equal(r.status,200);return stream?assistantFromSse(await r.text()):await r.json();
    }));
    for(let i=0;i<names.length;i++){assert.equal(responses[i].model,'openrouter,'+model);assert.equal(responses[i].content.find((x:any)=>x.type==='tool_use').name,names[i]);}
  } finally {await gateway.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});


test('SDK-compatible ordering leaves a text final result and keeps numeric tool IDs',async()=>{
  const numeric={...call,id:'123'};
  const opaque={...details[1],id:'123'};
  const {message,assistant}=await roundTrip(sseResponse([
    chunk({tool_calls:[{...numeric,function:{name:'lookup',arguments:'{'}}],reasoning_details:[opaque]}),
    chunk({tool_calls:[{index:0,function:{arguments:'}'}}]}),
    chunk({content:'FINAL'}),chunk({reasoning_details:[details[2]]},'stop'),
  ]),true);
  assert.equal(assistant.content[0].type,'redacted_thinking');
  assert.deepEqual(assistant.content.at(-1),{type:'text',text:'FINAL'});
  assert.equal(message.tool_calls[0].id,'123');
  assert.equal(message.reasoning_details[0].id,'123');
});
