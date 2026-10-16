$source = @'
using System;
using System.Runtime.InteropServices;

public static class TaskbarLocationMonitor
{
    private const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    private const uint WINEVENT_OUTOFCONTEXT = 0;
    private const uint WM_POWERBROADCAST = 0x0218;
    private const uint PBT_POWERSETTINGCHANGE = 0x8013;
    private const int OBJID_WINDOW = 0;
    private const int CHILDID_SELF = 0;
    private const int DEVICE_NOTIFY_WINDOW_HANDLE = 0;
    private const int HWND_MESSAGE = -3;
    private const string POWER_WINDOW_CLASS = "PetTaskbarPowerMonitor";
    private static readonly Guid CONSOLE_DISPLAY_STATE =
        new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");
    private static readonly Guid SESSION_DISPLAY_STATUS =
        new Guid("2B84C20E-AD23-4DDf-93DB-05FFBD7EFCA5");

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr Hwnd;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public uint Size;
        public uint Style;
        public WndProcDelegate WindowProc;
        public int ClassExtra;
        public int WindowExtra;
        public IntPtr Instance;
        public IntPtr Icon;
        public IntPtr Cursor;
        public IntPtr Background;
        public string MenuName;
        public string ClassName;
        public IntPtr SmallIcon;
    }

    private delegate void WinEventDelegate(
        IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild,
        uint eventThread, uint eventTime);
    private delegate IntPtr WndProcDelegate(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    private static WinEventDelegate callback = OnWinEvent;
    private static WndProcDelegate windowProc = OnWindowMessage;
    private static IntPtr hook;
    private static IntPtr taskbarWindow;
    private static IntPtr powerWindow;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(
        uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback,
        uint processId, uint threadId, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX windowClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(
        uint extendedStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu,
        IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr RegisterPowerSettingNotification(
        IntPtr recipient, ref Guid settingGuid, int flags);

    [DllImport("user32.dll")]
    private static extern IntPtr DefWindowProc(
        IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    private static void RegisterPowerWindow()
    {
        IntPtr instance = GetModuleHandle(null);
        WNDCLASSEX windowClass = new WNDCLASSEX();
        windowClass.Size = (uint)Marshal.SizeOf(typeof(WNDCLASSEX));
        windowClass.WindowProc = windowProc;
        windowClass.Instance = instance;
        windowClass.ClassName = POWER_WINDOW_CLASS;

        if (RegisterClassEx(ref windowClass) == 0)
        {
            throw new InvalidOperationException("Could not register the power notification window.");
        }

        powerWindow = CreateWindowEx(
            0, POWER_WINDOW_CLASS, "", 0, 0, 0, 0, 0,
            new IntPtr(HWND_MESSAGE), IntPtr.Zero, instance, IntPtr.Zero);
        if (powerWindow == IntPtr.Zero)
        {
            throw new InvalidOperationException("Could not create the power notification window.");
        }

        Guid consoleDisplayState = CONSOLE_DISPLAY_STATE;
        Guid sessionDisplayStatus = SESSION_DISPLAY_STATUS;
        if (RegisterPowerSettingNotification(powerWindow, ref consoleDisplayState, DEVICE_NOTIFY_WINDOW_HANDLE) == IntPtr.Zero ||
            RegisterPowerSettingNotification(powerWindow, ref sessionDisplayStatus, DEVICE_NOTIFY_WINDOW_HANDLE) == IntPtr.Zero)
        {
            throw new InvalidOperationException("Could not register display power notifications.");
        }
    }

    private static IntPtr OnWindowMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == WM_POWERBROADCAST && wParam.ToInt64() == PBT_POWERSETTINGCHANGE && lParam != IntPtr.Zero)
        {
            Guid settingGuid = (Guid)Marshal.PtrToStructure(lParam, typeof(Guid));
            if (settingGuid == CONSOLE_DISPLAY_STATE || settingGuid == SESSION_DISPLAY_STATUS)
            {
                int state = Marshal.ReadInt32(lParam, 20);
                Console.WriteLine("DISPLAY,{0}", state);
                Console.Out.Flush();
            }
            return new IntPtr(1);
        }

        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    private static void WriteBounds(IntPtr hwnd)
    {
        RECT rect;
        if (GetWindowRect(hwnd, out rect))
        {
            Console.WriteLine("{0},{1},{2},{3}", rect.Left, rect.Top, rect.Right, rect.Bottom);
            Console.Out.Flush();
        }
    }

    private static void OnWinEvent(
        IntPtr eventHook, uint eventType, IntPtr hwnd, int idObject, int idChild,
        uint eventThread, uint eventTime)
    {
        if (
            hwnd == taskbarWindow &&
            idObject == OBJID_WINDOW &&
            idChild == CHILDID_SELF
        )
        {
            WriteBounds(hwnd);
        }
    }

    public static void Run()
    {
        taskbarWindow = FindWindow("Shell_TrayWnd", null);
        if (taskbarWindow == IntPtr.Zero)
        {
            throw new InvalidOperationException("Could not find the Windows taskbar window.");
        }

        hook = SetWinEventHook(
            EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE,
            IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT);
        if (hook == IntPtr.Zero)
        {
            throw new InvalidOperationException("Could not register the taskbar location hook.");
        }

        RegisterPowerWindow();
        WriteBounds(taskbarWindow);
        MSG message;
        int result;
        while ((result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }

        if (result == -1)
        {
            throw new InvalidOperationException("The taskbar location event loop failed.");
        }
    }
}
'@

Add-Type -TypeDefinition $source
[TaskbarLocationMonitor]::Run()
