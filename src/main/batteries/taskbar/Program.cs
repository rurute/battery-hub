// fork: taskbar battery levels (fork Issue #16). taskbar-battery.exe's entry point.
//   taskbar-battery.exe [--parent <pid>] --assets <dir>   shows the levels; src/main/taskbar.js runs it.
//   taskbar-battery.exe --self-test [--assets <dir>]      runs SelfTest and exits 0 / 1.
// stdin: one JSON line per update (Protocol). stdout: one "WARN|INFO|ERROR <text>" line per event.
// It ends when stdin closes or the --parent process is gone.
// --assets is only used when it names the app's own icon folder, <exe folder>\..\..\assets\taskbar
// (AssetsPath); any other folder, UNC share or device path gets one WARN and the levels without icons.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace BatteryHubTaskbar
{
    internal static class Program
    {
        private const int ParentCheckMs = 2000;
        private const int MaxLoggedLine = 120;

        private static readonly object LogGate = new object();
        private static TextWriter _out;

        [STAThread]
        private static int Main(string[] args)
        {
            var selfTest = false;
            string assetsDir = null;
            string parentArg = null;
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i] == "--self-test")
                {
                    selfTest = true;
                }
                else if (args[i] == "--assets" && i + 1 < args.Length)
                {
                    assetsDir = args[++i];
                }
                else if (args[i] == "--parent" && i + 1 < args.Length)
                {
                    parentArg = args[++i];
                }
            }

            string assetsProblem;
            var icons = AssetsPath.Check(assetsDir, AssetsPath.ExePath(), out assetsProblem);
            if (selfTest)
            {
                if (assetsProblem != null)
                {
                    Console.Out.WriteLine("WARN " + assetsProblem);
                }

                return SelfTest.Run(icons);
            }

            _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            try
            {
                return RunOverlay(icons, assetsProblem, parentArg);
            }
            catch (Exception ex)
            {
                Log("ERROR", ex.GetType().Name + ": " + ex.Message);
                return 1;
            }
        }

        /// <summary>One line to stdout, flushed. From any thread; never throws (Node may be gone already).</summary>
        internal static void Log(string level, string message)
        {
            try
            {
                var text = (message ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ');
                lock (LogGate)
                {
                    if (_out != null)
                    {
                        _out.WriteLine(level + " " + text);
                        _out.Flush();
                    }
                }
            }
            catch (Exception)
            {
            }
        }

        // assetsDir is null when --assets was refused (assetsProblem says why) or not given.
        private static int RunOverlay(string assetsDir, string assetsProblem, string parentArg)
        {
            Process parent = null;
            if (parentArg != null)
            {
                int pid;
                if (!int.TryParse(parentArg, out pid))
                {
                    Log("ERROR", "--parent is not a process id: " + parentArg);
                    return 2;
                }

                bool gone;
                parent = OpenParent(pid, out gone);
                if (gone)
                {
                    // Already gone: nothing to show for.
                    return 0;
                }
            }

            if (assetsProblem != null)
            {
                Log("WARN", assetsProblem);
            }
            else if (string.IsNullOrEmpty(assetsDir) || !Directory.Exists(assetsDir))
            {
                Log("WARN", "The icon folder is not there, showing levels without icons: " + (assetsDir ?? "(no --assets)"));
                assetsDir = null;
            }

            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (sender, e) => Log("ERROR", e.Exception.GetType().Name + ": " + e.Exception.Message);
            AppDomain.CurrentDomain.UnhandledException += (sender, e) =>
            {
                var ex = e.ExceptionObject as Exception;
                Log("ERROR", ex == null ? "unhandled: " + e.ExceptionObject : ex.GetType().Name + ": " + ex.Message);
            };

            using (var icons = new IconSet(assetsDir))
            using (var invoker = new Control())
            using (var context = new ApplicationContext())
            {
                // The handle has to exist before another thread can BeginInvoke onto it.
                invoker.CreateControl();
                var handle = invoker.Handle;

                var controller = Controller.TryCreate(Log, icons);
                Action quit = () => context.ExitThread();

                System.Windows.Forms.Timer parentTimer = null;
                if (parent != null)
                {
                    parentTimer = new System.Windows.Forms.Timer { Interval = ParentCheckMs };
                    parentTimer.Tick += (sender, e) =>
                    {
                        if (ParentGone(parent))
                        {
                            quit();
                        }
                    };
                    parentTimer.Start();
                }

                var reader = new Thread(() => ReadStdin(invoker, controller, quit)) { IsBackground = true, Name = "stdin" };
                reader.Start();

                try
                {
                    Application.Run(context);
                }
                finally
                {
                    if (parentTimer != null)
                    {
                        parentTimer.Dispose();
                    }

                    if (controller != null)
                    {
                        controller.Dispose();
                    }

                    if (parent != null)
                    {
                        parent.Dispose();
                    }

                    GC.KeepAlive(handle);
                }
            }

            return 0;
        }

        // Reads stdin line by line and hands each to the UI thread; asks the UI thread to quit when it closes.
        private static void ReadStdin(Control invoker, Controller controller, Action quit)
        {
            try
            {
                using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                {
                    string line;
                    while ((line = stdin.ReadLine()) != null)
                    {
                        var current = line;
                        Post(invoker, () => Apply(controller, current));
                    }
                }
            }
            catch (Exception ex)
            {
                Log("ERROR", "Reading stdin failed: " + ex.GetType().Name + ": " + ex.Message);
            }

            Post(invoker, quit);
        }

        private static void Post(Control invoker, Action action)
        {
            try
            {
                invoker.BeginInvoke(action);
            }
            catch (Exception)
            {
                // The UI thread is already ending.
            }
        }

        // UI thread. A line that can't be read keeps what is shown.
        private static void Apply(Controller controller, string line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                return;
            }

            var items = Protocol.ParseLine(line);
            if (items == null)
            {
                var shown = line.Length > MaxLoggedLine ? line.Substring(0, MaxLoggedLine) + "..." : line;
                Log("ERROR", "Can't read the line, keeping the last one: " + shown);
                return;
            }

            if (controller != null)
            {
                controller.SetItems(items);
            }
        }

        // The parent process, or null when it can't be watched (then only stdin closing ends the exe).
        // gone is true when there is no such process.
        private static Process OpenParent(int pid, out bool gone)
        {
            gone = false;
            Process process;
            try
            {
                process = Process.GetProcessById(pid);
            }
            catch (ArgumentException)
            {
                gone = true; // no such process
                return null;
            }
            catch (Exception ex)
            {
                Log("WARN", "Can't watch the parent process " + pid + ": " + ex.Message);
                return null;
            }

            try
            {
                // Opens the process handle and keeps it, so HasExited asks about this process even if a
                // new one reuses the id later.
                GC.KeepAlive(process.Handle);
            }
            catch (Exception)
            {
                // No right to open it: ParentGone falls back to looking the id up.
            }

            if (ParentGone(process))
            {
                process.Dispose();
                gone = true;
                return null;
            }

            return process;
        }

        private static bool ParentGone(Process parent)
        {
            try
            {
                return parent.HasExited;
            }
            catch (Exception)
            {
                // No right to ask: fall back to whether the id is still there.
                try
                {
                    using (Process.GetProcessById(parent.Id))
                    {
                        return false;
                    }
                }
                catch (Exception)
                {
                    return true;
                }
            }
        }
    }

    /// <summary>
    /// Which --assets values are used: only the app's own icon folder, the one next to the exe as the app
    /// ships it (src\main\taskbar-battery.exe and assets\taskbar, both under the same app folder). The
    /// path is compared as text before anything touches the disk, so a refused value (another folder,
    /// a relative path, a UNC share, \\?\ or \\.\) is never opened and causes no network access. A UNC
    /// path passes only when the exe itself runs from that share (as when it is run from WSL).
    /// </summary>
    internal static class AssetsPath
    {
        public static string ExePath()
        {
            try
            {
                return System.Reflection.Assembly.GetEntryAssembly().Location;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>The app's icon folder for the exe at exePath; null when it can't be worked out.</summary>
        public static string Expected(string exePath)
        {
            try
            {
                var exeDir = Path.GetDirectoryName(exePath);
                return string.IsNullOrEmpty(exeDir) ? null : Normalize(Path.Combine(exeDir, "..", "..", "assets", "taskbar"));
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// The folder to read the icons from, or null. problem is set (one line, for a WARN) when given
        /// was refused, and null when it is fine or was not given at all.
        /// </summary>
        public static string Check(string given, string exePath, out string problem)
        {
            problem = null;
            if (given == null)
            {
                return null;
            }

            var reason = Refuse(given, exePath);
            if (reason == null)
            {
                return given;
            }

            problem = "The icon folder is not the app's own (" + reason + "), showing levels without icons: " + given;
            return null;
        }

        private static string Refuse(string given, string exePath)
        {
            if (given.Length == 0)
            {
                return "empty";
            }

            if (given.StartsWith(@"\\?\", StringComparison.Ordinal) || given.StartsWith(@"\\.\", StringComparison.Ordinal)
                || given.StartsWith("//?/", StringComparison.Ordinal) || given.StartsWith("//./", StringComparison.Ordinal))
            {
                return "a device path";
            }

            var unc = given.StartsWith(@"\\", StringComparison.Ordinal) || given.StartsWith("//", StringComparison.Ordinal);
            var drive = given.Length >= 3 && char.IsLetter(given[0]) && given[0] < 128 && given[1] == ':'
                && (given[2] == '\\' || given[2] == '/');
            if (!unc && !drive)
            {
                return "not a full path";
            }

            var expected = Expected(exePath);
            if (expected == null)
            {
                return "can't tell where the exe is";
            }

            string full;
            try
            {
                full = Normalize(given);
            }
            catch (Exception)
            {
                return "not a valid path";
            }

            if (!string.Equals(full, expected, StringComparison.OrdinalIgnoreCase))
            {
                return unc ? "a network path" : "another folder";
            }

            return null;
        }

        // Text only: resolves . and .., turns / into \ and drops a trailing \. Doesn't touch the disk.
        private static string Normalize(string path)
        {
            return Path.GetFullPath(path).TrimEnd('\\');
        }
    }
}
