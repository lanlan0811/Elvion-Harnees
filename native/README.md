# Windows command supervisor

`windows-job.cpp` is a small MIT-licensed executable built on the release runner.
It creates Bash suspended, places it inside a non-breakaway Job Object, and only
then resumes it. `KILL_ON_JOB_CLOSE` covers ordinary inherited child processes.
The parent's stdin pipe is a control channel: EOF means cancel. Bash receives NUL
as its noninteractive input and cannot inherit the control pipe. The parent owns
that pipe and closes it on cancellation, timeout, process exit or crash.

Build with `powershell -File scripts/build-launcher.ps1 -Architecture x64` from a
machine with Visual Studio C++ tools. Consumers receive the executable; they do
not compile it and do not run installation scripts. `arm64` uses the cross tools.

This is process lifecycle management, not a security sandbox. Commands can run
with the user's OS permissions. Programs deliberately delegating work to system
services are outside the ordinary descendant cleanup guarantee.
