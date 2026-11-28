// fork: taskbar battery levels (fork Issue #16). Holds the last measurement and the devices, asks Policy
// and shows or hides the window; inzone-auto-switch's TaskbarOverlayController and TaskbarBatteryOverlay
// in one class, in C# 5. The exe only runs while the setting is on, so there is no enabled switch.
// Putting the window back on top (Tick) runs on a UI-thread timer every 300 ms; measuring (UI Automation
// included) runs on a thread-pool timer every second, skipped while the previous one is still going.
// Explorer restarting (TaskbarCreated) and display changes measure again at once; a settings change
// re-reads the theme. No public method throws, so a display failure never stops the exe reading lines.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading;

namespace BatteryHubTaskbar
{
    internal sealed class Controller : IDisposable
    {
        private const int TickIntervalMs = 300;
        private const int MeasureIntervalMs = 1000;
        private const string UnexpectedErrorPrefix = "Taskbar levels: unexpected error: ";

        private sealed class MeasureState
        {
            public MeasureState(ProbeResult result, bool fullscreen)
            {
                Result = result;
                Fullscreen = fullscreen;
            }

            public ProbeResult Result { get; private set; }
            public bool Fullscreen { get; private set; }
        }

        private readonly Action<string, string> _log;
        private readonly IconSet _icons;
        private readonly Probe _probe;
        private readonly OverlayWindow _window;
        private readonly Policy _policy;
        private readonly System.Windows.Forms.Timer _tickTimer;
        private readonly System.Threading.Timer _measureTimer;
        private readonly object _errorGate = new object();

        // Written by the measuring thread, read by the UI thread. null until the first measurement.
        private volatile MeasureState _measured;
        private volatile bool _themeStale = true;
        private volatile bool _disposed;
        private int _measuring; // 1 while measuring

        // UI thread only from here on.
        private List<OverlayItem> _items = new List<OverlayItem>();
        private bool _lightTheme;
        private Bitmap _image;
        private List<OverlayItem> _imageItems;
        private bool _imageLightTheme;
        private int _imageDpi;
        private string _lastError;

        private Controller(Action<string, string> log, IconSet icons, OverlayWindow window)
        {
            _log = log;
            _icons = icons;
            _probe = new Probe();
            _window = window;
            _policy = new Policy(log);
            _tickTimer = new System.Windows.Forms.Timer { Interval = TickIntervalMs };
            _measureTimer = new System.Threading.Timer(OnMeasure, null, Timeout.Infinite, Timeout.Infinite);
            _tickTimer.Tick += OnTick;
            _window.SettingsChanged += OnSettingsChanged;
            _window.TaskbarChanged += OnTaskbarChanged;
        }

        /// <summary>Call on the UI thread. Starts measuring at once. null (after one ERROR) when it can't be made.</summary>
        public static Controller TryCreate(Action<string, string> log, IconSet icons)
        {
            OverlayWindow window = null;
            try
            {
                window = new OverlayWindow();
                var controller = new Controller(log, icons, window);
                controller._measureTimer.Change(0, MeasureIntervalMs);
                controller._tickTimer.Start();
                return controller;
            }
            catch (Exception ex)
            {
                if (window != null)
                {
                    try { window.Dispose(); } catch (Exception) { }
                }

                try { log("ERROR", "Can't start the taskbar levels: " + ex.GetType().Name + ": " + ex.Message); } catch (Exception) { }
                return null;
            }
        }

        /// <summary>UI thread. The devices to show from now on (empty hides); updates the window at once.</summary>
        public void SetItems(List<OverlayItem> items)
        {
            if (_disposed)
            {
                return;
            }

            _items = items ?? new List<OverlayItem>();
            Tick();
        }

        /// <summary>UI thread. Decides from the last measurement and the devices; when shown, puts it back on top.</summary>
        public void Tick()
        {
            if (_disposed)
            {
                return;
            }

            try
            {
                var items = _items;
                var measured = _measured;

                // Not measured yet: the position isn't known to be wrong, so hide without a WARN.
                if (items.Count > 0 && measured == null)
                {
                    _window.Hide();
                    return;
                }

                var dpi = _window.Dpi;
                var image = items.Count > 0 ? EnsureImage(items, dpi) : null;
                var decision = _policy.Evaluate(
                    items.Count,
                    measured == null ? null : measured.Result,
                    measured != null && measured.Fullscreen,
                    image == null ? Size.Empty : image.Size,
                    dpi);
                if (decision.Bounds.HasValue && image != null)
                {
                    _window.ShowAt(decision.Bounds.Value, image);
                }
                else
                {
                    _window.Hide();
                }
            }
            catch (Exception ex)
            {
                Fail(ex, true);
            }
        }

