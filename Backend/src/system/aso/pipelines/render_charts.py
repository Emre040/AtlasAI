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
    """Include the full measured extent of visible labels in the exported image. A log axis keeps
    tick labels for ticks beyond its limits; they sit off the figure and are not part of it."""
    from matplotlib.text import Text
    figure.canvas.draw()
    renderer = figure.canvas.get_renderer()
    labels = [artist for artist in figure.findobj(Text)
              if artist.get_visible() and artist.get_text() and artist.get_window_extent(renderer).overlaps(figure.bbox)]
    figure.savefig(out_path, dpi=150, bbox_inches='tight', bbox_extra_artists=labels)


def _column_values(chart, axis):
    """The plotted values of the x or y column: points for the numeric charts, values for the bar family,
    every value of every group for a box plot."""
    data = chart.get('data', [])
    if chart.get('type') in ('scatter', 'bubble', 'volcano', 'line'):
        return [d.get(axis) for d in data]
    if chart.get('type') == 'box':
        return [v for s in chart.get('series', []) for v in s.get('values', [])] if axis == 'y' else []
    return [d.get('value') for d in data] if axis == 'y' else []


def _log_axis(ax, drawn, values):
    """A log axis; values at or below zero (a zero reading, a log ratio) call for symlog, linear near zero."""
    numbers = [v for v in values if v is not None]
    positives = [abs(v) for v in numbers if v != 0]
    setter = ax.set_xscale if drawn == 'x' else ax.set_yscale
    if numbers and all(v > 0 for v in numbers):
        setter('log')
    else:
        setter('symlog', linthresh=min(positives) if positives else 1.0)
        # Values that are never negative start the axis at zero instead of a margin of negative decades.
        if numbers and min(numbers) >= 0:
            (ax.set_xlim(left=0) if drawn == 'x' else ax.set_ylim(bottom=0))


def _apply_labels(chart, swap=False):
    xl = chart.get('x_label')
    yl = chart.get('y_label')
    if swap:
        xl, yl = yl, xl
    if xl:
        plt.xlabel(xl)
    if yl:
        plt.ylabel(yl)
    # x_scale and y_scale follow the columns; a horizontal chart draws the y column on the x axis.
    for axis in ('x', 'y'):
        if chart.get(f'{axis}_scale') == 'log':
            drawn = ('y' if axis == 'x' else 'x') if swap else axis
            _log_axis(plt.gca(), drawn, _column_values(chart, axis))
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


def _category_layout(labels, base_width=8.0, base_height=4.0):
    """Figure size and tick rotation for a category axis: room for every category, at most a
    page wide; short labels stay level, longer ones turn so they never overlap, and the figure
    grows by the room the turned labels take so the plot itself keeps its height."""
    n = max(1, len(labels))
    longest = max((len(str(label)) for label in labels), default=0)
    width = min(24.0, max(base_width, n * 0.45 + 2.0))
    if longest <= 8 and n <= 8:
        return width, base_height, 0, 'center'
    if longest <= 20:
        return width, base_height + min(4.0, longest * 0.06), 45, 'right'
    return width, base_height + min(6.0, longest * 0.085), 90, 'center'


