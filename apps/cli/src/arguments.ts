import { ElvionError, PermissionModeSchema } from '@elvion/kernel';
export function parseArguments(args: string[]): { positionals:string[]; flags:Record<string,string|boolean> } {
  const positionals:string[]=[]; const flags:Record<string,string|boolean>={};
  const booleans=new Set(['json','help','version']);
  const values=new Set(['permissions','provider','workspace','name','protocol','url','model','key-env','data-dir','tools','timeout']);
  for(let i=0;i<args.length;i++){
    const arg=args[i]; if(!arg)continue;
    if(arg==='--'){positionals.push(...args.slice(i+1));break;}
    if(arg.startsWith('-')&&!arg.startsWith('--'))throw new ElvionError('configuration_error',`Unknown option: ${arg}`);
    if(!arg.startsWith('--')){positionals.push(arg);continue;}
    const key=arg.slice(2);
    if(Object.hasOwn(flags,key))throw new ElvionError('configuration_error',`Duplicate option: --${key}`);
    if(booleans.has(key)){flags[key]=true;continue;}
    if(!values.has(key))throw new ElvionError('configuration_error',`Unknown option: --${key}`);
    const value=args[++i]; if(!value||value.startsWith('--'))throw new ElvionError('configuration_error',`Missing value for --${key}`);
    flags[key]=value;
  }
  if(flags['permissions'])PermissionModeSchema.parse(flags['permissions']);
  if(!flags['help']&&!flags['version'])validateCommand(positionals,flags);
  return {positionals,flags};
}
function validateCommand(positionals:string[],flags:Record<string,string|boolean>):void{
  const [command,action]=positionals;
  const common=['json','workspace','data-dir'];
  let allowed=common;let count=0;
  if(command===undefined){allowed=[...common,'permissions','provider'];}
  else if(command==='run'){allowed=[...common,'permissions','provider'];count=2;}
  else if(command==='doctor'){count=1;}
  else if(command==='sessions'&&action==='list'){count=2;}
  else if(command==='resume'){count=2;}
  else if(command==='providers'){
    if(action==='list')count=2;
    else if(action==='test')count=3;
    else if(action==='add'||action==='edit'){count=3;allowed=[...common,'name','protocol','url','model','key-env','tools','timeout'];}
    else throw new ElvionError('configuration_error','Expected providers add, edit, list or test');
  }else throw new ElvionError('configuration_error','Unknown command. Use --help.');
  if(positionals.length!==count)throw new ElvionError('configuration_error','Unexpected or missing arguments. Quote the task text and use --help for command syntax.');
  for(const flag of Object.keys(flags))if(!allowed.includes(flag))throw new ElvionError('configuration_error',`Option --${flag} does not apply to this command`);
  if(!command&&flags['json'])throw new ElvionError('configuration_error','--json requires a noninteractive command');
}
export const HELP = `Elvion — Your Partner in Action.
Usage:
  elvion                                    Interactive TUI
  elvion run "<task>" [--json]             Run one coding task
  elvion sessions list [--json]              List saved sessions
  elvion resume <id> [--json]                Restore saved state/report without replaying operations
  elvion providers add <id> --protocol <protocol> --url <baseUrl> --model <model> [--key-env <ENV>]
  elvion providers edit <id> [--model <model>] [--tools true|false] [--timeout <ms>]
  elvion providers list
  elvion providers test <id>
  elvion doctor [--json]
Options: --permissions ask|auto-edit|full-access --workspace <path> --provider <id> --data-dir <path>
Protocols: openai-chat, openai-responses, anthropic-messages, ollama-chat
Exit codes: 0 success, 1 failed, 2 configuration, 3 approval required, 124 timeout, 130 cancelled.
Permission modes control tool execution; they are not an operating system sandbox.`;
