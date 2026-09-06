"""Render chart artifacts for ASO reports."""

import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch
import matplotlib.colors as mcolors


def _save_figure(figure, out_path):
    """Include the full measured extent of visible labels in the exported image."""
    from matplotlib.text import Text
    labels = [artist for artist in figure.findobj(Text)
              if artist.get_visible() and artist.get_text()]
    figure.savefig(out_path, dpi=150, bbox_inches='tight', bbox_extra_artists=labels)


def _apply_labels(chart, swap=False):
    xl = chart.get('x_label')
    yl = chart.get('y_label')
    if swap:
        xl, yl = yl, xl
    if xl:
        plt.xlabel(xl)
    if yl:
        plt.ylabel(yl)
    if 'x_domain' in chart:
        plt.xlim(*chart['x_domain'])
    if 'y_domain' in chart:
        plt.ylim(*chart['y_domain'])


def _apply_title(chart):
    title = chart.get('title', '')
    if not title:
        return
    fontsize = 12 if len(title) <= 50 else 10 if len(title) <= 80 else 9
    plt.title(title, fontsize=fontsize, pad=10)


def render_bar(chart, out_path):
    data = chart.get('data', [])
    labels = [d.get('label', '') for d in data]
    values = [d.get('value', 0) for d in data]
    plt.figure(figsize=(8, 4))
    plt.bar(labels, values, color='#4C78A8')
    _apply_title(chart)
    _apply_labels(chart)
    plt.xticks(rotation=20, ha='right')
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_line(chart, out_path):
    data = chart.get('data', [])
    series_map = {}
    for d in data:
        name = d.get('series', 'series')
        series_map.setdefault(name, []).append((d.get('x'), d.get('y')))
    plt.figure(figsize=(8, 4))
    for name, pts in series_map.items():
        pts = [p for p in pts if p[0] is not None and p[1] is not None]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        plt.plot(xs, ys, marker='o', label=name)
    _apply_title(chart)
    _apply_labels(chart)
    if len(series_map) > 1:
        plt.legend(loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def _place_scatter_labels(ax, data):
    """Place complete labels in measured free space, keeping raw coordinates unchanged."""
    from matplotlib.transforms import Bbox
    fig = ax.figure
    labels = [(i, str(point.get('label', ''))) for i, point in enumerate(data)
              if point.get('label') and point.get('x') is not None and point.get('y') is not None]
    if not labels:
        return []
    padding = 4.0
    while True:
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        bounds = ax.get_window_extent(renderer)
        sizes = {}
        for i, label in labels:
            text = ax.text(0, 0, label, fontsize=7)
            box = text.get_window_extent(renderer)
            sizes[i] = (box.width, box.height)
            text.remove()
        placed = []
        crowded = False
        ordered = sorted(labels, key=lambda item: (data[item[0]]['y'], data[item[0]]['x'], item[1]))
        for i, label in ordered:
            point = data[i]
            px, py = ax.transData.transform((point['x'], point['y']))
            width, height = sizes[i]
            x = min(max(px + padding, bounds.x0 + padding), bounds.x1 - width - padding)
            target_y = py + padding + height / 2
            candidates = {target_y, bounds.y0 + padding + height / 2, bounds.y1 - padding - height / 2}
            for prior in placed:
                box = prior['box']
                candidates.update([box.y0 - padding - height / 2, box.y1 + padding + height / 2])
            selected = None
            for y in sorted(candidates, key=lambda value: (abs(value - target_y), value)):
                box = Bbox.from_bounds(x, y - height / 2, width, height)
                if box.x0 < bounds.x0 or box.x1 > bounds.x1 or box.y0 < bounds.y0 or box.y1 > bounds.y1:
                    continue
                def separated(other):
                    return (box.x1 + padding <= other.x0 + 1e-6 or other.x1 + padding <= box.x0 + 1e-6
                            or box.y1 + padding <= other.y0 + 1e-6 or other.y1 + padding <= box.y0 + 1e-6)
                if any(not separated(prior['box']) for prior in placed):
                    continue
                selected = {'index': i, 'label': label, 'box': box, 'x': x, 'y': y,
                            'displaced': abs(y - target_y) > padding or x < px}
                break
            if selected is None:
                crowded = True
                break
            placed.append(selected)
        if not crowded:
            break
        # Label area is derived from the actual text. No label count cutoff or data transform.
        width_px = max(width for width, _ in sizes.values()) + 2 * padding
        height_px = sum(height + 2 * padding for _, height in sizes.values())
        current_width, current_height = fig.get_size_inches()
        fig.set_size_inches(max(current_width, current_width * (width_px + bounds.width) / bounds.width),
                            max(current_height, current_height * (height_px + bounds.height) / bounds.height))
        fig.tight_layout()
    annotations = []
    for item in placed:
        point = data[item['index']]
        position = ax.transAxes.inverted().transform((item['x'], item['y']))
        arrow = {'arrowstyle': '-', 'color': '0.5', 'lw': 0.55} if item['displaced'] else None
        annotations.append(ax.annotate(item['label'], (point['x'], point['y']),
                          xytext=position, textcoords='axes fraction', ha='left', va='center',
                          fontsize=7, alpha=0.9, arrowprops=arrow))
    return annotations


def render_scatter(chart, out_path):
    data = chart.get('data', [])
    xs = [d.get('x') for d in data]
    ys = [d.get('y') for d in data]
    fig, ax = plt.subplots(figsize=(8, 6))
    ax.scatter(xs, ys, alpha=0.7, s=40)
    _apply_title(chart)
    _apply_labels(chart)
    fig.tight_layout()
    _place_scatter_labels(ax, data)
    _save_figure(fig, out_path)
    plt.close(fig)

def render_dot_plot(chart, out_path):
    data = chart.get('data', [])
    labels = [d.get('label', '') for d in data]
    values = [d.get('value', 0) for d in data]
    plt.figure(figsize=(8, max(4, len(labels) * 0.3)))
    plt.scatter(values, range(len(labels)), alpha=0.8, s=40)
    plt.yticks(range(len(labels)), labels)
    _apply_title(chart)
    _apply_labels(chart, swap=True)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()

def render_box(chart, out_path):
    series = chart.get('series', [])
    data = [s.get('values', []) for s in series]
    labels = [s.get('label', '') for s in series]
    if not data:
        return
    plt.figure(figsize=(6, 4))
    plt.boxplot(data, labels=labels)
    _apply_title(chart)
    _apply_labels(chart)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()

def render_stacked_bar(chart, out_path):
    data = chart.get('data', [])
    categories = sorted(set(d.get('label') for d in data))
    stacks = sorted(set(d.get('stack') for d in data))
    stack_map = {s: [] for s in stacks}
    for c in categories:
        for s in stacks:
            v = next((d.get('value', 0) for d in data if d.get('label') == c and d.get('stack') == s), 0)
            stack_map[s].append(v)
    plt.figure(figsize=(8, 4))
    bottoms = [0] * len(categories)
    for s in stacks:
        vals = stack_map[s]
        plt.bar(categories, vals, bottom=bottoms, label=str(s))
        bottoms = [b + v for b, v in zip(bottoms, vals)]
    _apply_title(chart)
    _apply_labels(chart)
    if len(stacks) > 1:
        plt.legend(loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0)
    plt.xticks(rotation=20, ha='right')
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()

def render_heatmap(chart, out_path):
    matrix = chart.get('matrix', [])
    if not matrix:
        return
    row_labels = chart.get('row_labels', [])
    col_labels = chart.get('col_labels', [])
    n_rows = len(matrix)
    n_cols = len(matrix[0]) if matrix else 0
    # Wide matrices keep a printable width; labels shrink and thin out instead of the figure growing.
    fig_w = min(24, max(8, n_cols * 0.6 + 3))
    fig_h = min(20, max(4, n_rows * 0.3 + 2))
    plt.figure(figsize=(fig_w, fig_h))
    import numpy as np
    values = np.ma.masked_invalid(np.asarray(matrix, dtype=float))
    palette = plt.get_cmap('YlOrRd').copy()
    palette.set_bad('#dddddd')
    plt.imshow(values, aspect='auto', cmap=palette)
    _apply_title(chart)
    _apply_labels(chart)
    if col_labels:
        step = max(1, int(round(n_cols / 40)))
        plt.xticks(range(0, len(col_labels), step), col_labels[::step], rotation=90 if n_cols > 12 else 45, ha='right', fontsize=max(4, min(9, 300 / max(1, n_cols))))
    if row_labels:
        rstep = max(1, int(round(n_rows / 60)))
        plt.yticks(range(0, len(row_labels), rstep), row_labels[::rstep], fontsize=max(4, min(9, 400 / max(1, n_rows))))
    plt.colorbar(shrink=0.8)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_grouped_bar(chart, out_path):
    data = chart.get('data', [])
    groups = sorted(set(d.get('group') for d in data))
    categories = sorted(set(d.get('label') for d in data))
    group_index = {g: i for i, g in enumerate(groups)}
    cat_index = {c: i for i, c in enumerate(categories)}
    import numpy as np
    values = [[np.nan for _ in categories] for _ in groups]
    for d in data:
        g = d.get('group')
        c = d.get('label')
        if g in group_index and c in cat_index:
            values[group_index[g]][cat_index[c]] = d.get('value', 0)
    import numpy as np
    x = np.arange(len(categories))
    width = 0.8 / max(1, len(groups))
    plt.figure(figsize=(8, 4))
    for i, g in enumerate(groups):
        plt.bar(x + i*width, values[i], width, label=str(g))
    plt.xticks(x + width*(len(groups)-1)/2, categories, rotation=20, ha='right')
    _apply_title(chart)
    _apply_labels(chart)
    if len(groups) > 1:
        plt.legend(loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_lollipop(chart, out_path):
    """Ranked data as stems + dots — cleaner than bar for 20+ items."""
    data = chart.get('data', [])
    labels = [d.get('label', '') for d in data]
    values = [d.get('value', 0) for d in data]
    n = len(labels)
    fig_h = max(5, n * 0.35)
    plt.figure(figsize=(9, fig_h))
    y_pos = range(n)
    colors = plt.cm.viridis(np.linspace(0.2, 0.9, n))
    plt.hlines(y=y_pos, xmin=0, xmax=values, color=colors, alpha=0.7, linewidth=2)
    plt.scatter(values, y_pos, color=colors, s=60, zorder=5, edgecolors='white', linewidth=0.5)
    plt.yticks(y_pos, labels, fontsize=8)
    for i, v in enumerate(values):
        if v is not None and v > 0:
            plt.annotate(f'{v:,.1f}', (v, i), fontsize=6.5, alpha=0.7,
                         textcoords='offset points', xytext=(6, 0), va='center')
    plt.gca().invert_yaxis()
    _apply_title(chart)
    _apply_labels(chart, swap=True)
    plt.grid(axis='x', alpha=0.3, linestyle='--')
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_diverging_bar(chart, out_path):
    """Bars diverge left/right from center — great for enrichment ratios or fold change."""
    data = chart.get('data', [])
    labels = [d.get('label', '') for d in data]
    values = [d.get('value', 0) for d in data]
    n = len(labels)
    fig_h = max(5, n * 0.35)
    plt.figure(figsize=(10, fig_h))
    colors = ['#E45756' if v >= 0 else '#4C78A8' for v in values]
    y_pos = range(n)
    plt.barh(y_pos, values, color=colors, edgecolor='white', linewidth=0.5, height=0.7)
    plt.yticks(y_pos, labels, fontsize=8)
    plt.axvline(x=0, color='black', linewidth=0.8)
    for i, v in enumerate(values):
        offset = 4 if v >= 0 else -4
        ha = 'left' if v >= 0 else 'right'
        plt.annotate(f'{v:,.1f}', (v, i), fontsize=6.5, alpha=0.7,
                     textcoords='offset points', xytext=(offset, 0), va='center', ha=ha)
    plt.gca().invert_yaxis()
    _apply_title(chart)
    _apply_labels(chart, swap=True)
    plt.grid(axis='x', alpha=0.3, linestyle='--')
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_radar(chart, out_path):
    """Spider/radar chart — each series is a polygon across axes."""
    series_list = chart.get('series', [])
    axes_labels = chart.get('axes', [])
    if not series_list or not axes_labels:
        return
    n_axes = len(axes_labels)
    angles = np.linspace(0, 2 * np.pi, n_axes, endpoint=False).tolist()
    angles += angles[:1]  # close the polygon

    fig, ax = plt.subplots(figsize=(8, 8), subplot_kw=dict(polar=True))
    cmap = plt.cm.Set2
    for i, s in enumerate(series_list):
        vals = s.get('values', [0] * n_axes)
        vals = vals + vals[:1]  # close
        color = cmap(i / max(1, len(series_list) - 1)) if len(series_list) > 1 else cmap(0.3)
        ax.plot(angles, vals, 'o-', linewidth=2, label=s.get('label', f'Series {i+1}'), color=color)
        ax.fill(angles, vals, alpha=0.15, color=color)
    ax.set_xticks(angles[:-1])
    ax.set_xticklabels(axes_labels, fontsize=8)
    ax.set_yticklabels([])
    # Add value rings
    max_val = max(max(s.get('values', [0])) for s in series_list)
    if max_val > 0:
        ticks = np.linspace(0, max_val, 5)[1:]
        ax.set_yticks(ticks)
        ax.set_yticklabels([f'{t:,.0f}' for t in ticks], fontsize=6, alpha=0.5)
    ax.grid(True, alpha=0.3)
    _apply_title(chart)
    if len(series_list) > 1:
        ax.legend(loc='upper right', bbox_to_anchor=(1.3, 1.1), fontsize=8)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_waterfall(chart, out_path):
    """Waterfall chart — cascading bars showing cumulative changes."""
    data = chart.get('data', [])
    labels = [d.get('label', '') for d in data]
    values = [d.get('value', 0) for d in data]
    n = len(labels)
    cumulative = [0] * n
    cumulative[0] = values[0]
    for i in range(1, n):
        cumulative[i] = cumulative[i-1] + values[i]
    bottoms = [0] * n
    bottoms[0] = 0
    for i in range(1, n):
        bottoms[i] = cumulative[i-1] if values[i] >= 0 else cumulative[i]
    colors = []
    for i, v in enumerate(values):
        if i == 0 or i == n - 1:
            colors.append('#4C78A8')
        elif v >= 0:
            colors.append('#72B7B2')
        else:
            colors.append('#E45756')
    fig_w = max(8, n * 0.5)
    plt.figure(figsize=(fig_w, 5))
    bars = plt.bar(range(n), [abs(v) for v in values], bottom=bottoms, color=colors,
                   edgecolor='white', linewidth=0.5, width=0.6)
    # Connector lines between bars
    for i in range(n - 1):
        plt.plot([i + 0.3, i + 0.7], [cumulative[i], cumulative[i]],
                 color='gray', linewidth=0.8, linestyle='--')
    plt.xticks(range(n), labels, rotation=30, ha='right', fontsize=8)
    for i, v in enumerate(values):
        y = cumulative[i]
        plt.annotate(f'{v:+,.1f}' if i > 0 else f'{v:,.1f}', (i, y),
                     fontsize=6.5, ha='center', va='bottom' if v >= 0 else 'top',
                     textcoords='offset points', xytext=(0, 4 if v >= 0 else -4))
    _apply_title(chart)
    _apply_labels(chart)
    plt.grid(axis='y', alpha=0.3, linestyle='--')
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_volcano(chart, out_path):
    """Volcano plot — fold change (x) vs significance (y). Classic for differential expression."""
    data = chart.get('data', [])
    xs = [d.get('x', 0) for d in data]
    ys = [d.get('y', 0) for d in data]
    point_labels = [d.get('label', '') for d in data]
    fc_thresh = chart.get('fc_threshold', 1.0)
    sig_thresh = chart.get('sig_threshold', 1.3)  # -log10(0.05) ≈ 1.3

    plt.figure(figsize=(9, 7))
    colors = []
    for x, y in zip(xs, ys):
        if abs(x) >= fc_thresh and y >= sig_thresh:
            colors.append('#E45756' if x > 0 else '#4C78A8')
        else:
            colors.append('#BBBBBB')
    plt.scatter(xs, ys, c=colors, alpha=0.6, s=30, edgecolors='none')
    plt.axhline(y=sig_thresh, color='gray', linewidth=0.8, linestyle='--', alpha=0.5)
    plt.axvline(x=fc_thresh, color='gray', linewidth=0.8, linestyle='--', alpha=0.5)
    plt.axvline(x=-fc_thresh, color='gray', linewidth=0.8, linestyle='--', alpha=0.5)
    # Label significant points
    for i, lbl in enumerate(point_labels):
        if lbl and abs(xs[i]) >= fc_thresh and ys[i] >= sig_thresh:
            plt.annotate(lbl, (xs[i], ys[i]), fontsize=6, alpha=0.8,
                         textcoords='offset points', xytext=(4, 4))
    _apply_title(chart)
    _apply_labels(chart)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_bubble(chart, out_path):
    """Bubble chart — scatter with size dimension. Great for expression × enrichment × significance."""
    data = chart.get('data', [])
    xs = [d.get('x', 0) for d in data]
    ys = [d.get('y', 0) for d in data]
    sizes = [d.get('size', 10) for d in data]
    point_labels = [d.get('label', '') for d in data]
    # Normalize sizes to reasonable range
    max_size = max(sizes) if sizes else 1
    norm_sizes = [max(20, (s / max_size) * 500) for s in sizes]
    colors_raw = [d.get('color', None) for d in data]
    if any(c is not None for c in colors_raw):
        color_vals = [c if c is not None else 0 for c in colors_raw]
        cmap = plt.cm.YlOrRd
        norm = plt.Normalize(min(color_vals), max(color_vals))
        colors = cmap(norm(np.array(color_vals)))
    else:
        colors = '#4C78A8'
    plt.figure(figsize=(9, 7))
    sc = plt.scatter(xs, ys, s=norm_sizes, c=colors if isinstance(colors, str) else colors,
                     alpha=0.6, edgecolors='white', linewidth=0.5)
    if not isinstance(colors, str):
        plt.colorbar(sc, shrink=0.8, label=chart.get('color_label', ''))
    for i, lbl in enumerate(point_labels):
        if lbl and xs[i] is not None and ys[i] is not None:
            plt.annotate(lbl, (xs[i], ys[i]), fontsize=6, alpha=0.7,
                         textcoords='offset points', xytext=(4, 4))
    _apply_title(chart)
    _apply_labels(chart)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_ridge(chart, out_path):
    """Ridge/joy plot — overlapping density distributions per group. Dramatic and publication-ready."""
    series_list = chart.get('series', [])
    if not series_list:
        return
    n = len(series_list)
    fig, axes = plt.subplots(n, 1, figsize=(10, max(4, n * 1.2)), sharex=True)
    if n == 1:
        axes = [axes]
    cmap = plt.cm.viridis
    for i, s in enumerate(series_list):
        ax = axes[i]
        vals = s.get('values', [])
        label = s.get('label', '')
        color = cmap(i / max(1, n - 1))
        if len(vals) > 1:
            ax.hist(vals, bins=min(30, max(5, len(vals) // 3)), color=color, alpha=0.7,
                    edgecolor='white', linewidth=0.3, density=True)
        ax.set_yticks([])
        ax.set_ylabel(label, fontsize=8, rotation=0, ha='right', va='center')
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['left'].set_visible(False)
        if i < n - 1:
            ax.spines['bottom'].set_visible(False)
            ax.tick_params(bottom=False)
    _apply_title(chart)
    _apply_labels(chart)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()


def render_chart(chart, out_path):
    chart_type = chart.get('type')
    renderers = {
        'bar': render_bar,
        'line': render_line,
        'scatter': render_scatter,
        'heatmap': render_heatmap,
        'grouped_bar': render_grouped_bar,
        'stacked_bar': render_stacked_bar,
        'dot_plot': render_dot_plot,
        'box': render_box,
        'lollipop': render_lollipop,
        'diverging_bar': render_diverging_bar,
        'radar': render_radar,
        'waterfall': render_waterfall,
        'volcano': render_volcano,
        'bubble': render_bubble,
        'ridge': render_ridge,
    }
    renderer = renderers.get(chart_type)
    if renderer:
        renderer(chart, out_path)
    else:
        plt.figure(figsize=(6, 3))
        plt.title(f'Unsupported chart type: {chart_type}')
        plt.tight_layout()
        _save_figure(plt.gcf(), out_path)
        plt.close()


def main():
    if len(sys.argv) < 3:
        print('Usage: render_charts.py <chart_spec.json> <out_dir>')
        sys.exit(1)

    spec_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(spec_path, 'r', encoding='utf-8') as f:
        spec = json.load(f)

    charts = spec.get('charts', [])
    existing = list(out_dir.glob('chart_*.png'))
    start_idx = len(existing)
    outputs = []
    for i, chart in enumerate(charts):
        out_path = out_dir / f'chart_{start_idx + i + 1}.png'
        render_chart(chart, out_path)
        outputs.append(str(out_path))

    print(json.dumps({'images': outputs}))


if __name__ == '__main__':
    main()
