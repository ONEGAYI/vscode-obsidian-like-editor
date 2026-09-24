# 在当前交互式 Windows Station 中创建不显示的桌面，并在其中运行真实测试宿主。
# CreateProcess 的 lpDesktop 是关键：窗口属于这个桌面，不能遮挡当前桌面。
param([Parameter(Mandatory = $true)][string]$ConfigBase64)

$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
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
    public static int Run(string executable, string[] args, string cwd) {
        string name = "VsidianTest-" + Guid.NewGuid().ToString("N");
        IntPtr desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop failed");
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try {
            input = InheritableStdHandle(-10);
            output = InheritableStdHandle(-11);
            error = InheritableStdHandle(-12);
            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.lpDesktop = "WinSta0\\" + name;
            startup.dwFlags = 0x100; // STARTF_USESTDHANDLES
            startup.hStdInput = input;
            startup.hStdOutput = output;
            startup.hStdError = error;
            string command = Quote(executable);
            foreach (string arg in args) command += " " + Quote(arg);
            uint foregroundBefore = ForegroundPid();
            if (!CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                    true, 0, IntPtr.Zero, cwd, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            Console.Error.WriteLine("[testHost] 独立桌面 {0}，宿主 PID {1}，启动前前台 PID {2}", name, process.dwProcessId, foregroundBefore);
            int maxWindows = 0;
            var foregroundPids = new HashSet<uint>();
            foregroundPids.Add(foregroundBefore);
            while (WaitForSingleObject(process.hProcess, 500) == 0x102) {
                foregroundPids.Add(ForegroundPid());
                int count = 0;
                EnumDesktopWindows(desktop, (window, data) => { if (IsWindowVisible(window)) count++; return true; }, IntPtr.Zero);
                if (count > maxWindows) maxWindows = count;
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint foregroundAfter = ForegroundPid();
            foregroundPids.Add(foregroundAfter);
            Console.Error.WriteLine("[testHost] 独立桌面可见窗口峰值 {0}；观察期间前台 PID {1}；结束时前台 PID {2}；宿主退出码 {3}",
                maxWindows, String.Join(",", foregroundPids), foregroundAfter, exitCode);
            return unchecked((int)exitCode);
        } finally {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            CloseDesktop(desktop);
        }
    }
}
'@

try {
    $code = [HiddenDesktopHost]::Run($config.executable, [string[]]$config.args, $config.cwd)
    exit $code
} catch {
    [Console]::Error.WriteLine("[testHost] 独立桌面启动失败：$($_.Exception.ToString())")
    exit 1
}