def render_bar(chart, out_path):
    data = chart.get('data', [])
    labels = [d.get('label', '') for d in data]
    values = [d.get('value', 0) for d in data]
    fig_w, fig_h, rotation, ha = _category_layout(labels)
    plt.figure(figsize=(fig_w, fig_h))
    plt.bar(labels, values, color='#4C78A8')
    _apply_title(chart)
    _apply_labels(chart)
    plt.xticks(rotation=rotation, ha=ha)
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
    """Label points where a label fits beside its point. Eight spots around the point are tried,
    nearest first; a label that would cover another point or label, or leave the axes, is not
    drawn. The figure keeps its size; the caller learns how many labels fit."""
    fig = ax.figure
    labels = [(i, str(point.get('label', ''))) for i, point in enumerate(data)
              if point.get('label') and point.get('x') is not None and point.get('y') is not None]
    if not labels:
        return [], 0, 0
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    bounds = ax.get_window_extent(renderer)
    padding, marker = 2.0, 4.0
    sizes = {}
    for i, label in labels:
        text = ax.text(0, 0, label, fontsize=7)
        box = text.get_window_extent(renderer)
        sizes[i] = (box.width, box.height)
        text.remove()
    points = np.array([ax.transData.transform((p['x'], p['y'])) for p in data
                       if p.get('x') is not None and p.get('y') is not None], dtype=float).reshape(-1, 2)
    # Boxes nothing may cover: every point (a square around its marker), then each placed label.
    taken = np.column_stack([points[:, 0] - marker, points[:, 1] - marker, points[:, 0] + marker, points[:, 1] + marker]) if len(points) else np.zeros((0, 4))
    placed = []
    for i, label in labels:
        px, py = ax.transData.transform((data[i]['x'], data[i]['y']))
        w, h = sizes[i]
        gap = marker + padding
        spots = [(px + gap, py - h / 2), (px - gap - w, py - h / 2), (px - w / 2, py + gap), (px - w / 2, py - gap - h),
                 (px + gap, py + gap), (px + gap, py - gap - h), (px - gap - w, py + gap), (px - gap - w, py - gap - h)]
        for x0, y0 in spots:
            x1, y1 = x0 + w, y0 + h
            if x0 < bounds.x0 or x1 > bounds.x1 or y0 < bounds.y0 or y1 > bounds.y1:
                continue
            overlaps = (x0 < taken[:, 2] + padding) & (x1 + padding > taken[:, 0]) & (y0 < taken[:, 3] + padding) & (y1 + padding > taken[:, 1])
            if overlaps.any():
                continue
            taken = np.vstack([taken, [x0, y0, x1, y1]])
            placed.append((i, label, x0, y0))
            break
    annotations = []
    for i, label, x0, y0 in placed:
        position = ax.transAxes.inverted().transform((x0, y0))
        annotations.append(ax.annotate(label, (data[i]['x'], data[i]['y']), xytext=position, textcoords='axes fraction',
                                       ha='left', va='bottom', fontsize=7, alpha=0.9))
    return annotations, len(placed), len(labels)


def _groups(data):
    """Distinct group labels in order of appearance, or None when the points carry no group."""
    if not any('group' in d and d.get('group') not in (None, '') for d in data):
        return None
    seen = []
    for d in data:
        g = d.get('group', '')
        if g not in seen:
            seen.append(g)
    return seen


def _group_colors(groups):
    palette = plt.get_cmap('tab10' if len(groups) <= 10 else 'tab20')
    return {g: palette(i % palette.N) for i, g in enumerate(groups)}


def _legend_outside(ax):
    ax.legend(loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0, fontsize=8)


def render_scatter(chart, out_path):
    data = chart.get('data', [])
    fig, ax = plt.subplots(figsize=(8, 6))
    groups = _groups(data)
    if groups:
        colors = _group_colors(groups)
        for g in groups:
            pts = [d for d in data if d.get('group', '') == g]
            ax.scatter([d.get('x') for d in pts], [d.get('y') for d in pts], alpha=0.75, s=40, color=colors[g], label=str(g))
        _legend_outside(ax)
    else:
        ax.scatter([d.get('x') for d in data], [d.get('y') for d in data], alpha=0.7, s=40)
    _apply_title(chart)
    _apply_labels(chart)
    fig.tight_layout()
    _, placed, total = _place_scatter_labels(ax, data)
    _save_figure(fig, out_path)
    plt.close(fig)
    return {'labels': total, 'placed': placed} if total else None

