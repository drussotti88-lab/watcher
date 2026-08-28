"""Hand-built SVG charts -- no chart library, no internet needed.

Colors come from CSS custom properties defined in static/app.css, so light and
dark mode are handled in one place. Every chart also has a matching table on the
page, so nothing depends on color alone.
"""
from html import escape


def esc(v):
    return escape(str(v if v is not None else ""), quote=True)


def usd(v):
    try:
        return "${:,.2f}".format(float(v or 0))
    except (TypeError, ValueError):
        return "$0.00"


def usd_short(v):
    v = float(v or 0)
    if v >= 1000:
        return "${:,.1f}k".format(v / 1000).replace(".0k", "k")
    return "${:,.0f}".format(v)


def _nice_max(value):
    if value <= 0:
        return 100.0
    import math
    exp = math.floor(math.log10(value))
    base = 10 ** exp
    for mult in (1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10):
        if base * mult >= value:
            return base * mult
    return base * 10


def _rounded_top(x, y, w, h, base_y, r=4):
    r = max(0, min(r, w / 2, h))
    if h <= 0.5:
        return ""
    return ("M{x:.1f},{b:.1f} L{x:.1f},{yr:.1f} Q{x:.1f},{y:.1f} {xr:.1f},{y:.1f} "
            "L{xw_r:.1f},{y:.1f} Q{xw:.1f},{y:.1f} {xw:.1f},{yr:.1f} "
            "L{xw:.1f},{b:.1f} Z").format(
        x=x, y=y, yr=y + r, xr=x + r, xw=x + w, xw_r=x + w - r, b=base_y)


def _rounded_right(x, y, w, h, r=4):
    r = max(0, min(r, h / 2, w))
    if w <= 0.5:
        return ""
    return ("M{x:.1f},{y:.1f} L{xw_r:.1f},{y:.1f} Q{xw:.1f},{y:.1f} {xw:.1f},{yr:.1f} "
            "L{xw:.1f},{yh_r:.1f} Q{xw:.1f},{yh:.1f} {xw_r:.1f},{yh:.1f} "
            "L{x:.1f},{yh:.1f} Z").format(
        x=x, y=y, xw=x + w, xw_r=x + w - r, yr=y + r, yh=y + h, yh_r=y + h - r)


def empty(message):
    return ('<div class="chart-empty"><p>%s</p></div>' % esc(message))


def vbars(points, height=250, label_fmt=usd_short, value_key="value",
          series_var="--series-1", max_labels=14):
    """Vertical bars over time. points: [{label, value, sub, tip}]"""
    if not points:
        return empty("Nothing to chart yet.")

    W, H = 860, height
    pad_l, pad_r, pad_t, pad_b = 56, 12, 26, 46
    plot_w, plot_h = W - pad_l - pad_r, H - pad_t - pad_b
    top = _nice_max(max(p[value_key] for p in points))
    n = len(points)
    slot = plot_w / n
    bar_w = max(6.0, min(52.0, slot - max(6.0, slot * 0.28)))
    base_y = pad_t + plot_h

    out = ['<svg class="chart" viewBox="0 0 %d %d" role="img" '
           'preserveAspectRatio="xMidYMid meet">' % (W, H)]

    # gridlines + y axis
    for i in range(5):
        val = top * i / 4
        y = base_y - plot_h * i / 4
        out.append('<line class="grid" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/>'
                   % (pad_l, y, W - pad_r, y))
        out.append('<text class="tick" x="%d" y="%.1f" text-anchor="end">%s</text>'
                   % (pad_l - 10, y + 4, esc(label_fmt(val))))
    out.append('<line class="axis" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/>'
               % (pad_l, base_y, W - pad_r, base_y))

    step = max(1, round(n / max_labels))
    for i, p in enumerate(points):
        v = float(p[value_key] or 0)
        h = plot_h * (v / top) if top else 0
        x = pad_l + slot * i + (slot - bar_w) / 2
        y = base_y - h
        tip = p.get("tip") or "%s — %s" % (p["label"], usd(v))
        path = _rounded_top(x, y, bar_w, h, base_y)
        if path:
            out.append('<path class="bar" style="fill:var(%s)" d="%s" '
                       'data-tip="%s"><title>%s</title></path>'
                       % (series_var, path, esc(tip), esc(tip)))
        if h > 26 or n <= 12:
            out.append('<text class="bar-label" x="%.1f" y="%.1f" text-anchor="middle">%s</text>'
                       % (x + bar_w / 2, y - 7, esc(label_fmt(v))))
        if i % step == 0 or i == n - 1:
            out.append('<text class="tick" x="%.1f" y="%.1f" text-anchor="middle">%s</text>'
                       % (x + bar_w / 2, base_y + 18, esc(p["label"])))
            if p.get("sub"):
                out.append('<text class="tick sub" x="%.1f" y="%.1f" '
                           'text-anchor="middle">%s</text>'
                           % (x + bar_w / 2, base_y + 33, esc(p["sub"])))
    out.append("</svg>")
    return "".join(out)


