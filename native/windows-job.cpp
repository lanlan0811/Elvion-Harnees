// MIT. A command has one non-inheritable Job. EOF on control stdin cancels it.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>
#include <cstdio>

static std::wstring quote(const std::wstring& input) {
  std::wstring result = L"\""; unsigned slashes = 0;
  for (wchar_t c : input) {
    if (c == L'\\') { ++slashes; continue; }
    if (c == L'\"') { result.append(slashes * 2 + 1, L'\\'); result += c; slashes = 0; continue; }
    result.append(slashes, L'\\'); slashes = 0; result += c;
  }
  result.append(slashes * 2, L'\\'); return result + L"\"";
}
static DWORD WINAPI control(void* pointer) {
  char buffer[64]; DWORD read = 0; HANDLE job = static_cast<HANDLE>(pointer);
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &read, nullptr) && read) {}
  TerminateJobObject(job, 130); return 0;
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 7 || std::wstring(argv[1]) != L"--bash" || std::wstring(argv[3]) != L"--cwd" || std::wstring(argv[5]) != L"--command") return 125;
  HANDLE job = CreateJobObjectW(nullptr, nullptr); if (!job) return 125;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { CloseHandle(job); return 125; }
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE nullInput = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  if (nullInput == INVALID_HANDLE_VALUE) { CloseHandle(job); return 125; }
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = nullInput; startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  // The Bash child must not inherit the control pipe: EOF belongs to this launcher.
  SetHandleInformation(GetStdHandle(STD_INPUT_HANDLE), HANDLE_FLAG_INHERIT, 0);
  std::wstring command = quote(argv[2]) + L" --noprofile --norc -c " + quote(argv[6]);
  std::vector<wchar_t> mutableCommand(command.begin(), command.end()); mutableCommand.push_back(0);
  PROCESS_INFORMATION process{};
  BOOL created = CreateProcessW(argv[2], mutableCommand.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, argv[4], &startup, &process);
  CloseHandle(nullInput);
  if (!created) { std::fprintf(stderr, "CreateProcessW failed: %lu\n", GetLastError()); CloseHandle(job); return 125; }
  if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateProcess(process.hProcess, 125); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); return 125; }
  HANDLE monitor = CreateThread(nullptr, 0, control, job, 0, nullptr);
  if (!monitor) { TerminateJobObject(job, 125); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); return 125; }
  ResumeThread(process.hThread); CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE); DWORD exitCode = 125; GetExitCodeProcess(process.hProcess, &exitCode);
  // Also clean ordinary background children after their shell has exited.
  TerminateJobObject(job, exitCode); CloseHandle(process.hProcess); CloseHandle(job); CloseHandle(monitor);
  ExitProcess(exitCode);
}
