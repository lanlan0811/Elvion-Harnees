import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProviderConfigSchema, ProviderRuntime, loadProviderConfigs, saveProviderConfigs, probeProvider, type ProviderConfig } from '@elvion/model';
import { SessionRepository, defaultDataDirectory, type SessionSnapshot } from '@elvion/session';
import { ToolRuntime, findGitBash } from '@elvion/tool';
import { executeTask } from '@elvion/execution';
import { ElvionError, EventSequencer, PermissionModeSchema, serializeError, type ApprovalHandler, type EventEnvelope, type JsonValue, type PermissionMode } from '@elvion/kernel';
import { parseArguments, HELP } from './arguments.js';
import type { UiMessage } from './ui/types.js';
import { cleanText } from './ui/text.js';
import packageInfo from '../package.json' with { type: 'json' };
export const VERSION=packageInfo.version;
export interface ApplicationSettings {dataDirectory:string;workspace:string;providers:ProviderConfig[]}
export const MAX_UI_MESSAGES=500;
export const MAX_UI_MESSAGE_CHARACTERS=32_000;
const omitted='\n[Earlier output omitted from display; use the persisted event log for evidence.]\n';
function boundedMessageText(text:string):string{const safe=cleanText(text);return safe.length<=MAX_UI_MESSAGE_CHARACTERS?safe:omitted+safe.slice(-(MAX_UI_MESSAGE_CHARACTERS-omitted.length));}
export function appendUiMessage(messages:readonly UiMessage[],message:UiMessage):UiMessage[]{return [...messages.slice(-(MAX_UI_MESSAGES-1)),{...message,text:boundedMessageText(message.text)}];}
export function appendAssistantText(messages:readonly UiMessage[],id:string,text:string):UiMessage[]{
  if(!messages.some(message=>message.id===id))return appendUiMessage(messages,{id,kind:'assistant',text});
  return messages.slice(-MAX_UI_MESSAGES).map(message=>message.id===id?{...message,text:boundedMessageText(message.text+text)}:message);
}
/** Credential values are never valid provider configuration, even inside a permitted text field. */
function rejectInlineCredentials(input:unknown):void{
  const secrets=Object.entries(process.env).filter(([name,value])=>/(?:key|token|secret|password|credential|authorization)/iu.test(name)&&value!==undefined&&value.length>=3).map(([,value])=>value!);
  const inspect=(value:unknown):boolean=>{
    if(typeof value==='string')return secrets.some(secret=>value.includes(secret))||/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9_.~+/-]+/iu.test(value);
    if(Array.isArray(value))return value.some(inspect);
    if(value!==null&&typeof value==='object')return Object.entries(value).some(([key,entry])=>/^(?:api[_-]?key|key|token|secret|password|credential|authorization)$/iu.test(key)||inspect(entry));
    return false;
  };
  if(inspect(input))throw new ElvionError('configuration_error','Inline credentials are not accepted. Use apiKeyEnv with an environment variable name.');
}
export async function saveTuiProvider(settings:ApplicationSettings,input:unknown,action:'add'|'edit'):Promise<ProviderConfig>{
  rejectInlineCredentials(input);
  const provider=ProviderConfigSchema.parse(input);
  const exists=settings.providers.some(current=>current.id===provider.id);
  if((action==='add'&&exists)||(action==='edit'&&!exists))throw new ElvionError('configuration_error',exists?'Provider already exists. Use /provider edit.':'Provider does not exist. Use /provider add.');
  const next=[...settings.providers.filter(current=>current.id!==provider.id),provider];
  await saveProviderConfigs(join(settings.dataDirectory,'providers.json'),next);
  settings.providers=next;return provider;
}
export async function saveTuiModel(settings:ApplicationSettings,providerId:string|undefined,model:string):Promise<ProviderConfig>{
  const current=selectProvider(settings,providerId);
  return await saveTuiProvider(settings,{...current,model},'edit');
}
export async function saveSessionPermissions(settings:ApplicationSettings,session:SessionSnapshot,mode:PermissionMode):Promise<SessionSnapshot>{
  const permissions=PermissionModeSchema.parse(mode);
  const repository=await SessionRepository.open(join(settings.dataDirectory,'sessions.sqlite'));
  try{
    const current=await repository.get(session.id);
    if(!current)throw new ElvionError('not_found','Session not found');
    if(current.lastSequence!==session.lastSequence)throw new ElvionError('conflict','Session changed. Reload it before changing permissions.');
    if(['running','awaiting_approval','verifying','recovering'].includes(current.state))throw new ElvionError('conflict','Review or finish the saved execution before changing its permissions.');
    const event=new EventSequencer({sessionId:current.id,nextSequence:current.lastSequence+1}).next('session.permissions_changed',{previous:current.permissions,permissions,source:'user'});
    const next={...current,permissions,lastSequence:event.sequence,updatedAt:event.timestamp};
    await repository.save(next,[event]);return next;
  }finally{await repository.close();}
}
export async function testProvider(settings:ApplicationSettings,id:string|undefined,signal:AbortSignal):ReturnType<typeof probeProvider>{
  const result=await probeProvider(selectProvider(settings,id),{signal});
  let text=cleanText(result.text);
  for(const [name,value]of Object.entries(process.env))if(/(?:key|token|secret|password|credential|authorization)/iu.test(name)&&value&&value.length>=3)text=text.replaceAll(value,'[REDACTED]');
  return {...result,text:text.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9_.~+/-]+/giu,'[REDACTED]')};
}
export async function loadSettings(flags:Record<string,string|boolean>):Promise<ApplicationSettings>{
  const dataDirectory=resolve(typeof flags['data-dir']==='string'?flags['data-dir']:defaultDataDirectory());
  let workspace:string;
  try{workspace=await realpath(typeof flags['workspace']==='string'?flags['workspace']:process.cwd());if(!(await stat(workspace)).isDirectory())throw new Error('Workspace must be a directory');}
  catch(cause){throw new ElvionError('configuration_error','Workspace does not exist or is not accessible',{cause});}
  return {dataDirectory,workspace,providers:await loadProviderConfigs(join(dataDirectory,'providers.json'))};
}
export function selectProvider(settings:ApplicationSettings,id?:string):ProviderConfig{
  const config=id?settings.providers.find(p=>p.id===id):settings.providers[0];
  if(!config)throw new ElvionError('configuration_error','No matching provider configured. Use elvion providers add --help.');
  return config;
}
export function exitCode(type:string):number{return type==='execution.completed'?0:type==='execution.approval_required'?3:type==='execution.timed_out'?124:type==='execution.cancelled'?130:1;}
export async function runExecution(settings:ApplicationSettings,options:{task:string;providerId?:string;permissions?:string;signal:AbortSignal;approve?:ApprovalHandler;session?:SessionSnapshot;onEvent:(event:EventEnvelope)=>void|Promise<void>}):Promise<number>{
  const provider=selectProvider(settings,options.session?.providerId??options.providerId);
  const repository=await SessionRepository.open(join(settings.dataDirectory,'sessions.sqlite'));
  let code=1;
  try{
    for await(const event of executeTask({task:options.task,workspace:options.session?.workspace??settings.workspace,providerId:provider.id,model:provider.model,runtime:new ProviderRuntime(provider),repository,signal:options.signal,tools:new ToolRuntime(),lockDirectory:join(settings.dataDirectory,'locks'),...(options.permissions?{permissions:PermissionModeSchema.parse(options.permissions)}:{}),...(options.approve?{approve:options.approve}:{}),...(options.session?{session:options.session}:{})})){await options.onEvent(event);if(event.type.startsWith('execution.'))code=exitCode(event.type);}
  }finally{await repository.close();}
  return code;
}
export async function main(args:string[],startTui:(settings:ApplicationSettings,flags:Record<string,string|boolean>)=>Promise<void>):Promise<number>{
  const {positionals,flags}=parseArguments(args); const json=flags['json']===true;
  const output=(value:unknown):void=>{process.stdout.write(`${typeof value==='string'&&!json?value:JSON.stringify(value)}\n`);};
  if(flags['version']){output(json?{version:VERSION}:VERSION);return 0;}
  if(flags['help']){output(json?{help:HELP}:HELP);return 0;}
  const settings=await loadSettings(flags); const command=positionals[0];
  if(!command){if(!process.stdin.isTTY||!process.stdout.isTTY)throw new ElvionError('configuration_error','Interactive TUI requires a terminal. Use elvion run or --help.');await startTui(settings,flags);return 0;}
  if(command==='providers'){
    const action=positionals[1]; const id=positionals[2];
    if(action==='list'){output(settings.providers);return 0;}
    if(action==='add'||action==='edit'){
      if(action==='add'&&settings.providers.some(provider=>provider.id===id))throw new ElvionError('configuration_error','Provider already exists. Use providers edit.');
      const previous=action==='edit'?selectProvider(settings,id):undefined;
      if(flags['tools']!==undefined&&!['true','false'].includes(String(flags['tools'])))throw new ElvionError('configuration_error','--tools must be true or false');
      const input={...previous,id,name:flags['name']??previous?.name??id,protocol:flags['protocol']??previous?.protocol,baseUrl:flags['url']??previous?.baseUrl,model:flags['model']??previous?.model,...(flags['key-env']?{apiKeyEnv:flags['key-env']}:{ }),capabilities:{tools:flags['tools']!==undefined?flags['tools']==='true':previous?.capabilities.tools??true},...(flags['timeout']?{timeoutMs:Number(flags['timeout'])}:{})};
      rejectInlineCredentials(input);const provider=ProviderConfigSchema.parse(input);
      const existing=settings.providers.filter(p=>p.id!==provider.id);
      await saveProviderConfigs(join(settings.dataDirectory,'providers.json'),[...existing,provider]);output({saved:provider.id});return 0;
    }
    if(action==='test'){
      const cancellation=new AbortController();const cancel=():void=>cancellation.abort(new ElvionError('cancelled','User cancelled'));process.on('SIGINT',cancel);
      try{output(await testProvider(settings,id,cancellation.signal));return 0;}finally{process.removeListener('SIGINT',cancel);}
    }
    throw new ElvionError('configuration_error','Expected providers add, edit, list or test');
  }
  if(command==='doctor'){
    let bash:string|null=null;try{bash=await findGitBash();}catch{/* Diagnostic failure reported below. */}
    const result={version:VERSION,node:process.version,workspace:settings.workspace,providers:settings.providers.map(p=>({id:p.id,protocol:p.protocol,model:p.model,credentialConfigured:!p.apiKeyEnv||Boolean(process.env[p.apiKeyEnv])})),bash,ready:bash!==null&&settings.providers.length>0&&settings.providers.every(p=>!p.apiKeyEnv||Boolean(process.env[p.apiKeyEnv]))};
    output(result);return result.ready?0:2;
  }
  if(command==='sessions'&&positionals[1]==='list'){const repository=await SessionRepository.open(join(settings.dataDirectory,'sessions.sqlite'));try{output((await repository.list()).map(({id,task,state,permissions,updatedAt})=>({id,task,state,permissions,updatedAt})));}finally{await repository.close();}return 0;}
  let session:SessionSnapshot|undefined;
  if(command==='resume'){
    const id=positionals[1];if(!id)throw new ElvionError('configuration_error','A session ID is required');
    const repository=await SessionRepository.open(join(settings.dataDirectory,'sessions.sqlite'));
    try{
      session=await repository.get(id);
      if(!session)throw new ElvionError('not_found','Session not found');
      const history=await repository.events(id);const pending=new Set<string>();
      for(const event of history){const payload=event.payload;if(payload===null||typeof payload!=='object'||Array.isArray(payload))continue;if(event.type==='tool.started'&&typeof payload['id']==='string')pending.add(payload['id']);if(event.type==='tool.finished'&&typeof payload['toolCallId']==='string')pending.delete(payload['toolCallId']);}
      const uncertain=pending.size>0||['running','awaiting_approval','verifying','recovering','needs_review'].includes(session.state);
      const sequence=new EventSequencer({sessionId:session.id,executionId:randomUUID(),nextSequence:session.lastSequence+1});
      const restored=sequence.next('session.restored',{state:session.state,permissions:session.permissions,workspace:session.workspace,replayed:false});
      const terminal=uncertain?'execution.needs_review':`execution.${session.state}`;
      const previous=[...history].reverse().find(event=>event.type===terminal);
      const final=sequence.next(terminal,previous?.payload??{reason:uncertain?'Inspect uncertain previous operations before starting a new task. Automatic replay is disabled.':'Saved conversation restored. Submit a new task through the TUI or elvion run.'} as JsonValue);
      const snapshot={...session,...(uncertain?{state:'needs_review' as const}:{}),lastSequence:final.sequence,updatedAt:final.timestamp};
      await repository.save(snapshot,[restored,final]);
      if(json){output(restored);output(final);}else output({sessionId:session.id,state:snapshot.state,permissions:session.permissions,replayed:false,report:previous?.payload??null});
      return exitCode(terminal);
    }finally{await repository.close();}
  }else if(command!=='run')throw new ElvionError('configuration_error','Unknown command. Use --help.');
  const task=positionals[1]?.trim()??'';
  if(!task)throw new ElvionError('configuration_error','A task is required');
  const cancellation=new AbortController();const cancel=():void=>cancellation.abort(new ElvionError('cancelled','User cancelled'));process.on('SIGINT',cancel);
  try{return await runExecution(settings,{task,signal:cancellation.signal,...(session?{session}:{}),...(typeof flags['provider']==='string'?{providerId:flags['provider']}:{}),...(typeof flags['permissions']==='string'?{permissions:flags['permissions']}:{}),onEvent:event=>{if(json)output(event);else if(event.type==='model.text'&&typeof event.payload==='object'&&event.payload!==null&&!Array.isArray(event.payload)&&typeof event.payload['text']==='string')process.stdout.write(event.payload['text']);else process.stderr.write(`${event.type} ${JSON.stringify(event.payload)}\n`);}});}finally{process.removeListener('SIGINT',cancel);}
}
export function reportFatal(error:unknown,json:boolean):number{
  const invalid=error instanceof SyntaxError||(error instanceof Error&&error.name==='ZodError');
  const serialized=serializeError(error instanceof ElvionError?error:new ElvionError(invalid?'configuration_error':'invalid_state',invalid?'Invalid arguments, configuration or runtime data':'Unexpected runtime failure',{cause:error}));
  const event={version:1,sequence:1,timestamp:new Date().toISOString(),sessionId:randomUUID(),type:'cli.error',payload:{error:serialized}};
  if(json)process.stdout.write(`${JSON.stringify(event)}\n`);else process.stderr.write(`${serialized.message}\n`);
  return serialized.code==='approval_required'?3:serialized.code==='cancelled'?130:serialized.code==='timeout'?124:['configuration_error','validation_error','not_found'].includes(serialized.code)?2:1;
}
