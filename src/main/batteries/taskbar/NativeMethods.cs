// fork: taskbar battery levels (fork Issue #16). The Win32 calls that Probe and OverlayWindow use,
// moved from inzone-auto-switch's NativeMethods to C# 5.
using System;
using System.Runtime.InteropServices;

namespace BatteryHubTaskbar
{
    internal static class NativeMethods
    {
        internal const uint MONITOR_DEFAULTTOPRIMARY = 1;

        /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: coordinates come in physical pixels.</summary>
        internal static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        internal const int WS_POPUP = unchecked((int)0x80000000);
        internal const int WS_EX_TOPMOST = 0x00000008;
        internal const int WS_EX_TRANSPARENT = 0x00000020;
        internal const int WS_EX_TOOLWINDOW = 0x00000080;
        internal const int WS_EX_LAYERED = 0x00080000;
        internal const int WS_EX_NOACTIVATE = 0x08000000;
        internal const int WM_SETTINGCHANGE = 0x001A;
        internal const int WM_DISPLAYCHANGE = 0x007E;
        internal const int SW_HIDE = 0;
        internal const uint SWP_NOACTIVATE = 0x0010;
        internal const uint SWP_SHOWWINDOW = 0x0040;
        internal const uint ULW_ALPHA = 0x00000002;
        internal const byte AC_SRC_OVER = 0x00;
        internal const byte AC_SRC_ALPHA = 0x01;
        internal static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SIZE
        {
            public int cx;
            public int cy;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        internal struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        internal static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

        [DllImport("user32.dll")]
        internal static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int GetClassName(IntPtr hwnd, char[] className, int maxCount);

        /// <summary>Switches the calling thread's DPI awareness and returns the old one; IntPtr.Zero on failure.</summary>
        [DllImport("user32.dll")]
        internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("user32.dll")]
        internal static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern int RegisterWindowMessage(string message);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ShowWindow(IntPtr hwnd, int command);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateLayeredWindow(
            IntPtr hwnd,
            IntPtr destinationDc,
            ref POINT destinationPoint,
            ref SIZE size,
            IntPtr sourceDc,
            ref POINT sourcePoint,
            int colorKey,
            ref BLENDFUNCTION blend,
            uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr GetDC(IntPtr hwnd);

        [DllImport("user32.dll")]
        internal static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

        [DllImport("gdi32.dll", SetLastError = true)]
        internal static extern IntPtr CreateCompatibleDC(IntPtr dc);

        [DllImport("gdi32.dll")]
        internal static extern IntPtr SelectObject(IntPtr dc, IntPtr gdiObject);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DeleteObject(IntPtr gdiObject);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DeleteDC(IntPtr dc);

        /// <summary>
        /// Runs action with the calling thread's DPI awareness set to Per-Monitor V2, then puts the old one
        /// back. Throws when it can't switch or switch back (the coordinates would not be physical pixels).
        /// </summary>
        internal static T WithPerMonitorDpi<T>(Func<T> action)
        {
            var previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            if (previous == IntPtr.Zero)
            {
                throw new InvalidOperationException("can't switch the thread's DPI awareness");
            }

            T result;
            bool restored;
            try
            {
                result = action();
            }
            finally
            {
                restored = SetThreadDpiAwarenessContext(previous) != IntPtr.Zero;
            }

            if (!restored)
            {
                throw new InvalidOperationException("can't restore the thread's DPI awareness");
            }

            return result;
        }

        internal static void WithPerMonitorDpi(Action action)
        {
            WithPerMonitorDpi<bool>(() =>
            {
                action();
                return true;
            });
        }
    }
}
