// fork: taskbar battery levels (fork Issue #16). Reads the one-line JSON that src/main/taskbar.js sends
// (taskbar-model.js lineFor): {"devices":[{"icon":"mouse","level":82,"charging":false,"low":false}]}.
// Node decides what to show, the order, the icon names and "low"; this side only reads it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

namespace BatteryHubTaskbar
{
    /// <summary>One device to draw: icon name, level 0..100, charging, low (drawn in orange).</summary>
    internal sealed class OverlayItem
    {
        public string Icon { get; set; }
        public int Level { get; set; }
        public bool Charging { get; set; }
        public bool Low { get; set; }
    }

    internal static class Protocol
    {
        [DataContract]
        private sealed class Message
        {
            [DataMember(Name = "devices")]
            public List<WireItem> Devices { get; set; }
        }

        [DataContract]
        private sealed class WireItem
        {
            [DataMember(Name = "icon")]
            public string Icon { get; set; }

            // A double so that a fractional level still reads (it is rounded below).
            [DataMember(Name = "level")]
            public double Level { get; set; }

            [DataMember(Name = "charging")]
            public bool Charging { get; set; }

            [DataMember(Name = "low")]
            public bool Low { get; set; }
        }

        private static readonly DataContractJsonSerializer Serializer = new DataContractJsonSerializer(typeof(Message));

        /// <summary>
        /// The devices in one line, or null when the line can't be read (the caller keeps what it
        /// shows and logs one ERROR). Items without an icon are skipped; Level is kept within 0..100.
        /// </summary>
        public static List<OverlayItem> ParseLine(string line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                return null;
            }

            Message message;
            try
            {
                using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(line)))
                {
                    message = Serializer.ReadObject(stream) as Message;
                }
            }
            catch (Exception)
            {
                return null;
            }

            if (message == null || message.Devices == null)
            {
                return null;
            }

            var items = new List<OverlayItem>();
            foreach (var wire in message.Devices)
            {
                if (wire == null || string.IsNullOrEmpty(wire.Icon))
                {
                    continue;
                }

                items.Add(new OverlayItem
                {
                    Icon = wire.Icon,
                    Level = ClampLevel(wire.Level),
                    Charging = wire.Charging,
                    Low = wire.Low,
                });
            }

            return items;
        }

        private static int ClampLevel(double level)
        {
            if (double.IsNaN(level))
            {
                return 0;
            }

            return (int)Math.Round(Math.Max(0, Math.Min(100, level)), MidpointRounding.AwayFromZero);
        }
    }
}
