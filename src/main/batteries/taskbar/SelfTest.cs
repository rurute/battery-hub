// fork: taskbar battery levels (fork Issue #16). `taskbar-battery.exe --self-test` runs this table and
// prints "PASS <count>", or one "FAIL <name>: <reason>" line per failing case; the exit code is 0 / 1.
// The Policy cases are inzone-auto-switch's TaskbarOverlayPolicyTests, with the same inputs and
// expectations (Disabled_Hides is dropped; NoLevel_Hides became NoItems_Hides). The Renderer cases follow
// inzone-auto-switch's BatteryOverlayRendererTests and look at the bitmap's real pixels; they use the
// icons in --assets (assets/taskbar).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;

namespace BatteryHubTaskbar
{
    internal static class SelfTest
    {
        // Close to the author's screen: 3440x1440 at 100%, taskbar at the bottom.
        private static readonly Rectangle Monitor = new Rectangle(0, 0, 3440, 1440);
        private static readonly Rectangle Taskbar = new Rectangle(0, 1392, 3440, 48);
        private const int TrayLeft = 3183;
        private const int AppsRight = 2029;
        private static readonly Size Overlay = new Size(72, 32);
        private const int Dpi = 96;

        private sealed class Failure : Exception
        {
            public Failure(string message) : base(message) { }
        }

        private sealed class LogEntry
        {
            public string Level;
            public string Message;
        }

        private sealed class Recorder
        {
            public readonly List<LogEntry> Entries = new List<LogEntry>();

            public void Write(string level, string message)
            {
                Entries.Add(new LogEntry { Level = level, Message = message });
            }

            public int Count(string level)
            {
                var n = 0;
                foreach (var e in Entries)
                {
                    if (e.Level == level) n++;
                }
                return n;
            }
        }

        public static int Run(string assetsDir)
        {
            var cases = new List<KeyValuePair<string, Action>>();
            Action<string, Action> add = (name, body) => cases.Add(new KeyValuePair<string, Action>(name, body));

            add("Normal_PlacesLeftOfTrayCentered", Normal_PlacesLeftOfTrayCentered);
            add("NoItems_Hides", NoItems_Hides);
            add("NullProbe_HidesAsUnavailable", NullProbe_HidesAsUnavailable);
            add("ProbeError_HidesAndWarnsOnce", ProbeError_HidesAndWarnsOnce);
            add("RecoversAfterError_ShowsAndInfoOnce", RecoversAfterError_ShowsAndInfoOnce);
            add("NoSpace_HidesAndWarnsOnce", NoSpace_HidesAndWarnsOnce);
            add("ExactlyEnoughSpace_Shows", ExactlyEnoughSpace_Shows);
            add("TaskbarHidden_HidesWithoutLog", TaskbarHidden_HidesWithoutLog);
            add("Fullscreen_HidesWithoutLog", Fullscreen_HidesWithoutLog);
            add("FullscreenWhileWarned_DoesNotResetWarning", FullscreenWhileWarned_DoesNotResetWarning);
            add("Dpi144_ScalesMarginAndGap", Dpi144_ScalesMarginAndGap);
            add("Dpi144_GapIsScaled", Dpi144_GapIsScaled);

            add("ParseLine_TwoDevices", ParseLine_TwoDevices);
            add("ParseLine_Empty", ParseLine_Empty);
            add("ParseLine_SkipsEmptyIcon", ParseLine_SkipsEmptyIcon);
            add("ParseLine_ClampsLevel", ParseLine_ClampsLevel);
            add("ParseLine_NotJson", ParseLine_NotJson);

            add("Decide_FreshMeasurementShows", Decide_FreshMeasurementShows);
            add("Decide_NotMeasuredYetHidesWithoutLog", Decide_NotMeasuredYetHidesWithoutLog);
            add("Decide_TaskbarChangedHidesWithoutLog", Decide_TaskbarChangedHidesWithoutLog);
            add("Decide_StalledMeasurementHidesAndWarnsOnce", Decide_StalledMeasurementHidesAndWarnsOnce);
            add("Decide_FullscreenAskedAtDecisionTime", Decide_FullscreenAskedAtDecisionTime);
            add("Decide_TickCountWrapIsNotOld", Decide_TickCountWrapIsNotOld);

            add("AssetsPath_AppFolderIsUsed", AssetsPath_AppFolderIsUsed);
            add("AssetsPath_OthersAreRefused", AssetsPath_OthersAreRefused);
            add("AssetsPath_NotGivenIsNoIconsWithoutProblem", AssetsPath_NotGivenIsNoIconsWithoutProblem);

            using (var icons = new IconSet(assetsDir))
            {
                add("Render_TwoItemsWiderThanOne", () => Render_TwoItemsWiderThanOne(icons));
                add("Render_LowHasOrange", () => Render_LowHasOrange(icons));
                add("Render_NotLowHasNoOrange", () => Render_NotLowHasNoOrange(icons));
                add("Render_ChargingWiderThanNotCharging", () => Render_ChargingWiderThanNotCharging(icons));
                add("IconSet_UnknownNameIsPlug", () => IconSet_UnknownNameIsPlug(assetsDir, icons));

                return RunCases(cases);
            }
        }

