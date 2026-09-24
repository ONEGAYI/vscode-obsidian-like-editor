# 在当前交互式 Windows Station 中创建不显示的桌面，并在其中运行真实测试宿主。
# CreateProcess 的 lpDesktop 是关键：窗口属于这个桌面，不能遮挡当前桌面。
param([Parameter(Mandatory = $true)][string]$ConfigBase64)

$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class HiddenDesktopHost {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr attributes);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment,
        string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
        out IntPtr targetHandle, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindow callback, IntPtr data);
    delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    static IntPtr InheritableStdHandle(int kind) {
        IntPtr result;
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(),
                out result, 0, true, 2)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return result;
    }
    static string Quote(string arg) {
        var b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in arg) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
            b.Append('\\', slashes); slashes = 0; b.Append(ch);
        }
        b.Append('\\', slashes * 2); b.Append('"');
        return b.ToString();
    }
    static uint ForegroundPid() {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
    public static int Run(string executable, string[] args, string cwd, string mode, int parentPid) {
        if (mode != "desktop" && mode != "foreground") throw new ArgumentException("Unknown host mode: " + mode);
        string name = "VsidianTest-" + Guid.NewGuid().ToString("N");
        IntPtr desktop = IntPtr.Zero, job = IntPtr.Zero, parent = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool assigned = false;
        try {
            if (mode == "desktop") {
                desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
                if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop failed");
            }
            parent = OpenProcess(0x00100000, false, unchecked((uint)parentPid)); // SYNCHRONIZE
            if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess(parent) failed");
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            input = InheritableStdHandle(-10);
            output = InheritableStdHandle(-11);
            error = InheritableStdHandle(-12);
            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            if (mode == "desktop") startup.lpDesktop = "WinSta0\\" + name;
            startup.dwFlags = 0x100; // STARTF_USESTDHANDLES
            startup.hStdInput = input;
            startup.hStdOutput = output;
            startup.hStdError = error;
            string command = Quote(executable);
            foreach (string arg in args) command += " " + Quote(arg);
            uint foregroundBefore = ForegroundPid();
            if (!CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                    true, 0x00000004, IntPtr.Zero, cwd, ref startup, out process)) // CREATE_SUSPENDED
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            assigned = true;
            if (ResumeThread(process.hThread) == 0xFFFFFFFF)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            // 启动器契约测试的受控故障：等到子进程 marker 写入后抛错，验证 finally 关闭 job。
            string faultMarker = Environment.GetEnvironmentVariable("VSIDIAN_TEST_HOST_FAULT_MARKER");
            if (!String.IsNullOrEmpty(faultMarker)) {
                DateTime until = DateTime.UtcNow.AddSeconds(2);
                while (!File.Exists(faultMarker) && DateTime.UtcNow < until)
                    if (WaitForSingleObject(process.hProcess, 50) == 0) break;
                throw new InvalidOperationException("fault after CreateProcess (test probe)");
            }
            Console.Error.WriteLine("[testHost] {0}，宿主 PID {1}，启动前前台 PID {2}",
                mode == "desktop" ? "独立桌面 " + name : "当前桌面", process.dwProcessId, foregroundBefore);
            int maxWindows = 0;
            var foregroundPids = new HashSet<uint>();
            foregroundPids.Add(foregroundBefore);
            var handles = new IntPtr[] { process.hProcess, parent };
            while (true) {
                uint wait = WaitForMultipleObjects(2, handles, false, 500);
                if (wait == 0) break; // 宿主退出
                if (wait == 1) throw new OperationCanceledException("父启动器已退出");
                if (wait != 0x102) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForMultipleObjects failed");
                foregroundPids.Add(ForegroundPid());
                int count = 0;
                if (desktop != IntPtr.Zero)
                    EnumDesktopWindows(desktop, (window, data) => { if (IsWindowVisible(window)) count++; return true; }, IntPtr.Zero);
                if (count > maxWindows) maxWindows = count;
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint foregroundAfter = ForegroundPid();
            foregroundPids.Add(foregroundAfter);
            Console.Error.WriteLine("[testHost] 测试桌面可见窗口峰值 {0}；观察期间前台 PID {1}；结束时前台 PID {2}；宿主退出码 {3}",
                maxWindows, String.Join(",", foregroundPids), foregroundAfter, exitCode);
            return unchecked((int)exitCode);
        } finally {
            // 最后一个 job 句柄关闭时，系统只结束本次作业中的宿主及子进程。
            // Assign 失败时进程尚在暂停态，需单独结束这个尚未入 job 的进程。
            if (!assigned && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (parent != IntPtr.Zero) CloseHandle(parent);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
        }
    }
}
'@

try {
    $code = [HiddenDesktopHost]::Run($config.executable, [string[]]$config.args, $config.cwd, $config.mode, $config.parentPid)
    exit $code
} catch {
    [Console]::Error.WriteLine("[testHost] 独立桌面启动失败：$($_.Exception.ToString())")
    exit 1
}
