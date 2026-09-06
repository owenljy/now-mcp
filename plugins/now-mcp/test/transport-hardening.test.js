import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { ScriptService } from '../build/services/script-service.js';
import { ServiceNowClient } from '../build/client/servicenow-client.js';
import { MutationOutcomeUncertainError } from '../build/types/errors.js';
import { chunkWriterSource, payloadChecksum, reassembleChunks, validateMailboxEnvelope } from '../build/utils/mailbox-protocol.js';
import { rewriteScriptLogs } from '../build/utils/rewrite-script-logs.js';
import { runProcess } from '../build/utils/subprocess.js';
import { selectAlignedProfile } from '../build/utils/now-sdk-cli.js';
import { logger } from '../build/utils/logger.js';
logger.setLevel('error');

const manager = (client, config = {}) => ({getClient:()=>client, getConfig:()=>({name:'test',readOnly:false,...config}),getConfigSource:()=>({kind:'env'})});

async function executeMock(script, options = {}) {
  const db = new Map(); let seq = 0; const chunks = [];let activeDeletes=0,peakDeletes=0;
  class GR {
    initialize(){this.row={};}
    get(key,value){this.row=[...db.values()].find(x=>x[key]===value);return !!this.row;}
    getValue(key){return this.row[key];}
    setValue(key,value){this.row[key]=value;}
    update(){return this.row.sys_id;}
    insert(){this.row.sys_id='id'+(++seq);db.set(this.row.sys_id,this.row);chunks.push({...this.row});return this.row.sys_id;}
    deleteRecord(){db.delete(this.row.sys_id);return true;}
  }
  const client = {
    async post(endpoint,body){
      const id='id'+(++seq); db.set(id,{...body,sys_id:id});
      if(endpoint.endsWith('sys_properties')) assert.equal(body.ignore_cache,true);
      if(endpoint.endsWith('sys_trigger')) {
        vm.runInNewContext(body.script,{GlideRecord:GR,gs:{getUserName:()=> 'test',getUserID:()=> 'test',getCurrentScopeName:()=> 'global'}});
        db.delete(id); // Run Once scheduler cleanup.
      }
      return {result:{sys_id:id}};
    },
    async get(endpoint,params){
      if(params?.sysparm_query){
        let rows=[...db.values()].filter(r=>r.name.startsWith(params.sysparm_query.replace('nameSTARTSWITH','')));
        if(options.corrupt && params.sysparm_fields==='name,value')rows=rows.map(r=>({...r,value:options.corrupt(r.value)}));
        return {result:rows};
      }
      return {result:db.get(endpoint.split('/').at(-1))};
    },
    async patch(endpoint,body){Object.assign(db.get(endpoint.split('/').at(-1)),body);},
    async delete(endpoint){
      activeDeletes++;peakDeletes=Math.max(peakDeletes,activeDeletes);
      try{if(options.deleteDelay)await new Promise(r=>setTimeout(r,options.deleteDelay));db.delete(endpoint.split('/').at(-1));}
      finally{activeDeletes--;}
    }
  };
  const result = await new ScriptService(manager(client),{sleep:async()=>{}}).executeBackgroundScript(script,5000);
  return {result,chunks,remaining:db.size,peakDeletes};
}

test('generated wrapper preserves an emoji across chunk boundaries with consistent metadata',async()=>{
  const expected='x'.repeat(3499)+'😀end';
  const {result,chunks,remaining}=await executeMock(`gs.info(${JSON.stringify(expected)});`);
  assert.equal(result.output,expected); assert.equal(result.success,true);
  assert.equal(result.outputReturnedChars,expected.length); assert.equal(result.outputStatus,'complete');
  assert.equal(result.cleanupStatus,'complete'); assert.equal(remaining,0);
  assert.equal(chunks.length,2);
  for(const chunk of chunks){assert.ok(chunk.value.isWellFormed());assert.equal(chunk.ignore_cache,true);}
});

test('cap never returns an isolated surrogate and reports actual retained characters',async()=>{
  const input='x'.repeat(55999)+'😀end';
  const {result}=await executeMock(`gs.info(${JSON.stringify(input)});`);
  assert.equal(result.output,'x'.repeat(55999));assert.equal(result.outputTruncated,true);
  assert.equal(result.outputReturnedChars,55999);assert.equal(result.outputOriginalChars,input.length);
});

