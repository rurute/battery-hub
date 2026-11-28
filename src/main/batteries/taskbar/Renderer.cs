// fork: taskbar battery levels (fork Issue #16). Draws "[icon] 82%  [icon] 45% [flash]" on a transparent
// bitmap; inzone-auto-switch's BatteryOverlayRenderer.Render widened to several devices, with the icons
// from assets/taskbar (scripts/make-taskbar-icons.js) instead of a hand-drawn headset.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Text.RegularExpressions;

namespace BatteryHubTaskbar
{
    /// <summary>
    /// The icon PNGs, assets/taskbar/&lt;name&gt;-&lt;white|black&gt;-&lt;16|20|24|32&gt;.png. A name without a file is
    /// drawn as plug. Bitmaps are loaded once and kept; they belong to the set (don't dispose them).
    /// </summary>
    internal sealed class IconSet : IDisposable
    {
        private const string Fallback = "plug";
        private static readonly int[] Sizes = { 16, 20, 24, 32 };
        private static readonly Regex SafeName = new Regex("^[a-z0-9-]+$");

        private readonly string _dir;
        private readonly Dictionary<string, Bitmap> _loaded = new Dictionary<string, Bitmap>(StringComparer.Ordinal);

        /// <param name="assetsDir">The folder with the PNGs; null or missing gives no icons (Get returns null).</param>
        public IconSet(string assetsDir)
        {
            _dir = assetsDir;
        }

        /// <summary>
        /// The bitmap to draw at px pixels: the smallest file at least px wide (32 when none is), so the
        /// caller only ever scales down. Null when neither the name nor plug has a file.
        /// </summary>
        public Bitmap Get(string name, bool white, int px)
        {
            var size = Sizes[Sizes.Length - 1];
            foreach (var s in Sizes)
            {
                if (s >= px)
                {
                    size = s;
                    break;
                }
            }

            var icon = Load(name, white, size);
            return icon != null ? icon : Load(Fallback, white, size);
        }

        public void Dispose()
        {
            foreach (var bitmap in _loaded.Values)
            {
                if (bitmap != null)
                {
                    bitmap.Dispose();
                }
            }

            _loaded.Clear();
        }

        private Bitmap Load(string name, bool white, int size)
        {
            if (string.IsNullOrEmpty(_dir) || string.IsNullOrEmpty(name) || !SafeName.IsMatch(name))
            {
                return null;
            }

            var file = name + "-" + (white ? "white" : "black") + "-" + size + ".png";
            Bitmap bitmap;
            if (_loaded.TryGetValue(file, out bitmap))
            {
                return bitmap;
            }

            bitmap = null;
            try
            {
                var path = Path.Combine(_dir, file);
                if (File.Exists(path))
                {
                    // Read into memory and copy, so the file isn't kept open.
                    using (var stream = new MemoryStream(File.ReadAllBytes(path)))
                    using (var image = Image.FromStream(stream))
                    {
                        bitmap = new Bitmap(image);
                    }
                }
            }
            catch (Exception)
            {
                bitmap = null;
            }

            _loaded[file] = bitmap;
            return bitmap;
        }
    }

    /// <summary>
    /// Icons and text are white on a dark taskbar and black on a light one; a low item's number and % are
    /// orange. Sizes are for 96 dpi and scaled to dpi.
    /// </summary>
    internal static class Renderer
    {
        private static readonly Color DarkLow = Color.FromArgb(255, 0xFF, 0x9F, 0x43);
        private static readonly Color LightLow = Color.FromArgb(255, 0xC2, 0x41, 0x0C);

        // Pixels at 96 dpi.
        private const int BaseHeight = 32;
        private const float BaseFontSize = 13f;
        private const int BaseIcon = 16;
        private const int BaseFlash = 12;
        private const float BaseIconGap = 4f;
        private const float BaseFlashGap = 2f;
        private const float BaseItemGap = 12f;
        private const float BasePadding = 1f;