def render_dot_plot(chart, out_path):
    data = chart.get('data', [])
    labels = [d.get('label', '') for d in data]
    values = [d.get('value', 0) for d in data]
    groups = _groups(data)
    if groups:
        # One row per label, one colour per group: the same entity across groups stays on one line.
        rows = []
        for l in labels:
            if l not in rows:
                rows.append(l)
        fig, ax = plt.subplots(figsize=(8, max(4, len(rows) * 0.3)))
        colors = _group_colors(groups)
        index = {l: i for i, l in enumerate(rows)}
        for g in groups:
            pts = [d for d in data if d.get('group', '') == g]
            ax.scatter([d.get('value', 0) for d in pts], [index[d.get('label', '')] for d in pts], alpha=0.85, s=40, color=colors[g], label=str(g))
        ax.set_yticks(range(len(rows)))
        ax.set_yticklabels(rows)
        _legend_outside(ax)
    else:
        plt.figure(figsize=(8, max(4, len(labels) * 0.3)))
        plt.scatter(values, range(len(labels)), alpha=0.8, s=40)
        plt.yticks(range(len(labels)), labels)
    # The first row is drawn at the top, so a ranked table reads top down.
    plt.gca().invert_yaxis()
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
    fig_w, fig_h, rotation, ha = _category_layout(labels, base_width=6.0)
    plt.figure(figsize=(fig_w, fig_h))
    plt.boxplot(data, tick_labels=labels)
    plt.xticks(rotation=rotation, ha=ha)
    _apply_title(chart)
    _apply_labels(chart)
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()

def render_stacked_bar(chart, out_path):
    data = chart.get('data', [])
    # The study names each segment's series as group; categories and segments keep the table's order.
    stack_of = lambda d: d.get('stack', d.get('group'))
    categories = list(dict.fromkeys(d.get('label') for d in data))
    stacks = list(dict.fromkeys(stack_of(d) for d in data))
    stack_map = {s: [] for s in stacks}
    for c in categories:
        for s in stacks:
            v = next((d.get('value', 0) for d in data if d.get('label') == c and stack_of(d) == s), 0)
            stack_map[s].append(v)
    fig_w, fig_h, rotation, ha = _category_layout(categories)
    plt.figure(figsize=(fig_w, fig_h))
    bottoms = [0] * len(categories)
    for s in stacks:
        vals = stack_map[s]
        plt.bar(categories, vals, bottom=bottoms, label=str(s))
        bottoms = [b + v for b, v in zip(bottoms, vals)]
    _apply_title(chart)
    _apply_labels(chart)
    if len(stacks) > 1:
        plt.legend(loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0)
    plt.xticks(rotation=rotation, ha=ha)
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
    norm = None
    if chart.get('scale') == 'log':
        present = values.compressed()
        positives = np.abs(present[present != 0])
        if present.size and (present > 0).all():
            norm = mcolors.LogNorm(vmin=present.min(), vmax=present.max())
        else:
            norm = mcolors.SymLogNorm(linthresh=positives.min() if positives.size else 1.0, vmin=present.min() if present.size else 0, vmax=present.max() if present.size else 1)
    plt.imshow(values, aspect='auto', cmap=palette, norm=norm)
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
    fig_w, fig_h, rotation, ha = _category_layout(categories)
    plt.figure(figsize=(fig_w, fig_h))
    for i, g in enumerate(groups):
        plt.bar(x + i*width, values[i], width, label=str(g))
    plt.xticks(x + width*(len(groups)-1)/2, categories, rotation=rotation, ha=ha)
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
    groups = _groups(data)
    if groups:
        group_colors = _group_colors(groups)
        colors = [group_colors[d.get('group', '')] for d in data]
    else:
        colors = plt.cm.viridis(np.linspace(0.2, 0.9, n))
    plt.hlines(y=y_pos, xmin=0, xmax=values, color=colors, alpha=0.7, linewidth=2)
    plt.scatter(values, y_pos, color=colors, s=60, zorder=5, edgecolors='white', linewidth=0.5)
    if groups:
        from matplotlib.lines import Line2D
        plt.legend(handles=[Line2D([0], [0], marker='o', color='w', markerfacecolor=group_colors[g], markersize=8, label=str(g)) for g in groups], loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0, fontsize=8)
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
    # The first bar starts the run; every later bar is a change, up or down; a last bar shows the total from zero.
    colors = ['#4C78A8' if i == 0 else '#72B7B2' if v >= 0 else '#E45756' for i, v in enumerate(values)]
    fig_w = max(8, (n + 1) * 0.5)
    plt.figure(figsize=(fig_w, 5))
    bars = plt.bar(range(n), [abs(v) for v in values], bottom=bottoms, color=colors,
                   edgecolor='white', linewidth=0.5, width=0.6)
    plt.bar(n, cumulative[-1], bottom=0, color='#4C78A8', edgecolor='white', linewidth=0.5, width=0.6)
    # Connector lines between bars
    for i in range(n):
        plt.plot([i + 0.3, i + 0.7], [cumulative[i], cumulative[i]],
                 color='gray', linewidth=0.8, linestyle='--')
    plt.xticks(range(n + 1), labels + ['Total'], rotation=30, ha='right', fontsize=8)
    for i, v in enumerate(values):
        y = cumulative[i]
        plt.annotate(f'{v:+,.1f}' if i > 0 else f'{v:,.1f}', (i, y),
                     fontsize=6.5, ha='center', va='bottom' if v >= 0 else 'top',
                     textcoords='offset points', xytext=(0, 4 if v >= 0 else -4))
    plt.annotate(f'{cumulative[-1]:,.1f}', (n, cumulative[-1]), fontsize=6.5, ha='center', va='bottom' if cumulative[-1] >= 0 else 'top',
                 textcoords='offset points', xytext=(0, 4 if cumulative[-1] >= 0 else -4))
    plt.axhline(0, color='black', linewidth=0.6)
    # Room above and below for the value labels (bars pin autoscaling to their edges, so the limits are set).
    ends = [0.0] + list(cumulative) + list(bottoms)
    low, high = min(ends), max(ends)
    pad = 0.12 * (high - low) if high > low else 1.0
    plt.ylim(low - pad, high + pad)
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
    groups = _groups(data)
    plt.figure(figsize=(9, 7))
    if groups:
        group_colors = _group_colors(groups)
        for g in groups:
            idx = [i for i, d in enumerate(data) if d.get('group', '') == g]
            plt.scatter([xs[i] for i in idx], [ys[i] for i in idx], s=[norm_sizes[i] for i in idx], color=group_colors[g],
                        alpha=0.6, edgecolors='white', linewidth=0.5, label=str(g))
        plt.legend(loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0, fontsize=8)
    else:
        if any(c is not None for c in colors_raw):
            color_vals = [c if c is not None else 0 for c in colors_raw]
            cmap = plt.cm.YlOrRd
            norm = plt.Normalize(min(color_vals), max(color_vals))
            colors = cmap(norm(np.array(color_vals)))
        else:
            colors = '#4C78A8'
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
    # The title heads the whole figure; the values run along the x axis, so the y column's label names
    # them, and each panel is named by its group.
    if chart.get('title'):
        fig.suptitle(chart['title'], fontsize=12)
    if chart.get('y_label'):
        axes[-1].set_xlabel(chart['y_label'])
    plt.tight_layout()
    _save_figure(fig, out_path)
    plt.close(fig)


