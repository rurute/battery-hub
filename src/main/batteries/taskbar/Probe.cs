// fork: taskbar battery levels (fork Issue #16). Measures the main monitor's taskbar, the foreground
// window and the theme; moved from inzone-auto-switch's Win32TaskbarProbe to C# 5.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Automation = System.Windows.Automation;

namespace BatteryHubTaskbar
{
    /// <summary>
    /// Win32 and UI Automation. UI Automation can be slow, so Measure is called off the UI thread.
    /// Explorer recreates its windows when it restarts, so no handle is kept: every call looks them up
    /// again. All coordinates are physical pixels (the calling thread is Per-Monitor V2 while measuring).
    /// None of the methods throw.
    /// </summary>
    internal sealed class Probe
    {
        private const string TaskbarClass = "Shell_TrayWnd";
        private const string TrayClass = "TrayNotifyWnd";
        private const string AppButtonClass = "Taskbar.TaskListButtonAutomationPeer";
        private const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

        private static readonly HashSet<string> ShellClasses =
            new HashSet<string>(StringComparer.Ordinal) { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };

        /// <summary>The main monitor's taskbar; a failure goes into Error.</summary>
        public ProbeResult Measure()
        {
            try
            {
                return NativeMethods.WithPerMonitorDpi<ProbeResult>(MeasureCore);
            }
            catch (Exception ex)
            {
                return Fail("can't measure the taskbar (" + ex.GetType().Name + ": " + ex.Message + ")");
            }
        }

        /// <summary>True when the foreground window covers the main monitor.</summary>
        public bool IsFullscreenForeground()
        {
            try
            {
                return NativeMethods.WithPerMonitorDpi<bool>(IsFullscreenForegroundCore);
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>True when the taskbar uses the light theme; false when it can't be read.</summary>
        public bool IsLightTheme()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(PersonalizeKey))
                {
                    if (key == null)
                    {
                        return false;
                    }

                    var value = key.GetValue("SystemUsesLightTheme");
                    return value is int && (int)value != 0;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static ProbeResult MeasureCore()
        {
            var taskbar = NativeMethods.FindWindow(TaskbarClass, null);
            if (taskbar == IntPtr.Zero)
            {
                return Fail(TaskbarClass + " is not there");
            }

            NativeMethods.RECT taskbarRect;
            if (!NativeMethods.GetWindowRect(taskbar, out taskbarRect))
            {
                return Fail("can't get where " + TaskbarClass + " is");
            }

            var monitor = NativeMethods.MonitorFromWindow(taskbar, NativeMethods.MONITOR_DEFAULTTOPRIMARY);
            var monitorInfo = new NativeMethods.MONITORINFO { cbSize = Marshal.SizeOf(typeof(NativeMethods.MONITORINFO)) };
            if (monitor == IntPtr.Zero || !NativeMethods.GetMonitorInfo(monitor, ref monitorInfo))
            {
                return Fail("can't get the taskbar's monitor");
            }

            var tray = NativeMethods.FindWindowEx(taskbar, IntPtr.Zero, TrayClass, null);
            if (tray == IntPtr.Zero)
            {
                return Fail(TrayClass + " is not there");
            }

            NativeMethods.RECT trayRect;
            if (!NativeMethods.GetWindowRect(tray, out trayRect))
            {
                return Fail("can't get where " + TrayClass + " is");
            }

            var appsRight = FindAppsRight(taskbar);
            if (!appsRight.HasValue)
            {
                return Fail("the taskbar buttons are not there");
            }

            var snapshot = new TaskbarSnapshot(ToRectangle(taskbarRect), ToRectangle(monitorInfo.rcMonitor), trayRect.Left, appsRight.Value);
            return new ProbeResult(snapshot, null);
        }

        /// <summary>The right edge of the right-most app button (rounded up); null when there is none.</summary>
        private static int? FindAppsRight(IntPtr taskbar)
        {
            // Fetch the bounds in one go: asking button by button throws for a button that went away meanwhile.
            var cache = new Automation.CacheRequest { AutomationElementMode = Automation.AutomationElementMode.None };
            cache.Add(Automation.AutomationElement.BoundingRectangleProperty);
            var condition = new Automation.PropertyCondition(Automation.AutomationElement.ClassNameProperty, AppButtonClass);

            // Get the root outside the cache request; inside it, the root has no live reference and FindAll fails.
            var root = Automation.AutomationElement.FromHandle(taskbar);
            Automation.AutomationElementCollection buttons;
            using (cache.Activate())
            {
                buttons = root.FindAll(Automation.TreeScope.Descendants, condition);
            }

            int? right = null;
            foreach (Automation.AutomationElement button in buttons)
            {
                var bounds = button.Cached.BoundingRectangle;
                // A button that isn't on screen has an empty rectangle (Right is -infinity).
                if (bounds.IsEmpty || bounds.Width <= 0 || double.IsInfinity(bounds.Right) || double.IsNaN(bounds.Right))
                {
                    continue;
                }

                var value = (int)Math.Ceiling(bounds.Right);
                right = right.HasValue ? Math.Max(right.Value, value) : value;
            }

            return right;
        }

        private static bool IsFullscreenForegroundCore()
        {
            var foreground = NativeMethods.GetForegroundWindow();
            if (foreground == IntPtr.Zero)
            {
                return false;
            }

            var buffer = new char[256];
            var length = NativeMethods.GetClassName(foreground, buffer, buffer.Length);
            if (length > 0 && ShellClasses.Contains(new string(buffer, 0, length)))
            {
                return false;
            }

            NativeMethods.RECT windowRect;
            if (!NativeMethods.GetWindowRect(foreground, out windowRect))
            {
                return false;
            }

            // The main monitor holds the origin of the screen coordinates.
            var primary = NativeMethods.MonitorFromPoint(new NativeMethods.POINT(), NativeMethods.MONITOR_DEFAULTTOPRIMARY);
            var monitorInfo = new NativeMethods.MONITORINFO { cbSize = Marshal.SizeOf(typeof(NativeMethods.MONITORINFO)) };
            if (primary == IntPtr.Zero || !NativeMethods.GetMonitorInfo(primary, ref monitorInfo))
            {
                return false;
            }

            return ToRectangle(windowRect).Contains(ToRectangle(monitorInfo.rcMonitor));
        }

        private static ProbeResult Fail(string error)
        {
            return new ProbeResult(null, error);
        }

        private static Rectangle ToRectangle(NativeMethods.RECT rect)
        {
            return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        }
    }
}