test('large-output cleanup runs with bounded parallelism and removes every chunk',async()=>{
  const {result,remaining,peakDeletes}=await executeMock("gs.info(new Array(56001).join('x'));",{deleteDelay:5});
  assert.equal(peakDeletes,4);assert.equal(remaining,0);assert.equal(result.cleanupStatus,'complete');
});

test('an uncertain mailbox creation is reconciled by its unique name without submitting a trigger',async()=>{
  const original=globalThis.fetch;const calls=[];const rows=[];
  globalThis.fetch=async(url,opts)=>{
    calls.push({url,method:opts.method});
    if(opts.method==='POST'){
      rows.push({sys_id:'created',name:JSON.parse(opts.body).name});
      return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));
    }
    if(opts.method==='DELETE'){rows.length=0;return new Response(null,{status:204});}
    return new Response(JSON.stringify({result:rows}));
  };
  try{
    const c=new ServiceNowClient('https://example.invalid',{type:'basic',username:'test',password:'test'});
    await assert.rejects(new ScriptService(manager(c)).executeBackgroundScript("gs.info('test');",20),e=>e.code==='MUTATION_OUTCOME_UNCERTAIN' && !!e.servicenowError.temporaryRecordName);
    assert.equal(rows.length,0);assert.equal(calls.some(c=>c.url.includes('sys_trigger')),false);
  }finally{globalThis.fetch=original;}
});

test('empty logging lines survive capture and an empty script has a valid v2 checksum',async()=>{
  assert.equal((await executeMock("gs.info('');gs.info('x');")).result.output,'\nx');
  const r=(await executeMock('1 + 1;')).result;
  assert.equal(r.output,'');assert.equal(r.outputStatus,'complete');assert.equal(r.success,true);
});

test('missing content and same-length corruption fail integrity without claiming the script failed',async()=>{
  for(const corrupt of [()=>'',s=>'q'.repeat(s.length)]){
    const {result,remaining}=await executeMock("gs.info('meaningful output');",{corrupt});
    assert.equal(result.success,false);assert.equal(result.executionState,'completed');
    assert.equal(result.outputStatus,'incomplete');assert.match(result.error,/mismatch/);assert.equal(remaining,0);
  }
});

test('v2 envelope must carry integrity metadata and rejects invalid chunk values',()=>{
  assert.equal(validateMailboxEnvelope({status:'done',success:true,protocolVersion:2,chunkCount:0}).valid,false);
  assert.match(reassembleChunks('k',1,[{name:'k.chunk.0',value:null}]).error,/missing/);
  assert.match(reassembleChunks('k',1,[{name:'k.chunk.0',value:'B'}],{outputReturnedChars:1,payloadChecksum:payloadChecksum('A')}).error,/checksum/);
});

test('partial insertion followed by cancellation deletes actual sparse chunk indices',()=>{
  let inserted=0,active=true;const rows=new Map();
  class GR {
    initialize(){this.row={};}setValue(k,v){this.row[k]=v;}
    insert(){if(++inserted===1)return null;rows.set(this.row.name,this.row);active=false;return 'id';}
    get(k,v){this.row=rows.get(v);return !!this.row;}deleteRecord(){rows.delete(this.row.name);return true;}
  }
  const context={GlideRecord:GR,active:()=>active};vm.createContext(context);
  vm.runInContext(chunkWriterSource("'test'")+"result=__writeChunks(new Array(7001).join('x'),7000,active);",context);
  assert.equal(context.result.cancelled,true);assert.equal(rows.size,0);
});

test('logging rewrite changes calls but preserves strings, comments, regex and template text',async()=>{
  const code="// gs.info('comment')\nvar s='gs.info(payload)'; var re=/gs.info\\(/; gs.info(s);";
  const rewritten=rewriteScriptLogs(code);
  assert.ok(rewritten.includes("// gs.info('comment')"));assert.ok(rewritten.includes("'gs.info(payload)'"));
  assert.ok(rewritten.includes('/gs.info\\(/'));assert.ok(rewritten.endsWith('log(s);'));
  assert.equal((await executeMock(code)).result.output,'gs.info(payload)');
  assert.equal(rewriteScriptLogs('gs.info(`gs.info(x) ${gs.info("inner")}`);'),'log(`gs.info(x) ${log("inner")}`);');
  assert.throws(()=>rewriteScriptLogs('var =;'),e=>e.code==='BACKGROUND_SCRIPT_PARSE_ERROR');
});