        /// <summary>The caller disposes it. Format32bppPArgb, which UpdateLayeredWindow takes.</summary>
        public static Bitmap Render(IList<OverlayItem> items, bool lightTheme, int dpi, IconSet icons)
        {
            var scale = dpi / 96f;
            var height = BaseHeight * dpi / 96;
            var iconPx = BaseIcon * dpi / 96;
            var flashPx = BaseFlash * dpi / 96;
            var iconGap = BaseIconGap * scale;
            var flashGap = BaseFlashGap * scale;
            var itemGap = BaseItemGap * scale;
            var padding = BasePadding * scale;

            var white = !lightTheme;
            var foreground = lightTheme ? Color.Black : Color.White;
            var lowColor = lightTheme ? LightLow : DarkLow;

            using (var font = new Font("Segoe UI", BaseFontSize * scale, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var format = (StringFormat)StringFormat.GenericTypographic.Clone())
            {
                format.FormatFlags |= StringFormatFlags.NoWrap;
                format.LineAlignment = StringAlignment.Center;

                var texts = new string[items.Count];
                var textWidths = new float[items.Count];
                var width = padding * 2;
                using (var probe = new Bitmap(1, 1, PixelFormat.Format32bppPArgb))
                using (var measure = Graphics.FromImage(probe))
                {
                    measure.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    for (var i = 0; i < items.Count; i++)
                    {
                        texts[i] = items[i].Level + "%";
                        textWidths[i] = measure.MeasureString(texts[i], font, PointF.Empty, format).Width;
                        if (i > 0)
                        {
                            width += itemGap;
                        }

                        width += iconPx + iconGap + textWidths[i];
                        if (items[i].Charging)
                        {
                            width += flashGap + flashPx;
                        }
                    }
                }

                var bitmap = new Bitmap(Math.Max(1, (int)Math.Ceiling(width)), height, PixelFormat.Format32bppPArgb);
                try
                {
                    using (var graphics = Graphics.FromImage(bitmap))
                    {
                        graphics.Clear(Color.Transparent);
                        graphics.SmoothingMode = SmoothingMode.AntiAlias;
                        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        // Drawn over transparency, so no ClearType (its colour fringes would stay on the edges).
                        graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

                        var x = padding;
                        for (var i = 0; i < items.Count; i++)
                        {
                            var item = items[i];
                            if (i > 0)
                            {
                                x += itemGap;
                            }

                            DrawIcon(graphics, icons == null ? null : icons.Get(item.Icon, white, iconPx), x, iconPx, height);
                            x += iconPx + iconGap;

                            using (var brush = new SolidBrush(item.Low ? lowColor : foreground))
                            {
                                graphics.DrawString(texts[i], font, brush, new RectangleF(x, 0f, textWidths[i] + padding, height), format);
                            }

                            x += textWidths[i];

                            if (item.Charging)
                            {
                                x += flashGap;
                                DrawIcon(graphics, icons == null ? null : icons.Get("flash", white, flashPx), x, flashPx, height);
                                x += flashPx;
                            }
                        }
                    }

                    return bitmap;
                }
                catch
                {
                    bitmap.Dispose();
                    throw;
                }
            }
        }

        // On whole pixels, centred up and down, so a 16 px icon at 100% is drawn 1:1 and stays sharp.
        private static void DrawIcon(Graphics graphics, Bitmap icon, float x, int px, int height)
        {
            if (icon == null)
            {
                return;
            }

            var left = (int)Math.Round(x);
            var top = (height - px) / 2;
            // TileFlipXY keeps the scaled edges from blending with transparent pixels outside the icon.
            using (var attributes = new ImageAttributes())
            {
                attributes.SetWrapMode(WrapMode.TileFlipXY);
                graphics.DrawImage(icon, new Rectangle(left, top, px, px), 0, 0, icon.Width, icon.Height, GraphicsUnit.Pixel, attributes);
            }
        }
    }
}
