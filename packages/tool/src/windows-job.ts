/** Fixed trusted launcher. Target executable and argv are data in an environment variable.
 * A Windows Job Object is attached before the target thread is resumed. Closing the
 * supervisor therefore kills descendants atomically, including Git Bash children. */
export const WINDOWS_JOB_READY = '__ELVION_JOB_READY_8edeb23e__';
export const windowsJobScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ElvionJob {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long a,b; public uint LimitFlags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr a,b,c,d; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string reserved, desktop, title; public uint x,y,w,h,cx,cy,fill,flags; public ushort show, reserved2; public IntPtr bytes, input, output, error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr process, thread; public uint processId, threadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMIT limits, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESSINFO info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string executable, string command, string directory) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    PROCESSINFO info = new PROCESSINFO();
    try {
      EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.Basic.LimitFlags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw new System.ComponentModel.Win32Exception();
      STARTUPINFO start = new STARTUPINFO(); start.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)); start.flags = 0x100;
      start.input=GetStdHandle(-10); start.output=GetStdHandle(-11); start.error=GetStdHandle(-12);
      if (!CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref start, out info)) throw new System.ComponentModel.Win32Exception();
      if (!AssignProcessToJobObject(job, info.process)) { TerminateProcess(info.process, 1); throw new System.ComponentModel.Win32Exception(); }
      Console.Error.Write("__ELVION_JOB_READY_8edeb23e__"); Console.Error.Flush();
      if (ResumeThread(info.thread) == 0xffffffff) { TerminateProcess(info.process, 1); throw new System.ComponentModel.Win32Exception(); }
      WaitForSingleObject(info.process, 0xffffffff); uint code;
      if (!GetExitCodeProcess(info.process, out code)) throw new System.ComponentModel.Win32Exception();
      return unchecked((int)code);
    } finally {
      if (info.thread != IntPtr.Zero) CloseHandle(info.thread);
      if (info.process != IntPtr.Zero) CloseHandle(info.process);
      CloseHandle(job);
    }
  }
}
'@
try {
  Add-Type -TypeDefinition $source -Language CSharp
  $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ELVION_PROCESS_CONFIG)) | ConvertFrom-Json
  Remove-Item Env:ELVION_PROCESS_CONFIG
  exit [ElvionJob]::Run($config.executable, $config.commandLine, $config.cwd)
} catch {
  [Console]::Error.WriteLine('Elvion Windows process supervision failed: ' + $_.Exception.Message)
  exit 125
}
`;

/** CommandLineToArgvW-compatible escaping; no shell interprets this string. */
export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
