import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetTracker, ElvionError, EventSequencer, type EventEnvelope } from '@elvion/kernel';
import { loadProviderConfigs, saveProviderConfigs, type ProviderConfig } from '@elvion/model';
import { SessionRepository, type SessionSnapshot } from '@elvion/session';
import { appendAssistantText, appendUiMessage, main, MAX_UI_MESSAGE_CHARACTERS, MAX_UI_MESSAGES, reportFatal, resumeTuiSession, runExecution, saveSessionPermissions, saveTuiModel, saveTuiProvider, testProvider, tuiExecutionSettings, type ApplicationSettings } from './application.js';
import { parseArguments } from './arguments.js';
import type { UiMessage } from './ui/types.js';

describe('CLI argument contracts', () => {
  it.each([['providers','list','extra'],['providers','test'],['providers','edit'],['doctor','extra'],['resume','id','extra'],['sessions','list','extra'],['run','two','separate'],['run','task','--model','unused'],['resume','id','--permissions','full-access'],['providers','list','--provider','unused'],['--json'],['-x']])('rejects missing, surplus and ignored arguments %j',(...args:string[])=>{expect(()=>parseArguments(args)).toThrow();});
  it('accepts quoted tasks and a delimiter for task text beginning with a dash',()=>{
    expect(parseArguments(['run','quoted task','--permissions','ask']).positionals).toEqual(['run','quoted task']);
    expect(parseArguments(['run','--','--literal task']).positionals).toEqual(['run','--literal task']);
    expect(parseArguments(['providers','list','--json']).flags['json']).toBe(true);
    expect(parseArguments(['providers','test','local']).positionals).toEqual(['providers','test','local']);
  });
  it('maps runtime and configuration failures to distinct exit codes',()=>{
    const error=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
    try{
      expect(reportFatal(new ElvionError('not_found','Missing'),false)).toBe(2);
      expect(reportFatal(new ElvionError('configuration_error','Invalid'),false)).toBe(2);
      expect(reportFatal(new ElvionError('storage_error','Unavailable'),false)).toBe(1);
      expect(reportFatal(new Error('Unexpected'),false)).toBe(1);
      expect(reportFatal(new ElvionError('timeout','Timeout'),false)).toBe(124);
      expect(reportFatal(new ElvionError('cancelled','Cancel'),false)).toBe(130);
      expect(error).toHaveBeenCalled();
    }finally{error.mockRestore();}
  });
});

describe('bounded TUI message state',()=>{
  it('bounds ordinary append, first streamed chunk and subsequent assistant updates consistently',()=>{
    const initial:UiMessage[]=Array.from({length:MAX_UI_MESSAGES},(_,id)=>({id:String(id),kind:'tool',text:'output'}));
    const appended=appendUiMessage(initial,{id:'next',kind:'tool',text:'x'.repeat(100_000)});
    expect(appended).toHaveLength(MAX_UI_MESSAGES);
    expect(appended[0]?.id).toBe('1');
    expect(appended.at(-1)!.text.length).toBeLessThanOrEqual(MAX_UI_MESSAGE_CHARACTERS);
    const first=appendAssistantText(initial,'assistant','a'.repeat(40_000));
    const updated=appendAssistantText(first,'assistant','b'.repeat(40_000));
    expect(updated).toHaveLength(MAX_UI_MESSAGES);
    expect(updated.filter(message=>message.id==='assistant')).toHaveLength(1);
    expect(updated.at(-1)!.text.length).toBeLessThanOrEqual(MAX_UI_MESSAGE_CHARACTERS);
    expect(updated.at(-1)?.text).toContain('Earlier output omitted');
    expect(updated.at(-1)?.text.endsWith('b'.repeat(100))).toBe(true);
    expect(initial).toHaveLength(MAX_UI_MESSAGES);expect(initial[0]?.id).toBe('0');
  });
});

