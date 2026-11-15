import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { quoteWindowsArgument } from '../../packages/tool/src/windows-job.js';

/** Test-only native console launcher. argv are encoded data; the trusted program
 * creates an isolated hidden console, waits for execution.started on redirected
 * stdout, and sends the actual CTRL_C_EVENT to that console. */
const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$source=@'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ElvionConsoleTest {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct START { public uint cb; public string reserved,desktop,title; public uint x,y,w,h,cx,cy,fill,flags; public ushort show,reserved2; public IntPtr bytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct INFO { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref SECURITY security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr environment,string cwd,ref START start,out INFO info);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint type,uint group);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string executable,string command,string cwd,string stdout,string stderr) {
    SECURITY security=new SECURITY(); security.length=Marshal.SizeOf(typeof(SECURITY));security.inherit=1;
    IntPtr output=CreateFile(stdout,0x40000000,3,ref security,2,0x80,IntPtr.Zero);
    IntPtr error=CreateFile(stderr,0x40000000,3,ref security,2,0x80,IntPtr.Zero);
    IntPtr input=CreateFile("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero);
    INFO info=new INFO();
    try {
      START start=new START();start.cb=(uint)Marshal.SizeOf(typeof(START));start.flags=0x101;start.show=0;start.input=input;start.output=output;start.error=error;
      if(!CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x10,IntPtr.Zero,cwd,ref start,out info))throw new System.ComponentModel.Win32Exception();
      Stopwatch timer=Stopwatch.StartNew(); bool started=false;
      while(timer.ElapsedMilliseconds<30000) {
        using(var file=new FileStream(stdout,FileMode.Open,FileAccess.Read,FileShare.ReadWrite))using(var reader=new StreamReader(file,Encoding.UTF8)) { if(reader.ReadToEnd().Contains("execution.started")){started=true;break;} }
        if(WaitForSingleObject(info.process,20)==0)break;
      }
      if(!started)throw new Exception("CLI did not begin an execution before console cancellation");
      FreeConsole(); if(!AttachConsole(info.pid))throw new System.ComponentModel.Win32Exception();
      SetConsoleCtrlHandler(IntPtr.Zero,true);
      if(!GenerateConsoleCtrlEvent(0,0))throw new System.ComponentModel.Win32Exception();
      if(WaitForSingleObject(info.process,30000)!=0)throw new Exception("CLI did not stop after actual Ctrl+C");
      uint code;if(!GetExitCodeProcess(info.process,out code))throw new System.ComponentModel.Win32Exception();
      return unchecked((int)code);
    } finally {
      FreeConsole();
      if(info.process!=IntPtr.Zero){if(WaitForSingleObject(info.process,0)!=0)TerminateProcess(info.process,1);CloseHandle(info.process);}
      if(info.thread!=IntPtr.Zero)CloseHandle(info.thread);CloseHandle(input);CloseHandle(output);CloseHandle(error);
    }
  }
}
'@
try {
  Add-Type -TypeDefinition $source -Language CSharp
  $config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ELVION_CONSOLE_TEST)) | ConvertFrom-Json
  exit [ElvionConsoleTest]::Run($config.executable,$config.command,$config.cwd,$config.stdout,$config.stderr)
} catch { [Console]::Error.WriteLine($_.Exception.Message);exit 125 }
`;

export async function cancelWindowsCli(cli: string, args: string[], workspace: string, dataDirectory: string, scratch: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const stdout = join(scratch, 'console.stdout'); const stderr = join(scratch, 'console.stderr');
  const config = { executable: process.execPath, command: [process.execPath, cli, ...args, '--workspace', workspace].map(quoteWindowsArgument).join(' '), cwd: workspace, stdout, stderr };
  await writeFile(stdout, ''); await writeFile(stderr, '');
  const powershell = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: dirname(cli), windowsHide: true, shell: false, env: { ...process.env, ELVION_DATA_DIR: dataDirectory, NODE_NO_WARNINGS: '1', NO_COLOR: '1', ELVION_CONSOLE_TEST: Buffer.from(JSON.stringify(config)).toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let helperError = ''; child.stderr.on('data', (chunk: Buffer) => { helperError += chunk.toString('utf8'); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows console test helper exceeded its timeout')); }, 75_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  if (helperError) throw new Error(`Windows console cancellation helper failed: ${helperError}`);
  return { ...result, stdout: await readFile(stdout, 'utf8'), stderr: await readFile(stderr, 'utf8') };
}