        /// <summary>UI thread. Stops the timers, hides and destroys the window.</summary>
        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _tickTimer.Tick -= OnTick;
            try { _tickTimer.Dispose(); } catch (Exception) { }
            try { _measureTimer.Dispose(); } catch (Exception) { }
            try { _window.Hide(); } catch (Exception) { }
            try { _window.Dispose(); } catch (Exception) { }
            if (_image != null)
            {
                try { _image.Dispose(); } catch (Exception) { }
                _image = null;
            }
        }

        private void OnTick(object sender, EventArgs e)
        {
            Tick();
        }

        private void OnSettingsChanged()
        {
            _themeStale = true;
        }

        // Explorer restarted or the display changed: measure now instead of waiting up to a second.
        private void OnTaskbarChanged()
        {
            if (_disposed)
            {
                return;
            }

            try
            {
                _measureTimer.Change(0, MeasureIntervalMs);
            }
            catch (Exception ex)
            {
                Fail(ex, false);
            }
        }

        // On the thread pool. An exception out of here would end the process, so all are caught.
        private void OnMeasure(object state)
        {
            if (_disposed || Interlocked.Exchange(ref _measuring, 1) == 1)
            {
                return;
            }

            try
            {
                ProbeResult result;
                try
                {
                    result = _probe.Measure();
                }
                catch (Exception ex)
                {
                    result = new ProbeResult(null, ex.Message);
                }

                bool fullscreen;
                try
                {
                    fullscreen = _probe.IsFullscreenForeground();
                }
                catch (Exception)
                {
                    fullscreen = false;
                }

                // A failed measurement replaces an earlier good one too.
                _measured = new MeasureState(result, fullscreen);
            }
            catch (Exception ex)
            {
                // Don't touch the window from here; the next Tick hides it.
                Fail(ex, false);
                _measured = new MeasureState(new ProbeResult(null, ex.Message), false);
            }
            finally
            {
                Interlocked.Exchange(ref _measuring, 0);
            }
        }

        // Draws again only when the devices, the theme or the dpi changed.
        private Bitmap EnsureImage(List<OverlayItem> items, int dpi)
        {
            if (_themeStale)
            {
                _themeStale = false;
                _lightTheme = _probe.IsLightTheme();
            }

            if (_image != null && _imageLightTheme == _lightTheme && _imageDpi == dpi && SameItems(_imageItems, items))
            {
                return _image;
            }

            var image = Renderer.Render(items, _lightTheme, dpi, _icons);
            if (_image != null)
            {
                _image.Dispose();
            }

            _image = image;
            _imageItems = items;
            _imageLightTheme = _lightTheme;
            _imageDpi = dpi;
            return image;
        }

        private static bool SameItems(List<OverlayItem> a, List<OverlayItem> b)
        {
            if (ReferenceEquals(a, b))
            {
                return true;
            }

            if (a == null || b == null || a.Count != b.Count)
            {
                return false;
            }

            for (var i = 0; i < a.Count; i++)
            {
                if (a[i].Icon != b[i].Icon || a[i].Level != b[i].Level || a[i].Charging != b[i].Charging || a[i].Low != b[i].Low)
                {
                    return false;
                }
            }

            return true;
        }

        // Writes one ERROR per distinct message (not the same one every 300 ms), then hides if asked.
        private void Fail(Exception ex, bool hide)
        {
            try
            {
                var message = UnexpectedErrorPrefix + ex.GetType().Name + ": " + ex.Message;
                bool write;
                lock (_errorGate)
                {
                    write = message != _lastError;
                    _lastError = message;
                }

                if (write)
                {
                    _log("ERROR", message);
                }
            }
            catch (Exception)
            {
            }

            if (!hide)
            {
                return;
            }

            try
            {
                _window.Hide();
            }
            catch (Exception)
            {
            }
        }
    }
}
