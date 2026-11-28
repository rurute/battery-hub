// fork: taskbar battery levels (fork Issue #16). Where the overlay goes and whether to show it,
// moved from inzone-auto-switch's TaskbarOverlayPolicy to C# 5. Instead of "enabled" and "level",
// an empty device list hides it (NoItems).
using System;
using System.Drawing;

namespace BatteryHubTaskbar
{
    /// <summary>
    /// What the taskbar measured. All coordinates are physical screen pixels. TrayLeft is the left edge
    /// of the tray (TrayNotifyWnd); AppsRight is the right edge of the right-most app button.
    /// </summary>
    internal sealed class TaskbarSnapshot
    {
        public TaskbarSnapshot(Rectangle taskbar, Rectangle monitor, int trayLeft, int appsRight)
        {
            Taskbar = taskbar;
            Monitor = monitor;
            TrayLeft = trayLeft;
            AppsRight = appsRight;
        }

        public Rectangle Taskbar { get; private set; }
        public Rectangle Monitor { get; private set; }
        public int TrayLeft { get; private set; }
        public int AppsRight { get; private set; }
    }

    /// <summary>A measurement: either Snapshot or Error is set.</summary>
    internal sealed class ProbeResult
    {
        public ProbeResult(TaskbarSnapshot snapshot, string error)
        {
            Snapshot = snapshot;
            Error = error;
        }

        public TaskbarSnapshot Snapshot { get; private set; }
        public string Error { get; private set; }
    }

    internal enum HideReason { None, NoItems, TaskbarUnavailable, TaskbarHidden, Fullscreen, NoSpace }

    /// <summary>To show: Bounds holds the place and size. To hide: Bounds is null and Reason says why.</summary>
    internal sealed class Decision
    {
        public Decision(Rectangle? bounds, HideReason reason)
        {
            Bounds = bounds;
            Reason = reason;
        }

        public Rectangle? Bounds { get; private set; }
        public HideReason Reason { get; private set; }
    }

    /// <summary>
    /// When it can't be shown because the taskbar's position is unknown or there is no room, writes one
    /// WARN; when it can be shown again, one INFO. Other reasons (auto-hide, full screen) write nothing
    /// and leave the warned state alone. Called from the UI thread only, so no locking.
    /// </summary>
    internal sealed class Policy
    {
        private const int MarginAt96 = 4;
        private const int GapAt96 = 8;
        private const string NoSpaceMessage = "overlaps the taskbar buttons";
        private const string UnknownErrorMessage = "the taskbar's position is unknown";

        private readonly Action<string, string> _log;
        private bool _warned;

        /// <param name="log">Gets (level, message); level is "WARN" or "INFO".</param>
        public Policy(Action<string, string> log)
        {
            _log = log;
        }

        public Decision Evaluate(int itemCount, ProbeResult probe, bool fullscreen, Size overlaySize, int dpi)
        {
            if (itemCount <= 0)
            {
                return Hide(HideReason.NoItems);
            }

            var snapshot = probe == null ? null : probe.Snapshot;
            if (snapshot == null)
            {
                var error = probe == null || string.IsNullOrEmpty(probe.Error) ? UnknownErrorMessage : probe.Error;
                WarnOnce(error);
                return Hide(HideReason.TaskbarUnavailable);
            }

            var taskbar = snapshot.Taskbar;
            if (Rectangle.Intersect(taskbar, snapshot.Monitor).Height < taskbar.Height - 2)
            {
                return Hide(HideReason.TaskbarHidden);
            }

            if (fullscreen)
            {
                return Hide(HideReason.Fullscreen);
            }

            var margin = MarginAt96 * dpi / 96;
            var gap = GapAt96 * dpi / 96;
            var x = snapshot.TrayLeft - margin - overlaySize.Width;
            var y = taskbar.Top + (taskbar.Height - overlaySize.Height) / 2;
            if (x < snapshot.AppsRight + gap)
            {
                WarnOnce(NoSpaceMessage);
                return Hide(HideReason.NoSpace);
            }

            if (_warned)
            {
                _warned = false;
                _log("INFO", "Taskbar levels can be shown again.");
            }

            return new Decision(new Rectangle(x, y, overlaySize.Width, overlaySize.Height), HideReason.None);
        }

        private void WarnOnce(string reason)
        {
            if (_warned)
            {
                return;
            }

            _warned = true;
            _log("WARN", "Can't show taskbar levels: " + reason);
        }

        private static Decision Hide(HideReason reason)
        {
            return new Decision(null, reason);
        }
    }
}
