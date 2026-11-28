// fork: taskbar battery levels (fork Issue #16). The top-most layered window the levels are drawn in,
// moved from inzone-auto-switch's TaskbarOverlayWindow to C# 5. Made and used on the UI thread.
// No frame, not on the taskbar or in Alt+Tab, never activated, clicks go through (WS_EX_TRANSPARENT).
// Coordinates are physical pixels: creating and moving the window run with the thread in Per-Monitor V2.
// Failures throw (Controller logs them and hides).
using System;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace BatteryHubTaskbar
{
    internal sealed class OverlayWindow : NativeWindow, IDisposable
    {
        private const int DefaultDpi = 96;

        // Sent to top-level windows when Explorer has (re)created the taskbar.
        private static readonly int TaskbarCreatedMessage = NativeMethods.RegisterWindowMessage("TaskbarCreated");

        private bool _disposed;

        /// <summary>WM_SETTINGCHANGE (a theme switch, among others). Raised on the UI thread.</summary>
        public event Action SettingsChanged;

        /// <summary>TaskbarCreated (Explorer restarted) or WM_DISPLAYCHANGE. Raised on the UI thread.</summary>
        public event Action TaskbarChanged;

        public OverlayWindow()
        {
            var parameters = new CreateParams
            {
                Caption = "Battery Hub taskbar levels",
                Style = NativeMethods.WS_POPUP,
                ExStyle = NativeMethods.WS_EX_LAYERED
                    | NativeMethods.WS_EX_TRANSPARENT
                    | NativeMethods.WS_EX_TOOLWINDOW
                    | NativeMethods.WS_EX_NOACTIVATE
                    | NativeMethods.WS_EX_TOPMOST,
                X = 0,
                Y = 0,
                Width = 1,
                Height = 1,
            };

            // A window's DPI awareness is the creating thread's.
            NativeMethods.WithPerMonitorDpi(() => CreateHandle(parameters));
        }

        public int Dpi
        {
            get
            {
                ThrowIfDisposed();
                var dpi = (int)NativeMethods.GetDpiForWindow(Handle);
                return dpi > 0 ? dpi : DefaultDpi;
            }
        }

        /// <summary>Shows image at bounds and puts the window back on top. image is only used during the call.</summary>
        public void ShowAt(Rectangle bounds, Bitmap image)
        {
            ThrowIfDisposed();
            NativeMethods.WithPerMonitorDpi(() =>
            {
                Draw(bounds.Location, image);
                if (!NativeMethods.SetWindowPos(
                        Handle,
                        NativeMethods.HWND_TOPMOST,
                        bounds.X,
                        bounds.Y,
                        image.Width,
                        image.Height,
                        NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "SetWindowPos failed");
                }
            });
        }

        public void Hide()
        {
            ThrowIfDisposed();
            // The return value says whether it was visible, not whether it failed.
            NativeMethods.ShowWindow(Handle, NativeMethods.SW_HIDE);
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            SettingsChanged = null;
            TaskbarChanged = null;
            DestroyHandle();
        }

        protected override void WndProc(ref Message m)
        {
            Action handler = null;
            if (m.Msg == NativeMethods.WM_SETTINGCHANGE)
            {
                handler = SettingsChanged;
            }
            else if (m.Msg == NativeMethods.WM_DISPLAYCHANGE || (TaskbarCreatedMessage != 0 && m.Msg == TaskbarCreatedMessage))
            {
                handler = TaskbarChanged;
            }

            if (handler != null)
            {
                try
                {
                    handler();
                }
                catch (Exception)
                {
                    // Don't let an exception out of the window procedure.
                }
            }

            base.WndProc(ref m);
        }

        /// <summary>Draws image (Format32bppPArgb) as the window's content at location, keeping its transparency.</summary>
        private void Draw(Point location, Bitmap image)
        {
            var screenDc = NativeMethods.GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero)
            {
                throw new Win32Exception("can't get the screen DC");
            }

            try
            {
                var memoryDc = NativeMethods.CreateCompatibleDC(screenDc);
                if (memoryDc == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "can't create a DC to draw in");
                }

                try
                {
                    var bitmap = image.GetHbitmap(Color.FromArgb(0));
                    try
                    {
                        var previous = NativeMethods.SelectObject(memoryDc, bitmap);
                        try
                        {
                            var destination = new NativeMethods.POINT { X = location.X, Y = location.Y };
                            var size = new NativeMethods.SIZE { cx = image.Width, cy = image.Height };
                            var source = new NativeMethods.POINT();
                            var blend = new NativeMethods.BLENDFUNCTION
                            {
                                BlendOp = NativeMethods.AC_SRC_OVER,
                                BlendFlags = 0,
                                SourceConstantAlpha = 255,
                                AlphaFormat = NativeMethods.AC_SRC_ALPHA,
                            };

                            if (!NativeMethods.UpdateLayeredWindow(
                                    Handle, screenDc, ref destination, ref size, memoryDc, ref source, 0, ref blend, NativeMethods.ULW_ALPHA))
                            {
                                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateLayeredWindow failed");
                            }
                        }
                        finally
                        {
                            NativeMethods.SelectObject(memoryDc, previous);
                        }
                    }
                    finally
                    {
                        NativeMethods.DeleteObject(bitmap);
                    }
                }
                finally
                {
                    NativeMethods.DeleteDC(memoryDc);
                }
            }
            finally
            {
                NativeMethods.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        private void ThrowIfDisposed()
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(GetType().Name);
            }
        }
    }
}
