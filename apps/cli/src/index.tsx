import { useRef, useState } from 'react';
import { render } from 'ink';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SessionRepository, type SessionSnapshot } from '@elvion/session';
import { findGitBash } from '@elvion/tool';
import { ElvionError, PermissionModeSchema, type ApprovalDecision, type PermissionMode } from '@elvion/kernel';
import { ElvionApp, loadBrandAssets, type UiMessage, type UiOverlay, type UiApproval, type SlashCommand } from './ui/index.js';
import { appendAssistantText, appendUiMessage, main, reportFatal, runExecution, saveSessionPermissions, saveTuiModel, saveTuiProvider, selectProvider, testProvider, VERSION, type ApplicationSettings } from './application.js';

async function startTui(settings:ApplicationSettings,flags:Record<string,string|boolean>):Promise<void>{
  const packed=new URL('./assets/brand/',import.meta.url);
  const assets=await loadBrandAssets(fileURLToPath(existsSync(packed)?packed:new URL('../../../assets/brand/',import.meta.url)));
  let bashReady=false;try{await findGitBash();bashReady=true;}catch{/* Render diagnostic status. */}
  function ConnectedApp(){
    const [messages,setMessages]=useState<UiMessage[]>([]);
    const [busy,setBusy]=useState(false);
    const operationActive=useRef(false);
    const [providerId,setProviderId]=useState(typeof flags['provider']==='string'?flags['provider']:settings.providers[0]?.id);
    const [permissions,setPermissions]=useState<PermissionMode>(PermissionModeSchema.parse(flags['permissions']??'auto-edit'));
    const [overlay,setOverlay]=useState<UiOverlay|undefined>();
    const [approval,setApproval]=useState<UiApproval|undefined>();
    const [pending,setPending]=useState<((decision:ApprovalDecision)=>void)|undefined>();
    const [cancellation,setCancellation]=useState<AbortController|undefined>();
    const [session,setSession]=useState<SessionSnapshot|undefined>();
    const append=(message:Omit<UiMessage,'id'>):void=>setMessages(previous=>appendUiMessage(previous,{...message,id:randomUUID()}));
    const submit=async(text:string):Promise<void>=>{
      if(operationActive.current)return;operationActive.current=true;setBusy(true);append({kind:'user',text});
      const controller=new AbortController();setCancellation(controller);
      let assistantId='';let activeSessionId=session?.id;
      try{
        await runExecution(settings,{task:text,signal:controller.signal,...(providerId?{providerId}:{}),permissions,...(session?{session}:{}),
          approve:async(request,{signal})=>{
            const result=await new Promise<ApprovalDecision>(resolve=>{
              const finish=(decision:ApprovalDecision):void=>{signal.removeEventListener('abort',abort);resolve(decision);};
              const abort=():void=>finish({requestId:request.id,decision:'cancelled'});
              signal.addEventListener('abort',abort,{once:true});
              setPending(()=>finish);setApproval({id:request.id,tool:request.toolCall.name,arguments:request.toolCall.arguments,cwd:request.workspace,scope:request.scope.join(', ')});
              if(signal.aborted)abort();
            });setPending(undefined);setApproval(undefined);return result;
          },onEvent:event=>{
            activeSessionId=event.sessionId;
            const payload=event.payload;
            if(event.type==='model.text'&&typeof payload==='object'&&payload!==null&&!Array.isArray(payload)&&typeof payload['text']==='string'){
              const text=payload['text'];
              if(!assistantId)assistantId=randomUUID();
              const id=assistantId;setMessages(previous=>appendAssistantText(previous,id,text));
            }else if(['tool.started','tool.finished','verification.finished'].includes(event.type)){assistantId='';append({kind:event.type.startsWith('tool')?'tool':'verification',title:event.type,text:JSON.stringify(payload)});}
            else if(event.type.startsWith('execution.'))append({kind:event.type==='execution.completed'?'report':'system',title:event.type,text:JSON.stringify(payload)});
          }});
      }catch(error){append({kind:'error',text:error instanceof ElvionError?error.message:'Execution failed; inspect diagnostics.'});}
      finally{
        if(activeSessionId){let repository:SessionRepository|undefined;try{repository=await SessionRepository.open(join(settings.dataDirectory,'sessions.sqlite'));setSession(await repository.get(activeSessionId));}catch{append({kind:'error',text:'Could not reload saved execution state. Reload the session before continuing.'});}finally{try{await repository?.close();}catch{append({kind:'error',text:'Could not close session storage cleanly.'});}}}
        operationActive.current=false;setBusy(false);setCancellation(undefined);setApproval(undefined);setPending(undefined);
      }
    };
    const command=async(name:SlashCommand,args:string):Promise<void>=>{
      if(operationActive.current){append({kind:'system',text:'Cancel the active operation before changing settings.'});return;}
      operationActive.current=true;setBusy(true);
      try{
        if(name==='permissions'){if(args){const mode=PermissionModeSchema.parse(args);if(session)setSession(await saveSessionPermissions(settings,session,mode));setPermissions(mode);}else setOverlay({title:'Permissions',lines:['/permissions ask','/permissions auto-edit','/permissions full-access','Full access uses current operating system privileges.']});}
        else if(name==='provider'){
          if(args.startsWith('add ')||args.startsWith('edit ')){
            const config=await saveTuiProvider(settings,JSON.parse(args.slice(args.indexOf(' ')+1)) as unknown,args.startsWith('add ')?'add':'edit');
            setProviderId(config.id);setSession(undefined);append({kind:'system',text:`Saved provider ${config.id}`});
          }else if(args.startsWith('test ')){const config=selectProvider(settings,args.slice(5).trim());const controller=new AbortController();setCancellation(controller);await testProvider(settings,config.id,controller.signal);append({kind:'system',text:`Provider ${config.id} responded successfully.`});}
          else if(args){setProviderId(selectProvider(settings,args).id);setSession(undefined);}
          else setOverlay({title:'Providers',lines:[...settings.providers.map(p=>`${p.id}: ${p.protocol} / ${p.model}`),'Select: /provider <id>','Check: /provider test <id>','Add/edit: /provider add <JSON config>','Config uses apiKeyEnv; never paste credentials.']});
        }else if(name==='model'){
          if(args){const updated=await saveTuiModel(settings,providerId,args);setSession(undefined);append({kind:'system',text:`Model selected: ${updated.model}`});}
          else setOverlay({title:'Model',lines:[selectProvider(settings,providerId).model,'/model <exact model name>']});
        }else if(name==='sessions'||name==='resume'){
          const repository=await SessionRepository.open(join(settings.dataDirectory,'sessions.sqlite'));
          try{if(name==='resume'&&args){const saved=await repository.get(args);if(!saved)throw new ElvionError('not_found','Session not found');setSession(saved);setProviderId(saved.providerId);setPermissions(saved.permissions);append({kind:'system',text:`Loaded session ${saved.id} (${saved.state}). Workspace: ${saved.workspace}`});}else setOverlay({title:'Sessions',lines:(await repository.list()).map(s=>`${s.id} ${s.state} ${s.task.slice(0,60)}`)});}finally{await repository.close();}
        }else if(name==='new'){setSession(undefined);setMessages([]);}
        else setOverlay({title:'Help',lines:['/provider /model /permissions /sessions /resume /new /help','Enter: send · Ctrl+J: newline · Page Up/Down: scroll','Ctrl+C: cancel execution, or exit when idle','Approval: Y approve once; N or Esc deny.']});
      }catch(error){append({kind:'error',text:error instanceof ElvionError?error.message:'Invalid command arguments. Provider configuration accepts apiKeyEnv, never inline credentials.'});}
      finally{operationActive.current=false;setBusy(false);setCancellation(undefined);}
    };
    const provider=settings.providers.find(p=>p.id===providerId);const configured=Boolean(provider&&(!provider.apiKeyEnv||process.env[provider.apiKeyEnv]));
    return <ElvionApp version={VERSION} assets={assets} health={{runtime:{state:configured?'ok':'warning',label:configured?'Configured':'Provider setup required'},execution:{state:busy?'pending':'ok',label:busy?'Running':'Idle'},tools:{state:bashReady?'ok':'warning',label:bashReady?'10 registered':'Git Bash missing'}}} permissionMode={permissions} messages={messages} busy={busy} workspace={session?.workspace??settings.workspace} {...(provider?{model:provider.model}:{})} {...(approval?{approval}:{})} {...(overlay?{overlay}:{})} onSubmit={submit} onCommand={command} onCancel={()=>cancellation?.abort(new ElvionError('cancelled','User cancelled'))} onApproval={(id,approved)=>{if(approval?.id===id)pending?.({requestId:id,decision:approved?'approved':'denied'});}} onCloseOverlay={()=>setOverlay(undefined)}/>;
  }
  const instance=render(<ConnectedApp/>,{exitOnCtrlC:false});await instance.waitUntilExit();
}
try{process.exitCode=await main(process.argv.slice(2),startTui);}catch(error){process.exitCode=reportFatal(error,process.argv.includes('--json'));}
