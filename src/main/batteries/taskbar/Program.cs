// fork: taskbar battery levels (fork Issue #16). taskbar-battery.exe's entry point.
// For now it only takes `--self-test [--assets <dir>]`; the overlay itself comes with the window code.
using System;

namespace BatteryHubTaskbar
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var selfTest = false;
            string assetsDir = null;
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
            }

            if (selfTest)
            {
                return SelfTest.Run(assetsDir);
            }

            Console.Out.WriteLine("ERROR Only --self-test is supported in this build.");
            Console.Out.Flush();
            return 2;
        }
    }
}