# Embeddings: each row of a pivot is a point, placed by its values across the columns.

def _embedding_matrix(chart):
    """The pivot's rows as points; scale=log takes log(1 + value) first, the way expression is read.
    The spec leaves out rows with a missing value, so every cell is a number."""
    values = np.asarray(chart.get('matrix', []), dtype=float)
    if chart.get('scale') == 'log':
        values = np.sign(values) * np.log1p(np.abs(values))
    return values


def _pca(values, k=2):
    """Principal components of the centred values: each row's coordinates and the share of the variance
    each component carries. A component's largest loading is made positive, so a table always draws the
    same picture."""
    centred = values - values.mean(axis=0)
    u, s, vt = np.linalg.svd(centred, full_matrices=False)
    coords = np.zeros((values.shape[0], k))
    m = min(k, len(s))
    coords[:, :m] = u[:, :m] * s[:m]
    total = float((s ** 2).sum())
    shares = np.zeros(k)
    if total > 0:
        shares[:m] = (s[:m] ** 2) / total
    for c in range(m):
        if vt[c, np.argmax(np.abs(vt[c]))] < 0:
            coords[:, c] *= -1
    return coords, shares


def _umap(values, n_neighbors=15, min_dist=0.1, negative_rate=5, seed=42):
    """UMAP (McInnes, Healy and Melville, 2018) with the reference implementation's defaults. Each point's
    nearest neighbours (Euclidean; the point itself counts as the first of n_neighbors) get weights
    exp(-(d - rho) / sigma), with rho the distance to the nearest neighbour and sigma set so the weights sum
    to log2(n_neighbors); the graph is the fuzzy union of these, and a 2-D layout is optimised by
    stochastic gradient descent, each edge sampled in proportion to its weight with five negative samples,
    under the reference's curve for min_dist 0.1. The layout starts from the principal components (the
    reference's 'pca' start) and the random seed is fixed, so a table always draws the same picture."""
    from scipy.optimize import curve_fit
    from scipy.sparse import coo_matrix
    n = values.shape[0]
    k = max(1, min(n_neighbors - 1, n - 1))
    # Nearest neighbours, a block of rows at a time so memory stays bounded.
    knn = np.empty((n, k), dtype=np.int64)
    knn_d = np.empty((n, k))
    squares = (values ** 2).sum(axis=1)
    for start in range(0, n, 1024):
        stop = min(n, start + 1024)
        d2 = np.maximum(squares[start:stop, None] + squares[None, :] - 2.0 * values[start:stop] @ values.T, 0.0)
        d2[np.arange(stop - start), np.arange(start, stop)] = np.inf
        idx = np.argpartition(d2, k - 1, axis=1)[:, :k]
        near = np.take_along_axis(d2, idx, axis=1)
        order = np.argsort(near, axis=1)
        knn[start:stop] = np.take_along_axis(idx, order, axis=1)
        knn_d[start:stop] = np.sqrt(np.take_along_axis(near, order, axis=1))
    # rho: the nearest non-zero distance; sigma by bisection, as the reference does it.
    rho = np.array([row[row > 0][0] if (row > 0).any() else 0.0 for row in knn_d])
    gaps = np.maximum(knn_d - rho[:, None], 0.0)
    target = np.log2(n_neighbors)
    lo, hi, mid = np.zeros(n), np.full(n, np.inf), np.ones(n)
    for _ in range(64):
        total = np.exp(-gaps / mid[:, None]).sum(axis=1)
        above = total > target
        hi = np.where(above, mid, hi)
        lo = np.where(above, lo, mid)
        mid = np.where(np.isinf(hi), mid * 2.0, (lo + hi) / 2.0)
    floor = 1e-3 * np.where(rho > 0, knn_d.mean(axis=1), knn_d.mean())
    sigma = np.maximum(mid, floor)
    weights = np.exp(-gaps / sigma[:, None])
    graph = coo_matrix((weights.ravel(), (np.repeat(np.arange(n), k), knn.ravel())), shape=(n, n)).tocsr()
    graph = (graph + graph.T - graph.multiply(graph.T)).tocoo()
    n_epochs = 500 if n <= 10000 else 200
    keep = graph.data >= graph.data.max() / n_epochs
    head, tail, w = graph.row[keep], graph.col[keep], graph.data[keep]
    # The reference's curve 1 / (1 + a d^(2b)) for min_dist and a spread of 1.
    xs = np.linspace(0, 3, 300)
    (a, b), _ = curve_fit(lambda x, a, b: 1.0 / (1.0 + a * x ** (2 * b)), xs, np.where(xs < min_dist, 1.0, np.exp(-(xs - min_dist))))
    rng = np.random.default_rng(seed)
    start, _ = _pca(values)
    span = np.abs(start).max()
    start = start * (10.0 / span) if span > 0 else rng.normal(size=(n, 2))
    start = start + rng.normal(scale=1e-4, size=start.shape)
    lows, highs = start.min(axis=0), start.max(axis=0)
    layout = 10.0 * (start - lows) / np.where(highs > lows, highs - lows, 1.0)
    every = w.max() / w
    due_at = every.copy()

    def move(points, steps):
        # Every step a point takes this epoch, summed per point (bincount is the fast form of np.add.at).
        for dim in range(2):
            layout[:, dim] += np.bincount(points, weights=steps[:, dim], minlength=n)

    for epoch in range(n_epochs):
        alpha = 1.0 - epoch / n_epochs
        due = due_at <= epoch
        if not due.any():
            continue
        h, t = head[due], tail[due]
        diff = layout[h] - layout[t]
        d2 = (diff ** 2).sum(axis=1)
        coef = np.zeros_like(d2)
        positive = d2 > 0
        coef[positive] = -2.0 * a * b * d2[positive] ** (b - 1.0) / (1.0 + a * d2[positive] ** b)
        step = np.clip(coef[:, None] * diff, -4.0, 4.0) * alpha
        move(h, step)
        move(t, -step)
        hn = np.repeat(h, negative_rate)
        tn = rng.integers(0, n, size=hn.size)
        diff = layout[hn] - layout[tn]
        d2 = (diff ** 2).sum(axis=1)
        coef = np.zeros_like(d2)
        positive = d2 > 0
        coef[positive] = 2.0 * b / ((0.001 + d2[positive]) * (1.0 + a * d2[positive] ** b))
        step = np.where(coef[:, None] > 0, np.clip(coef[:, None] * diff, -4.0, 4.0), 4.0) * alpha
        step[hn == tn] = 0.0
        move(hn, step)
        due_at[due] += every[due]
    return layout