def hbars(rows, value_fmt=usd, series_var="--series-1", row_h=34):
    """Horizontal bars with the name and value written out beside each bar."""
    if not rows:
        return empty("Nothing to chart yet.")

    W = 860
    pad_l, pad_r, pad_t = 190, 96, 10
    H = pad_t * 2 + row_h * len(rows)
    plot_w = W - pad_l - pad_r
    top = _nice_max(max(float(r["value"] or 0) for r in rows))

    out = ['<svg class="chart" viewBox="0 0 %d %d" role="img" '
           'preserveAspectRatio="xMidYMid meet">' % (W, H)]
    for i, r in enumerate(rows):
        v = float(r["value"] or 0)
        w = plot_w * (v / top) if top else 0
        y = pad_t + row_h * i + 5
        bh = row_h - 12
        color = r.get("color") or series_var
        out.append('<text class="row-label" x="%d" y="%.1f" text-anchor="end">%s</text>'
                   % (pad_l - 14, y + bh / 2 + 4, esc(r["label"])))
        path = _rounded_right(pad_l, y, w, bh)
        if path:
            tip = r.get("tip") or "%s — %s" % (r["label"], value_fmt(v))
            out.append('<path class="bar" style="fill:var(%s)" d="%s" data-tip="%s">'
                       '<title>%s</title></path>' % (color, path, esc(tip), esc(tip)))
        else:
            out.append('<circle cx="%d" cy="%.1f" r="2" class="zero-dot"/>'
                       % (pad_l + 2, y + bh / 2))
        out.append('<text class="row-value" x="%.1f" y="%.1f">%s</text>'
                   % (pad_l + w + 10, y + bh / 2 + 4, esc(value_fmt(v))))
    out.append("</svg>")
    return "".join(out)


def grouped_hbars(rows, series, value_fmt=usd, row_h=48):
    """Two measures per row (e.g. already spent vs still owed)."""
    if not rows:
        return empty("Nothing to chart yet.")

    W = 860
    pad_l, pad_r, pad_t = 190, 96, 12
    bar_h = 13
    gap = 2  # 2px surface gap between adjacent bars, per the spec
    H = pad_t * 2 + row_h * len(rows)
    plot_w = W - pad_l - pad_r
    top = _nice_max(max(max(float(r["values"][i] or 0) for i in range(len(series)))
                        for r in rows))

    out = ['<svg class="chart" viewBox="0 0 %d %d" role="img" '
           'preserveAspectRatio="xMidYMid meet">' % (W, H)]
    for i, r in enumerate(rows):
        block_y = pad_t + row_h * i
        label_y = block_y + (len(series) * (bar_h + gap)) / 2 + 4
        out.append('<text class="row-label" x="%d" y="%.1f" text-anchor="end">%s</text>'
                   % (pad_l - 14, label_y, esc(r["label"])))
        for s_i, s in enumerate(series):
            v = float(r["values"][s_i] or 0)
            w = plot_w * (v / top) if top else 0
            y = block_y + s_i * (bar_h + gap)
            path = _rounded_right(pad_l, y, w, bar_h, r=3)
            tip = "%s — %s: %s" % (r["label"], s["label"], value_fmt(v))
            if path:
                out.append('<path class="bar" style="fill:var(%s)" d="%s" data-tip="%s">'
                           '<title>%s</title></path>' % (s["var"], path, esc(tip), esc(tip)))
            out.append('<text class="row-value small" x="%.1f" y="%.1f">%s</text>'
                       % (pad_l + w + 8, y + bar_h - 2, esc(value_fmt(v))))
    out.append("</svg>")

    legend = ['<div class="legend">']
    for s in series:
        legend.append('<span class="legend-item"><span class="swatch" '
                      'style="background:var(%s)"></span>%s</span>' % (s["var"], esc(s["label"])))
    legend.append("</div>")
    return "".join(out) + "".join(legend)