test('Scripted REST preserves uncertain mutation errors',async()=>{
  const error=new MutationOutcomeUncertainError({outcome:'uncertain',retryable:false,method:'POST',endpoint:'/api/run',instanceUrl:'https://example.invalid',reason:'response lost',reconciliation:'verify first'});
  const service=new ScriptService(manager({post:async()=>{throw error;}},{scriptApiPath:'/api/run'}));
  await assert.rejects(service.executeBackgroundScript('1'),e=>e===error && !e.message.includes('before the submitted script ran'));
});

test('HTTP body remains under timeout and a timed-out mutation is uncertain',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){
    setTimeout(()=>{controller.enqueue(new TextEncoder().encode('{"result":[]}'));controller.close();},80);
  }}),{status:200});
  try{
    const client=new ServiceNowClient('https://example.invalid',{type:'basic',username:'test',password:'test'},10);
    const started=Date.now();
    await assert.rejects(client.post('/api/run',{}),e=>e.code==='MUTATION_OUTCOME_UNCERTAIN');
    assert.ok(Date.now()-started<80);
  }finally{globalThis.fetch=original;}
});

test('a request whose deadline expires while queued is never dispatched later',async()=>{
  const original=globalThis.fetch;const old=process.env.SERVICENOW_MAX_CONCURRENT;
  process.env.SERVICENOW_MAX_CONCURRENT='1';let release;const calls=[];
  globalThis.fetch=async(url)=>{calls.push(url);await new Promise(r=>{release=r;});return new Response('{"result":[]}');};
  try{
    const c=new ServiceNowClient('https://example.invalid',{type:'basic',username:'test',password:'test'});
    const first=c.get('/first');while(!release)await new Promise(r=>setImmediate(r));
    await assert.rejects(c.withDeadline(Date.now()+15).post('/must-not-run',{}),e=>e.code==='REQUEST_DEADLINE_EXCEEDED');
    release();await first;await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);
  }finally{globalThis.fetch=original;if(old===undefined)delete process.env.SERVICENOW_MAX_CONCURRENT;else process.env.SERVICENOW_MAX_CONCURRENT=old;}
});

test('SDK profile selection requires an explicit choice for duplicate hosts and rejects cross-host aliases',()=>{
  const profiles=[{alias:'old',host:'https://dev',isDefault:true},{alias:'valid',host:'https://dev',isDefault:false},{alias:'other',host:'https://other',isDefault:false}];
  assert.equal(selectAlignedProfile(profiles,'https://dev').ok,false);
  assert.equal(selectAlignedProfile(profiles,'https://dev','valid').profile.alias,'valid');
  assert.equal(selectAlignedProfile(profiles,'https://dev','other').ok,false);
  assert.equal(selectAlignedProfile([profiles[1]],'https://dev').ok,true);
});

test('asynchronous subprocess leaves event-loop timers responsive',async()=>{
  let fired=false;const timer=setTimeout(()=>{fired=true;},10);
  const result=await runProcess(process.execPath,['-e','setTimeout(()=>console.log("ok"),80)'],{timeoutMs:2000});
  clearTimeout(timer);assert.equal(fired,true);assert.equal(result.ok,true);assert.equal(result.stdout.trim(),'ok');
});

test('subprocess cancellation and output ceilings terminate the child',async()=>{
  const controller=new AbortController();setTimeout(()=>controller.abort(),30);
  const cancelled=await runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:2000,signal:controller.signal});
  assert.equal(cancelled.reason,'cancelled');
  const oversized=await runProcess(process.execPath,['-e','process.stdout.write("x".repeat(10000));'],{timeoutMs:2000,maxBytes:100});
  assert.equal(oversized.reason,'output_limit');assert.equal(oversized.ok,false);
});