def _embedding_scatter(chart, out_path, coords, x_label, y_label, hide_ticks):
    """A point per row of the pivot, coloured by the column holding its largest value while there are few
    enough such columns to tell apart, and named where a label fits (up to 60 points)."""
    values = np.asarray(chart.get('matrix', []), dtype=float)
    rows = [str(r) for r in chart.get('row_labels', [])]
    cols = [str(c) for c in chart.get('col_labels', [])]
    fig, ax = plt.subplots(figsize=(8, 6))
    top = [cols[j] for j in np.argmax(values, axis=1)] if cols else []
    groups = list(dict.fromkeys(top))
    if 1 < len(groups) <= 12:
        colors = _group_colors(groups)
        for g in groups:
            idx = [i for i, name in enumerate(top) if name == g]
            ax.scatter(coords[idx, 0], coords[idx, 1], s=30, alpha=0.8, color=colors[g], label=g)
        ax.legend(title='Highest in', loc='upper left', bbox_to_anchor=(1.02, 1), borderaxespad=0, fontsize=8, title_fontsize=8)
    else:
        ax.scatter(coords[:, 0], coords[:, 1], s=30, alpha=0.8, color='#4C78A8')
    ax.set_xlabel(x_label)
    ax.set_ylabel(y_label)
    if hide_ticks:
        ax.set_xticks([])
        ax.set_yticks([])
    _apply_title(chart)
    fig.tight_layout()
    data = [{'x': float(x), 'y': float(y), 'label': rows[i] if len(rows) <= 60 and i < len(rows) else ''} for i, (x, y) in enumerate(coords)]
    _, placed, total = _place_scatter_labels(ax, data)
    _save_figure(fig, out_path)
    plt.close(fig)
    return {'labels': total, 'placed': placed} if total else None


def render_pca(chart, out_path):
    coords, shares = _pca(_embedding_matrix(chart))
    return _embedding_scatter(chart, out_path, coords, f'PC1 ({shares[0]:.1%} of variance)', f'PC2 ({shares[1]:.1%} of variance)', False)


def render_umap(chart, out_path):
    return _embedding_scatter(chart, out_path, _umap(_embedding_matrix(chart)), 'UMAP 1', 'UMAP 2', True)


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
        'pca': render_pca,
        'umap': render_umap,
    }
    renderer = renderers.get(chart_type)
    if renderer:
        return renderer(chart, out_path)
    plt.figure(figsize=(6, 3))
    plt.title(f'Unsupported chart type: {chart_type}')
    plt.tight_layout()
    _save_figure(plt.gcf(), out_path)
    plt.close()
    return None


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
    outputs, notes = [], []
    for i, chart in enumerate(charts):
        out_path = out_dir / f'chart_{start_idx + i + 1}.png'
        notes.append(render_chart(chart, out_path) or {})
        outputs.append(str(out_path))

    # A note per chart says what the rendering could not show, such as labels that did not fit.
    print(json.dumps({'images': outputs, 'notes': notes}))


if __name__ == '__main__':
    main()