        private static int RunCases(List<KeyValuePair<string, Action>> cases)
        {
            var failed = 0;
            foreach (var c in cases)
            {
                try
                {
                    c.Value();
                }
                catch (Exception e)
                {
                    failed++;
                    var reason = e is Failure ? e.Message : e.GetType().Name + ": " + e.Message;
                    Console.Out.WriteLine("FAIL " + c.Key + ": " + reason);
                }
            }

            if (failed > 0)
            {
                Console.Out.Flush();
                return 1;
            }

            Console.Out.WriteLine("PASS " + cases.Count);
            Console.Out.Flush();
            return 0;
        }

        // --- helpers ---

        private static ProbeResult Probe(int appsRight = AppsRight, Rectangle? taskbar = null)
        {
            return new ProbeResult(new TaskbarSnapshot(taskbar ?? Taskbar, Monitor, TrayLeft, appsRight), null);
        }

        private static ProbeResult ProbeError(string error)
        {
            return new ProbeResult(null, error);
        }

        private static void Equal<T>(T expected, T actual, string what)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new Failure(what + ": expected " + expected + ", got " + actual);
            }
        }

        private static void True(bool condition, string what)
        {
            if (!condition) throw new Failure(what);
        }

        // --- Controller.Decide: the age of the measurement and full screen ---

        private const int Now = 500000;
        private const int Generation = 7;

        private static Controller.Measurement Measured(int age, int generation = Generation)
        {
            return new Controller.Measurement(Probe(), unchecked(Now - age), generation);
        }

        private static Decision Decide(Policy policy, Controller.Measurement measured, bool fullscreen = false, int now = Now)
        {
            return Controller.Decide(policy, 1, measured, now, Generation, () => fullscreen, Overlay, Dpi);
        }

        private static void Decide_FreshMeasurementShows()
        {
            var log = new Recorder();
            var decision = Decide(new Policy(log.Write), Measured(Controller.MaxAgeMs));

            Equal(HideReason.None, decision.Reason, "reason");
            Equal<Rectangle?>(new Rectangle(3107, 1400, 72, 32), decision.Bounds, "bounds");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void Decide_NotMeasuredYetHidesWithoutLog()
        {
            var log = new Recorder();
            var decision = Decide(new Policy(log.Write), null);

            True(decision == null, "no measurement yet should hide without asking Policy");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void Decide_TaskbarChangedHidesWithoutLog()
        {
            var log = new Recorder();
            var decision = Decide(new Policy(log.Write), Measured(0, Generation - 1));

            True(decision == null, "a measurement from before the taskbar changed should hide");
            Equal(0, log.Entries.Count, "log entries");

            // No new measurement since the change, and the old one is too old by now: hidden with one WARN.
            var late = Decide(new Policy(log.Write), Measured(Controller.MaxAgeMs + 1, Generation - 1));
            Equal(HideReason.TaskbarUnavailable, late.Reason, "reason when the old one is too old");
            Equal(1, log.Count("WARN"), "WARN entries");
        }

        // UI Automation stuck after a good measurement: hidden, one WARN however many ticks; shown again
        // (one INFO) once a new measurement is in.
        private static void Decide_StalledMeasurementHidesAndWarnsOnce()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);
            var stuck = Measured(0);

            Decision last = null;
            for (var tick = 1; tick <= 20; tick++)
            {
                last = Decide(policy, stuck, false, Now + Controller.MaxAgeMs + tick * 300);
            }

            Equal(HideReason.TaskbarUnavailable, last.Reason, "reason");
            True(last.Bounds == null, "bounds should be null");
            Equal(1, log.Entries.Count, "log entries");
            Equal("WARN", log.Entries[0].Level, "level");
            True(log.Entries[0].Message.Contains(Controller.TooOldMessage), "message should say why, got: " + log.Entries[0].Message);

            var again = Decide(policy, Measured(0));
            Equal(HideReason.None, again.Reason, "reason after a new measurement");
            Equal(1, log.Count("INFO"), "INFO entries");
        }

        private static void Decide_FullscreenAskedAtDecisionTime()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);
            var measured = Measured(0);
            var asked = 0;
            Func<bool> fullscreen = () => { asked++; return asked > 1; };

            var first = Controller.Decide(policy, 1, measured, Now, Generation, fullscreen, Overlay, Dpi);
            var second = Controller.Decide(policy, 1, measured, Now, Generation, fullscreen, Overlay, Dpi);

            Equal(HideReason.None, first.Reason, "first reason");
            Equal(HideReason.Fullscreen, second.Reason, "same measurement, full screen now");
            Equal(2, asked, "full screen asked on each decision");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void Decide_TickCountWrapIsNotOld()
        {
            var log = new Recorder();
            var measured = new Controller.Measurement(Probe(), int.MaxValue - 100, Generation);
            var decision = Decide(new Policy(log.Write), measured, false, int.MinValue + 100);

            Equal(HideReason.None, decision.Reason, "201 ms across the wrap is fresh");
            Equal(0, log.Entries.Count, "log entries");
        }

        // --- AssetsPath: --assets is only the app's own icon folder ---

        private const string LocalExe = @"C:\Users\me\AppData\Local\Programs\battery-hub\resources\app\src\main\taskbar-battery.exe";
        private const string LocalAssets = @"C:\Users\me\AppData\Local\Programs\battery-hub\resources\app\assets\taskbar";

        private static void AssetsPath_AppFolderIsUsed()
        {
            var wslExe = @"\\wsl.localhost\Ubuntu\home\me\battery-hub\src\main\taskbar-battery.exe";
            var cases = new[]
            {
                new[] { LocalExe, LocalAssets },
                new[] { LocalExe, LocalAssets + "\\" },
                new[] { LocalExe, @"C:\USERS\me\AppData\Local\Programs\battery-hub\resources\app\src\main\..\..\assets\taskbar" },
                new[] { LocalExe, LocalAssets.Replace('\\', '/') },
                new[] { wslExe, @"\\wsl.localhost\Ubuntu\home\me\battery-hub\assets\taskbar" },
            };
            foreach (var c in cases)
            {
                string problem;
                var dir = AssetsPath.Check(c[1], c[0], out problem);
                Equal(c[1], dir, "folder for " + c[1]);
                True(problem == null, "no problem for " + c[1] + ", got: " + problem);
            }
        }

        private static void AssetsPath_OthersAreRefused()
        {
            var refused = new[]
            {
                @"\\localhost\c$",
                @"\\remote-host\share\assets\taskbar",
                @"//remote-host/share/assets/taskbar",
                @"\\?\" + LocalAssets,
                @"\\.\" + LocalAssets,
                @"assets\taskbar",
                @"..\..\assets\taskbar",
                @"C:assets\taskbar",
                @"\Users\me\AppData\Local\Programs\battery-hub\resources\app\assets\taskbar",
                @"C:\Windows",
                LocalAssets + @"\..\..\other",
                "",
                "C:\\a\u0000b",
            };
            foreach (var given in refused)
            {
                string problem;
                var dir = AssetsPath.Check(given, LocalExe, out problem);
                True(dir == null, "should be refused: " + given);
                True(problem != null && problem.StartsWith("The icon folder is not the app's own (", StringComparison.Ordinal),
                    "should say why for " + given + ", got: " + problem);
            }

            // The app's folder of an exe on a share: still refused for a local exe, and the other way round.
            string p;
            True(AssetsPath.Check(@"\\wsl.localhost\Ubuntu\home\me\battery-hub\assets\taskbar", LocalExe, out p) == null, "share for a local exe");
            True(AssetsPath.Check(LocalAssets, @"\\wsl.localhost\Ubuntu\home\me\battery-hub\src\main\taskbar-battery.exe", out p) == null, "local for an exe on a share");
            True(AssetsPath.Check(LocalAssets, null, out p) == null && p != null, "unknown exe");
        }

        private static void AssetsPath_NotGivenIsNoIconsWithoutProblem()
        {
            string problem;
            True(AssetsPath.Check(null, LocalExe, out problem) == null, "no folder");
            True(problem == null, "not given is not a problem here (RunOverlay warns that it is not there)");
        }

        // --- Policy (from inzone-auto-switch's TaskbarOverlayPolicyTests) ---

        private static void Normal_PlacesLeftOfTrayCentered()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            var decision = policy.Evaluate(1, Probe(), false, Overlay, Dpi);

            Equal(HideReason.None, decision.Reason, "reason");
            Equal<Rectangle?>(new Rectangle(3107, 1400, 72, 32), decision.Bounds, "bounds");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void NoItems_Hides()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            var decision = policy.Evaluate(0, Probe(), false, Overlay, Dpi);

            Equal(HideReason.NoItems, decision.Reason, "reason");
            True(decision.Bounds == null, "bounds should be null");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void NullProbe_HidesAsUnavailable()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            var decision = policy.Evaluate(1, null, false, Overlay, Dpi);

            Equal(HideReason.TaskbarUnavailable, decision.Reason, "reason");
            True(decision.Bounds == null, "bounds should be null");
            Equal(1, log.Entries.Count, "log entries");
            Equal(1, log.Count("WARN"), "WARN entries");
        }

        private static void ProbeError_HidesAndWarnsOnce()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            Decision last = null;
            for (var i = 0; i < 3; i++)
            {
                last = policy.Evaluate(1, ProbeError("UIA failed"), false, Overlay, Dpi);
            }

            Equal(HideReason.TaskbarUnavailable, last.Reason, "reason");
            True(last.Bounds == null, "bounds should be null");
            Equal(1, log.Entries.Count, "log entries");
            Equal("WARN", log.Entries[0].Level, "level");
            True(log.Entries[0].Message.Contains("UIA failed"), "message should contain the probe error, got: " + log.Entries[0].Message);
        }

        private static void RecoversAfterError_ShowsAndInfoOnce()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            policy.Evaluate(1, ProbeError("UIA failed"), false, Overlay, Dpi);
            var first = policy.Evaluate(1, Probe(), false, Overlay, Dpi);
            var second = policy.Evaluate(1, Probe(), false, Overlay, Dpi);

            Equal(HideReason.None, first.Reason, "first reason");
            Equal(HideReason.None, second.Reason, "second reason");
            Equal(1, log.Count("WARN"), "WARN entries");
            Equal(1, log.Count("INFO"), "INFO entries");
            Equal("Taskbar levels can be shown again.", log.Entries[1].Message, "info message");
            Equal(2, log.Entries.Count, "log entries");
        }

        private static void NoSpace_HidesAndWarnsOnce()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            // x = 3183 - 4 - 72 = 3107, AppsRight + gap = 3100 + 8 = 3108 -> not enough
            policy.Evaluate(1, Probe(3100), false, Overlay, Dpi);
            var decision = policy.Evaluate(1, Probe(3100), false, Overlay, Dpi);

            Equal(HideReason.NoSpace, decision.Reason, "reason");
            True(decision.Bounds == null, "bounds should be null");
            Equal(1, log.Entries.Count, "log entries");
            Equal("WARN", log.Entries[0].Level, "level");
            True(log.Entries[0].Message.Contains("overlaps the taskbar buttons"), "message should say why, got: " + log.Entries[0].Message);
        }

        private static void ExactlyEnoughSpace_Shows()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            // x = 3107 == 3099 + 8 -> just enough
            var decision = policy.Evaluate(1, Probe(3099), false, Overlay, Dpi);

            Equal(HideReason.None, decision.Reason, "reason");
            Equal<Rectangle?>(new Rectangle(3107, 1400, 72, 32), decision.Bounds, "bounds");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void TaskbarHidden_HidesWithoutLog()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            // An auto-hidden taskbar pushed below the screen (2px stay on screen).
            var decision = policy.Evaluate(1, Probe(taskbar: new Rectangle(0, 1438, 3440, 48)), false, Overlay, Dpi);

            Equal(HideReason.TaskbarHidden, decision.Reason, "reason");
            True(decision.Bounds == null, "bounds should be null");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void Fullscreen_HidesWithoutLog()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            var decision = policy.Evaluate(1, Probe(), true, Overlay, Dpi);

            Equal(HideReason.Fullscreen, decision.Reason, "reason");
            True(decision.Bounds == null, "bounds should be null");
            Equal(0, log.Entries.Count, "log entries");
        }

        private static void FullscreenWhileWarned_DoesNotResetWarning()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            policy.Evaluate(1, Probe(3100), false, Overlay, Dpi);
            var fullscreen = policy.Evaluate(1, Probe(3100), true, Overlay, Dpi);
            var again = policy.Evaluate(1, Probe(3100), false, Overlay, Dpi);

            Equal(HideReason.Fullscreen, fullscreen.Reason, "fullscreen reason");
            Equal(HideReason.NoSpace, again.Reason, "again reason");
            Equal(1, log.Entries.Count, "log entries");
            Equal("WARN", log.Entries[0].Level, "level");
        }

        private static void Dpi144_ScalesMarginAndGap()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);

            var decision = policy.Evaluate(1, Probe(taskbar: new Rectangle(0, 1368, 3440, 72)), false, new Size(108, 48), 144);

            Equal(HideReason.None, decision.Reason, "reason");
            Equal<Rectangle?>(new Rectangle(3183 - 6 - 108, 1380, 108, 48), decision.Bounds, "bounds");
        }

        private static void Dpi144_GapIsScaled()
        {
            var log = new Recorder();
            var policy = new Policy(log.Write);
            var taskbar = new Rectangle(0, 1368, 3440, 72);

            // x = 3183 - 6 - 108 = 3069. The gap is 12, so AppsRight 3058 is too close and 3057 is enough.
            var tooClose = policy.Evaluate(1, Probe(3058, taskbar), false, new Size(108, 48), 144);
            var enough = policy.Evaluate(1, Probe(3057, taskbar), false, new Size(108, 48), 144);

            Equal(HideReason.NoSpace, tooClose.Reason, "too close reason");
            Equal(HideReason.None, enough.Reason, "enough reason");
        }

        // --- Protocol.ParseLine ---

        private static void ParseLine_TwoDevices()
        {
            // The shape taskbar-model.js lineFor() sends.
            var items = Protocol.ParseLine("{\"devices\":[{\"icon\":\"mouse\",\"level\":82,\"charging\":false,\"low\":false},{\"icon\":\"headset\",\"level\":18,\"charging\":true,\"low\":true}]}");

            True(items != null, "should parse");
            Equal(2, items.Count, "count");
            Equal("mouse", items[0].Icon, "[0].Icon");
            Equal(82, items[0].Level, "[0].Level");
            Equal(false, items[0].Charging, "[0].Charging");
            Equal(false, items[0].Low, "[0].Low");
            Equal("headset", items[1].Icon, "[1].Icon");
            Equal(18, items[1].Level, "[1].Level");
            Equal(true, items[1].Charging, "[1].Charging");
            Equal(true, items[1].Low, "[1].Low");
        }

        private static void ParseLine_Empty()
        {
            var items = Protocol.ParseLine("{\"devices\":[]}");

            True(items != null, "should parse");
            Equal(0, items.Count, "count");
        }

        private static void ParseLine_SkipsEmptyIcon()
        {
            var items = Protocol.ParseLine("{\"devices\":[{\"icon\":\"\",\"level\":5,\"charging\":false,\"low\":true},{\"icon\":\"pen\",\"level\":5,\"charging\":false,\"low\":true}]}");

            True(items != null, "should parse");
            Equal(1, items.Count, "count");
            Equal("pen", items[0].Icon, "[0].Icon");
        }

        private static void ParseLine_ClampsLevel()
        {
            var items = Protocol.ParseLine("{\"devices\":[{\"icon\":\"mouse\",\"level\":150,\"charging\":false,\"low\":false}]}");

            True(items != null, "should parse");
            Equal(1, items.Count, "count");
            Equal(100, items[0].Level, "[0].Level");
        }

        private static void ParseLine_NotJson()
        {
            True(Protocol.ParseLine("not json") == null, "should return null");
        }

        // --- Renderer and IconSet (from inzone-auto-switch's BatteryOverlayRendererTests) ---

        private static readonly Color DarkOrange = Color.FromArgb(0xFF, 0x9F, 0x43);

        private static OverlayItem Item(string icon, int level, bool charging, bool low)
        {
            return new OverlayItem { Icon = icon, Level = level, Charging = charging, Low = low };
        }

        private static void Render_TwoItemsWiderThanOne(IconSet icons)
        {
            using (var one = Renderer.Render(new[] { Item("mouse", 82, false, false) }, false, Dpi, icons))
            using (var two = Renderer.Render(new[] { Item("mouse", 82, false, false), Item("keyboard", 45, false, false) }, false, Dpi, icons))
            {
                True(two.Width > one.Width, "two items (" + two.Width + ") should be wider than one (" + one.Width + ")");
                Equal(32, one.Height, "height at 96 dpi");
            }
        }

        private static void Render_LowHasOrange(IconSet icons)
        {
            using (var bitmap = Renderer.Render(new[] { Item("headset", 18, false, true) }, false, Dpi, icons))
            {
                True(HasNear(bitmap, DarkOrange), "a low item should have #FF9F43 pixels");

                // The icon (the first 1 + 16 columns at 96 dpi) keeps its colour. Its PNG has soft edges and
                // no fully opaque pixels at 16 px, so look at the mostly opaque ones there.
                True(HasNear(bitmap, Color.White, 128, 0, 17), "the icon should still be white");
                True(!HasNear(bitmap, DarkOrange, 128, 0, 17), "the icon should not turn orange");
            }
        }

        private static void Render_NotLowHasNoOrange(IconSet icons)
        {
            using (var bitmap = Renderer.Render(new[] { Item("headset", 18, false, false) }, false, Dpi, icons))
            {
                True(!HasNear(bitmap, DarkOrange), "an item that isn't low should have no #FF9F43 pixels");
                True(HasNear(bitmap, Color.White), "should have white pixels");
            }
        }

        private static void Render_ChargingWiderThanNotCharging(IconSet icons)
        {
            using (var plain = Renderer.Render(new[] { Item("mouse", 82, false, false) }, false, Dpi, icons))
            using (var charging = Renderer.Render(new[] { Item("mouse", 82, true, false) }, false, Dpi, icons))
            {
                True(charging.Width > plain.Width, "charging (" + charging.Width + ") should be wider than not charging (" + plain.Width + ")");
            }
        }

        private static void IconSet_UnknownNameIsPlug(string assetsDir, IconSet icons)
        {
            True(!string.IsNullOrEmpty(assetsDir) && Directory.Exists(assetsDir), "needs --assets <assets/taskbar>, got: " + (assetsDir ?? "(none)"));

            var unknown = icons.Get("no-such-icon", true, 16);
            var plug = icons.Get("plug", true, 16);
            var mouse = icons.Get("mouse", true, 16);

            True(unknown != null && plug != null && mouse != null, "the icons should load");
            True(SamePixels(unknown, plug), "an unknown name should give the plug icon");
            True(!SamePixels(mouse, plug), "mouse should not be the plug icon");
        }

        // Opaque pixels only (edges are blended), each channel within the tolerance, as in inzone's tests.
        private static bool HasNear(Bitmap bitmap, Color expected)
        {
            return HasNear(bitmap, expected, 255, 0, bitmap.Width);
        }

        // Pixels with at least minAlpha in the columns [fromX, toX).
        private static bool HasNear(Bitmap bitmap, Color expected, int minAlpha, int fromX, int toX)
        {
            const int tolerance = 40;
            for (var y = 0; y < bitmap.Height; y++)
            {
                for (var x = Math.Max(0, fromX); x < Math.Min(bitmap.Width, toX); x++)
                {
                    var actual = bitmap.GetPixel(x, y);
                    if (actual.A >= minAlpha
                        && Math.Abs(expected.R - actual.R) <= tolerance
                        && Math.Abs(expected.G - actual.G) <= tolerance
                        && Math.Abs(expected.B - actual.B) <= tolerance)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool SamePixels(Bitmap a, Bitmap b)
        {
            if (a.Width != b.Width || a.Height != b.Height)
            {
                return false;
            }

            for (var y = 0; y < a.Height; y++)
            {
                for (var x = 0; x < a.Width; x++)
                {
                    if (a.GetPixel(x, y).ToArgb() != b.GetPixel(x, y).ToArgb())
                    {
                        return false;
                    }
                }
            }

            return true;
        }
    }
}
