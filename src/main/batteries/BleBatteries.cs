// Bluetooth LE devices whose battery Windows doesn't show (issues #237, #240, #218): many mice have
// the standard Battery Service (0x180F) but Windows never copies its level onto the device. This reads
// it directly, read-only: paired devices only, no exclusive access, the way BlueGauge does.
// Prints one JSON line: [{"id":"ble:<mac>","name":...,"kind":"bluetooth","capacity":N,"connected":true}].
// A device without the Battery Service, or asleep, is left out.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

static class Program
{
    const uint FILTER_PRESENT = 0x100, FILTER_CLASS = 0x200;
    const string BLUETOOTH_CLASS = "{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}";

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey { public Guid Fmtid; public uint Pid; }
    static PropertyKey Key(string guid, uint pid) { PropertyKey k; k.Fmtid = new Guid(guid); k.Pid = pid; return k; }
    static readonly PropertyKey BATTERY = Key("104EA319-6EE2-4701-BD47-8DDBF425BBE5", 2);
    static readonly PropertyKey NAME = Key("b725f130-47ef-101a-a5f1-02608c9eebac", 10);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_Device_ID_List_SizeW(out int length, string filter, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_Device_ID_ListW(string filter, char[] buffer, int length, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Locate_DevNodeW(out uint node, string id, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_DevNode_PropertyW(uint node, ref PropertyKey key, out uint type, byte[] buffer, ref int size, uint flags);

    static byte[] Read(uint node, PropertyKey key)
    {
        uint type;
        int size = 512;
        byte[] buffer = new byte[size];
        if (CM_Get_DevNode_PropertyW(node, ref key, out type, buffer, ref size, 0) != 0) return null;
        Array.Resize(ref buffer, size);
        return buffer;
    }

    static string[] Ids()
    {
        uint flags = FILTER_CLASS | FILTER_PRESENT;
        int length;
        if (CM_Get_Device_ID_List_SizeW(out length, BLUETOOTH_CLASS, flags) != 0) return new string[0];
        char[] ids = new char[length];
        if (CM_Get_Device_ID_ListW(BLUETOOTH_CLASS, ids, length, flags) != 0) return new string[0];
        return new string(ids).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
    }

    // Waits for a WinRT call without System.Runtime.WindowsRuntime (its AsTask needs the union
    // Windows.winmd, which only the Windows SDK has; the .NET compiler in Windows does not).
    static T Wait<T>(IAsyncOperation<T> op, int timeoutMs)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (op.Status == AsyncStatus.Started)
        {
            if (DateTime.UtcNow > deadline) { op.Cancel(); throw new TimeoutException(); }
            Thread.Sleep(10);
        }
        if (op.Status != AsyncStatus.Completed) throw new InvalidOperationException(op.Status.ToString());
        return op.GetResults();
    }

    static int Level(ulong address)
    {
        using (var device = Wait(BluetoothLEDevice.FromBluetoothAddressAsync(address), 3000))
        {
            if (device == null) return -1;
            var services = Wait(device.GetGattServicesForUuidAsync(GattServiceUuids.Battery, BluetoothCacheMode.Uncached), 5000);
            if (services.Status != GattCommunicationStatus.Success) return -1;
            foreach (var service in services.Services)
            {
                using (service)
                {
                    var chars = Wait(service.GetCharacteristicsForUuidAsync(GattCharacteristicUuids.BatteryLevel, BluetoothCacheMode.Uncached), 3000);
                    if (chars.Status != GattCommunicationStatus.Success) continue;
                    foreach (var c in chars.Characteristics)
                    {
                        var value = Wait(c.ReadValueAsync(BluetoothCacheMode.Uncached), 3000);
                        if (value.Status != GattCommunicationStatus.Success || value.Value.Length < 1) continue;
                        byte level = DataReader.FromBuffer(value.Value).ReadByte();
                        if (level <= 100) return level;
                    }
                }
            }
        }
        return -1;
    }

    static string Quote(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // --all also reads devices Windows already has a level for (to check this read against Windows).
    // --only <MAC,MAC> reads just those devices: the app's timer asks only for the ones it tracks, so a
    // paired device nobody added isn't woken every few minutes.
    static int Main(string[] args)
    {
        bool all = Array.IndexOf(args, "--all") >= 0;
        HashSet<string> only = null;
        int onlyAt = Array.IndexOf(args, "--only");
        if (onlyAt >= 0 && onlyAt + 1 < args.Length)
            only = new HashSet<string>(args[onlyAt + 1].ToUpperInvariant().Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries));
        Console.OutputEncoding = new UTF8Encoding(false);
        var found = new List<string>();
        var seen = new HashSet<string>();
        // The app stops this after 60 s; stop at 45 s so what was read still gets printed. Devices that
        // are paired but away take seconds each.
        var stopAt = DateTime.UtcNow.AddSeconds(45);
        foreach (string id in Ids())
        {
            if (DateTime.UtcNow > stopAt) break;
            var m = System.Text.RegularExpressions.Regex.Match(id, @"^BTHLE\\DEV_([0-9A-F]{12})\\", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (!m.Success) continue;
            string mac = m.Groups[1].Value.ToUpperInvariant();
            if (!seen.Add(mac)) continue;
            if (only != null && !only.Contains(mac)) continue;
            uint node;
            if (CM_Locate_DevNodeW(out node, id, 0) != 0) continue;
            if (!all && Read(node, BATTERY) != null) continue; // Windows already has it: the other helper lists it
            int level;
            try { level = Level(Convert.ToUInt64(mac, 16)); }
            catch (Exception) { level = -1; }
            if (level < 0) continue;
            byte[] name = Read(node, NAME);
            string label = name == null ? "Bluetooth device" : Encoding.Unicode.GetString(name).TrimEnd('\0');
            found.Add("{\"id\":" + Quote("ble:" + mac) + ",\"name\":" + Quote(label) + ",\"kind\":\"bluetooth\",\"capacity\":" + level + ",\"connected\":true}");
        }
        Console.Out.WriteLine("[" + string.Join(",", found.ToArray()) + "]");
        return 0;
    }
}