describe('provider configuration transactions and local HTTP probe',()=>{
  let directory:string;let settings:ApplicationSettings;let server:Server|undefined;
  const config:ProviderConfig={id:'local',name:'Local fixture',protocol:'openai-chat',baseUrl:'http://127.0.0.1:1/v1',model:'fixture',capabilities:{tools:true}};
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'elvion-application-'));settings={dataDirectory:directory,workspace:directory,providers:[]};});
  afterEach(async()=>{vi.unstubAllEnvs();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}await rm(directory,{recursive:true,force:true});});
  it('saves and validates before replacing in-memory provider settings',async()=>{
    await saveTuiProvider(settings,config,'add');
    expect(settings.providers).toEqual([config]);expect(await loadProviderConfigs(join(directory,'providers.json'))).toEqual([config]);
    const snapshot=structuredClone(settings.providers);
    await expect(saveTuiProvider(settings,{...config,model:''},'edit')).rejects.toBeDefined();
    expect(settings.providers).toEqual(snapshot);
    const blocked=join(directory,'not-a-directory');await writeFile(blocked,'file');settings.dataDirectory=blocked;
    await expect(saveTuiModel(settings,'local','new-model')).rejects.toMatchObject({code:'configuration_error'});
    expect(settings.providers).toEqual(snapshot);
    expect(await loadProviderConfigs(join(directory,'providers.json'))).toEqual(snapshot);
  });
  it('rejects inline credentials explicitly without saving or changing settings',async()=>{
    const secret='private-test-key-190541';vi.stubEnv('ELVION_PROVIDER_TEST_KEY',secret);
    for(const input of [{...config,apiKey:secret},{...config,name:secret},{...config,model:'sk-secretvalue123456'},{...config,baseUrl:'https://user:password@example.test/v1'}])await expect(saveTuiProvider(settings,input,'add')).rejects.toBeDefined();
    expect(settings.providers).toEqual([]);
    await expect(readFile(join(directory,'providers.json'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('enforces add and edit intent instead of silently replacing or creating providers',async()=>{
    await expect(saveTuiProvider(settings,config,'edit')).rejects.toMatchObject({code:'configuration_error'});
    await saveTuiProvider(settings,config,'add');
    await expect(saveTuiProvider(settings,{...config,model:'replacement'},'add')).rejects.toMatchObject({code:'configuration_error'});
    expect(settings.providers[0]?.model).toBe('fixture');
  });
  it('cancels an actual pending local provider response',async()=>{
    let connected!:()=>void;const requestSeen=new Promise<void>(resolve=>{connected=resolve;});
    server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/event-stream'});response.write(': connected\n\n');connected();});server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture port unavailable');
    settings.providers=[{...config,baseUrl:`http://127.0.0.1:${address.port}/v1`}];
    const cancellation=new AbortController();const probe=testProvider(settings,'local',cancellation.signal);
    const result=expect(probe).rejects.toMatchObject({code:'cancelled'});
    await requestSeen;cancellation.abort(new ElvionError('cancelled','User cancelled provider probe'));await result;
  });
  it('retains session identity and history when the user changes saved permissions',async()=>{
    const now=new Date().toISOString();const session:SessionSnapshot={schemaVersion:1,id:randomUUID(),workspace:directory,providerId:'local',permissions:'ask',state:'completed',task:'old task',messages:[{role:'user',content:'Keep my session'}],lastSequence:0,createdAt:now,updatedAt:now};
    const repository=await SessionRepository.open(join(directory,'sessions.sqlite'));try{await repository.save(session);}finally{await repository.close();}
    const changed=await saveSessionPermissions(settings,session,'auto-edit');
    expect(changed.id).toBe(session.id);expect(changed.messages).toEqual(session.messages);expect(changed.permissions).toBe('auto-edit');
    const reopened=await SessionRepository.open(join(directory,'sessions.sqlite'));try{expect((await reopened.get(session.id))?.permissions).toBe('auto-edit');expect(await reopened.events(session.id)).toMatchObject([{type:'session.permissions_changed',payload:{previous:'ask',permissions:'auto-edit',source:'user'}}]);}finally{await reopened.close();}
    await expect(saveSessionPermissions(settings,session,'full-access')).rejects.toMatchObject({code:'conflict'});
    expect(session.permissions).toBe('ask');
  });
  it('rejects inline credentials passed through noninteractive provider flags without printing or persisting them',async()=>{
    const secret='private-cli-key-484349';vi.stubEnv('ELVION_CLI_TEST_KEY',secret);
    const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    try{
      await expect(main(['providers','add','local','--protocol','openai-chat','--url','https://example.test/v1','--model',secret,'--data-dir',directory,'--workspace',directory],vi.fn())).rejects.toMatchObject({code:'configuration_error',message:'Inline credentials are not accepted. Use apiKeyEnv with an environment variable name.'});
      expect(stdout).not.toHaveBeenCalled();await expect(readFile(join(directory,'providers.json'))).rejects.toMatchObject({code:'ENOENT'});
    }finally{stdout.mockRestore();}
  });
  it('continues an active checkpoint through the CLI application with saved task and permissions', { timeout: 60_000 }, async()=>{
    let requests=0;
    server=createServer((request,response)=>{let text='';request.on('data',chunk=>{text+=String(chunk);});request.on('end',()=>{requests++;const body=JSON.parse(text) as {messages:{content:string}[]};expect(JSON.stringify(body.messages)).toContain('continue saved task');response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Saved task delivered.'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});});
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test port');
    await saveProviderConfigs(join(directory,'providers.json'),[{...config,baseUrl:`http://127.0.0.1:${address.port}/v1`}]);
    await writeFile(join(directory,'package.json'),JSON.stringify({scripts:{test:'node check.mjs'}}));await writeFile(join(directory,'check.mjs'),'console.log("checkpoint-objective-proof");\n');
    const now=new Date().toISOString();const budget=new BudgetTracker();
    const session:SessionSnapshot={schemaVersion:1,id:randomUUID(),workspace:directory,providerId:'local',permissions:'full-access',state:'running',task:'continue saved task',messages:[{role:'user',content:'continue saved task'}],lastSequence:0,createdAt:now,updatedAt:now,checkpoint:{version:1,model:'fixture',phase:'agent',safeToResume:true,tasks:[{id:'saved',title:'Saved increment',dependsOn:[],acceptance:['Original npm test passes'],status:'running'}],currentTaskId:'saved',budget:{limits:{...budget.limits},usage:budget.usage()},verificationBaseline:{manager:'npm',packageManager:null,scripts:{test:'node check.mjs'}},baselineCaptured:true}};
    const repository=await SessionRepository.open(join(directory,'sessions.sqlite'));try{await repository.save(session);}finally{await repository.close();}
    const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    try{expect(await main(['resume',session.id,'--json','--workspace',directory,'--data-dir',directory],vi.fn())).toBe(0);const output=stdout.mock.calls.map(call=>String(call[0])).join('');expect(output).toContain('execution.resumed');expect(output).toContain('execution.completed');expect(output).toContain('checkpoint-objective-proof');expect(requests).toBe(1);}finally{stdout.mockRestore();}
    const reopened=await SessionRepository.open(join(directory,'sessions.sqlite'));try{const saved=await reopened.get(session.id);expect(saved).toMatchObject({task:'continue saved task',permissions:'full-access',state:'completed'});expect(saved?.checkpoint?.tasks[0]?.status).toBe('completed');}finally{await reopened.close();}
  });
  it('restores a saved conversation without model access or replaying operations',async()=>{
    const now=new Date().toISOString();const session:SessionSnapshot={schemaVersion:1,id:randomUUID(),workspace:directory,providerId:'missing-provider',permissions:'ask',state:'completed',task:'restore-only',messages:[],lastSequence:0,createdAt:now,updatedAt:now};
    const completion=new EventSequencer({sessionId:session.id}).next('execution.completed',{report:{passed:true,checks:[{name:'test',command:['node','check.mjs'],exitCode:0,status:'passed',evidence:'Saved independent check passed'}]}});
    session.lastSequence=completion.sequence;
    const dataDirectory=join(directory,'data');await mkdir(dataDirectory);const repository=await SessionRepository.open(join(dataDirectory,'sessions.sqlite'));try{await repository.save(session,[completion]);}finally{await repository.close();}
    const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);const tui=vi.fn();
    try{expect(await main(['resume',session.id,'--json','--workspace',directory,'--data-dir',dataDirectory],tui)).toBe(0);expect(tui).not.toHaveBeenCalled();const output=stdout.mock.calls.map(call=>String(call[0])).join('');expect(output).toContain('session.restored');expect(output).toContain('execution.completed');expect(output).toContain('Saved independent check passed');}finally{stdout.mockRestore();}
    const reopened=await SessionRepository.open(join(dataDirectory,'sessions.sqlite'));try{const events=await reopened.events(session.id);expect(events.map(event=>event.sequence)).toEqual([1,2,3]);expect(events[2]?.payload).toEqual(completion.payload);}finally{await reopened.close();}
  });
  it.each([true,false])('routes TUI completed resumes through the engine completion evidence gate: evidence=%s',async verified=>{
    const now=new Date().toISOString();const session:SessionSnapshot={schemaVersion:1,id:randomUUID(),workspace:directory,providerId:'missing-provider',permissions:'ask',state:'completed',task:'TUI saved task',messages:[],lastSequence:0,createdAt:now,updatedAt:now};
    const history=verified?[new EventSequencer({sessionId:session.id}).next('execution.completed',{report:{passed:true,checks:[{name:'test',command:['node','check.mjs'],exitCode:0,status:'passed',evidence:'TUI verified evidence'}]}})]:[];
    session.lastSequence=history.length;const repository=await SessionRepository.open(join(directory,'sessions.sqlite'));try{await repository.save(session,history);}finally{await repository.close();}
    const onLoaded=vi.fn();const events:EventEnvelope[]=[];const continueExecution=vi.fn(async(saved:SessionSnapshot)=>await runExecution(settings,{task:saved.task,session:saved,signal:new AbortController().signal,onEvent:event=>{events.push(event);}}));
    expect(await resumeTuiSession(settings,session.id,{onLoaded,continueExecution})).toBe(verified?0:1);
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(session,history);expect(continueExecution).toHaveBeenCalledOnce();expect(events.at(-1)?.type).toBe(verified?'execution.completed':'execution.needs_review');expect(events.some(event=>event.type==='model.requested'||event.type==='tool.started')).toBe(false);
  });
  it('uses the displayed restored workspace for new TUI tasks and returns to the launch workspace after new', {timeout:60_000}, async()=>{
    const launch=join(directory,'launch');const restored=join(directory,'restored');await mkdir(launch);await mkdir(restored);
    for(const workspace of [launch,restored]){await writeFile(join(workspace,'package.json'),JSON.stringify({scripts:{test:'node check.mjs'}}));await writeFile(join(workspace,'check.mjs'),'console.log("workspace-target-verified");');}
    let requests=0;const separator=String.fromCharCode(10,10);
    server=createServer((request,response)=>{let text='';request.on('data',chunk=>{text+=String(chunk);});request.on('end',()=>{requests++;const body=JSON.parse(text) as {tools?:unknown[]};const planning=!body.tools;const turn=(requests-1)%3;const payload=planning?{content:JSON.stringify([{id:'target',title:'Write target',acceptance:['Original check passes']}])}:turn===1?{tool_calls:[{index:0,id:'target-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'target.txt',content:'selected-workspace'})}}]}:{content:'Target written.'};response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{index:0,delta:payload,finish_reason:'tool_calls' in payload?'tool_calls':'stop'}]})+separator+'data: [DONE]'+separator);});});
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test port');
    settings.workspace=launch;settings.providers=[{...config,baseUrl:'http://127.0.0.1:'+address.port+'/v1'}];const now=new Date().toISOString();const saved:SessionSnapshot={schemaVersion:1,id:randomUUID(),workspace:restored,providerId:'local',permissions:'full-access',state:'completed',task:'previous',messages:[],lastSequence:0,createdAt:now,updatedAt:now};
    const selected=tuiExecutionSettings(settings,saved);expect(selected.workspace).toBe(restored);expect(settings.workspace).toBe(launch);
    expect(await runExecution(selected,{task:'Write in restored workspace',permissions:'full-access',signal:new AbortController().signal,onEvent:()=>{}})).toBe(0);
    expect(await readFile(join(restored,'target.txt'),'utf8')).toBe('selected-workspace');await expect(readFile(join(launch,'target.txt'))).rejects.toMatchObject({code:'ENOENT'});
    const afterNew=tuiExecutionSettings(settings,undefined);expect(afterNew.workspace).toBe(launch);
    expect(await runExecution(afterNew,{task:'Write in launch workspace after new',permissions:'full-access',signal:new AbortController().signal,onEvent:()=>{}})).toBe(0);
    expect(await readFile(join(launch,'target.txt'),'utf8')).toBe('selected-workspace');expect(requests).toBe(6);
  });
  it('requires review instead of exiting successfully for a legacy completed snapshot without completion evidence',async()=>{
    const now=new Date().toISOString();const session:SessionSnapshot={schemaVersion:1,id:randomUUID(),workspace:directory,providerId:'missing-provider',permissions:'ask',state:'completed',task:'unverified legacy task',messages:[],lastSequence:0,createdAt:now,updatedAt:now};
    const repository=await SessionRepository.open(join(directory,'sessions.sqlite'));try{await repository.save(session);}finally{await repository.close();}
    const stdout=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);const tui=vi.fn();
    try{expect(await main(['resume',session.id,'--json','--workspace',directory,'--data-dir',directory],tui)).toBe(1);expect(tui).not.toHaveBeenCalled();const output=stdout.mock.calls.map(call=>String(call[0])).join('');expect(output).toContain('execution.needs_review');expect(output).not.toContain('execution.completed');expect(output).not.toContain('model.requested');expect(output).not.toContain('tool.started');}finally{stdout.mockRestore();}
    const reopened=await SessionRepository.open(join(directory,'sessions.sqlite'));try{expect((await reopened.get(session.id))?.state).toBe('needs_review');expect((await reopened.events(session.id)).map(event=>event.type)).toEqual(['execution.needs_review']);}finally{await reopened.close();}
  });
});
