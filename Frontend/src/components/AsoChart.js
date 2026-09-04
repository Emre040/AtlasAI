import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinner, faFileCode } from '@fortawesome/free-solid-svg-icons';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import { authenticatedFetch } from '../api/auth';

// Renders a chart specification artifact (the JSON a study's chart node stores) with Plotly.
const Plot = createPlotlyComponent(Plotly);

const PLOTLY_COLORS = ['#636efa','#ef553b','#00cc96','#ab63fa','#ffa15a','#19d3f3','#ff6692','#b6e880','#ff97ff','#fecb52'];

export function specToPlotly(chart) {
  const t = chart.type;
  const data = [];
  const layout = {
    title: chart.title || '',
    xaxis: { title: { text: chart.x_label || '', standoff: 10 } },
    yaxis: { title: { text: chart.y_label || '', standoff: 10 } },
    margin: { t: 20, r: 20, b: 60, l: 70 },
    font: { size: 11 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    showlegend: false,
    autosize: true
  };

  if (t === 'bar') {
    data.push({ type: 'bar', x: chart.data.map(d => d.label), y: chart.data.map(d => d.value), marker: { color: PLOTLY_COLORS[0] } });
  } else if (t === 'lollipop') {
    const labels = chart.data.map(d => d.label);
    const values = chart.data.map(d => d.value);
    for (let li = 0; li < labels.length; li++) {
      data.push({ type: 'scatter', mode: 'lines', x: [labels[li], labels[li]], y: [0, values[li]], line: { color: PLOTLY_COLORS[0], width: 2 }, showlegend: false, hoverinfo: 'skip' });
    }
    data.push({ type: 'scatter', mode: 'markers', x: labels, y: values, marker: { color: PLOTLY_COLORS[0], size: 10 }, showlegend: false });
  } else if (t === 'diverging_bar') {
    data.push({ type: 'bar', y: chart.data.map(d => d.label), x: chart.data.map(d => d.value), orientation: 'h',
      marker: { color: chart.data.map(d => d.value >= 0 ? PLOTLY_COLORS[2] : PLOTLY_COLORS[1]) } });
    layout.xaxis.zeroline = true;
  } else if (t === 'dot_plot') {
    data.push({ type: 'scatter', mode: 'markers', y: chart.data.map(d => d.label), x: chart.data.map(d => d.value),
      marker: { color: PLOTLY_COLORS[0], size: 9 } });
  } else if (t === 'waterfall') {
    data.push({ type: 'waterfall', x: chart.data.map(d => d.label), y: chart.data.map(d => d.value),
      connector: { line: { color: '#94a3b8' } },
      increasing: { marker: { color: PLOTLY_COLORS[2] } },
      decreasing: { marker: { color: PLOTLY_COLORS[1] } } });
  } else if (t === 'scatter') {
    const series = {};
    for (const d of chart.data) { const s = d.series || '_'; if (!series[s]) series[s] = { x: [], y: [], text: [] }; series[s].x.push(d.x); series[s].y.push(d.y); series[s].text.push(d.label || ''); }
    const keys = Object.keys(series);
    keys.forEach((s, i) => data.push({ type: 'scatter', mode: 'markers', x: series[s].x, y: series[s].y, text: series[s].text, name: s === '_' ? '' : s, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    if (keys.length > 1) layout.showlegend = true;
  } else if (t === 'bubble') {
    const maxSize = Math.max(...chart.data.map(d => d.size || 1));
    data.push({ type: 'scatter', mode: 'markers', x: chart.data.map(d => d.x), y: chart.data.map(d => d.y), text: chart.data.map(d => d.label || ''),
      marker: { size: chart.data.map(d => Math.max(4, (d.size / maxSize) * 50)), color: chart.data.map(d => d.color ?? d.size), colorscale: 'Viridis', showscale: !!chart.color_label, colorbar: { title: chart.color_label || '' } } });
  } else if (t === 'volcano') {
    const fc = chart.fc_threshold || 1.0;
    const sig = chart.sig_threshold || 1.3;
    const colors = chart.data.map(d => Math.abs(d.x) >= fc && d.y >= sig ? (d.x > 0 ? PLOTLY_COLORS[1] : PLOTLY_COLORS[2]) : '#94a3b8');
    data.push({ type: 'scatter', mode: 'markers', x: chart.data.map(d => d.x), y: chart.data.map(d => d.y), text: chart.data.map(d => d.label || ''),
      marker: { color: colors, size: 5 } });
    layout.shapes = [
      { type: 'line', x0: -fc, x1: -fc, y0: 0, y1: 1, yref: 'paper', line: { dash: 'dash', color: '#94a3b8' } },
      { type: 'line', x0: fc, x1: fc, y0: 0, y1: 1, yref: 'paper', line: { dash: 'dash', color: '#94a3b8' } },
      { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: sig, y1: sig, line: { dash: 'dash', color: '#94a3b8' } }
    ];
  } else if (t === 'line') {
    const series = {};
    for (const d of chart.data) { const s = d.series || '_'; if (!series[s]) series[s] = { x: [], y: [] }; series[s].x.push(d.x); series[s].y.push(d.y); }
    const keys = Object.keys(series);
    keys.forEach((s, i) => data.push({ type: 'scatter', mode: 'lines+markers', x: series[s].x, y: series[s].y, name: s === '_' ? '' : s, line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    if (keys.length > 1) layout.showlegend = true;
  } else if (t === 'grouped_bar') {
    const groups = {};
    for (const d of chart.data) { if (!groups[d.group]) groups[d.group] = { labels: [], values: [] }; groups[d.group].labels.push(d.label); groups[d.group].values.push(d.value); }
    Object.entries(groups).forEach(([g, v], i) => data.push({ type: 'bar', x: v.labels, y: v.values, name: g, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    layout.barmode = 'group'; layout.showlegend = true;
  } else if (t === 'stacked_bar') {
    const stacks = {};
    for (const d of chart.data) { if (!stacks[d.stack]) stacks[d.stack] = { labels: [], values: [] }; stacks[d.stack].labels.push(d.label); stacks[d.stack].values.push(d.value); }
    Object.entries(stacks).forEach(([s, v], i) => data.push({ type: 'bar', x: v.labels, y: v.values, name: s, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
    layout.barmode = 'stack'; layout.showlegend = true;
  } else if (t === 'heatmap') {
    data.push({ type: 'heatmap', z: chart.matrix, x: chart.col_labels, y: chart.row_labels, colorscale: 'YlOrRd', reversescale: true });
    layout.yaxis.autorange = 'reversed';
    layout.margin.l = 100;
  } else if (t === 'radar') {
    for (let i = 0; i < chart.series.length; i++) {
      const s = chart.series[i];
      data.push({ type: 'scatterpolar', r: [...s.values, s.values[0]], theta: [...chart.axes, chart.axes[0]], fill: 'toself', name: s.label, line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } });
    }
    layout.showlegend = chart.series.length > 1;
    delete layout.xaxis; delete layout.yaxis;
    layout.polar = { radialaxis: { visible: true } };
  } else if (t === 'box') {
    chart.series.forEach((s, i) => data.push({ type: 'box', y: s.values, name: s.label, marker: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
  } else if (t === 'ridge') {
    chart.series.forEach((s, i) => data.push({ type: 'violin', y: s.values, name: s.label, box: { visible: true }, meanline: { visible: true }, line: { color: PLOTLY_COLORS[i % PLOTLY_COLORS.length] } }));
  } else {
    // Fallback: try bar if data has label+value
    if (chart.data?.length) {
      data.push({ type: 'bar', x: chart.data.map(d => d.label || ''), y: chart.data.map(d => d.value || 0) });
    }
  }
  return { data, layout };
}

export default function AsoChart({ apiBaseUrl, workspaceUuid, artifactId, title, sourceDatasetId, onArtifactEnter, onArtifactLeave }) {
  const [spec, setSpec] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!workspaceUuid || !artifactId) return;
    let cancelled = false;
    authenticatedFetch(`${apiBaseUrl}/workspaces/${workspaceUuid}/artifacts/${artifactId}.json`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(json => { if (!cancelled) setSpec(json); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [apiBaseUrl, workspaceUuid, artifactId]);

  if (error) return <div className="HPAG-aso-chart-error">Chart failed to load</div>;
  if (!spec) return <div className="HPAG-aso-chart-loading"><FontAwesomeIcon icon={faSpinner} spin /> Loading chart...</div>;

  const chart = spec.charts?.[0];
  if (!chart) return null;
  const { data, layout } = specToPlotly(chart);
  const chartTitle = title || chart.title || '';
  return (
    <div className="HPAG-aso-chart-item" style={{ position: 'relative' }}>
      <Plot data={data} layout={{ ...layout, title: '' }} useResizeHandler style={{ width: '100%', height: 380 }}
        config={{ displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d','select2d'], responsive: true }} />
      {sourceDatasetId && (
        <span className="HPAG-aso-data-chip HPAG-aso-data-chip-artifact HPAG-aso-chart-source"
          onMouseEnter={e => onArtifactEnter?.(e, { artifactId: sourceDatasetId, format: 'json' }, workspaceUuid)}
          onMouseLeave={() => onArtifactLeave?.()}>
          <FontAwesomeIcon icon={faFileCode} /> {sourceDatasetId.slice(0, 8)}
        </span>
      )}
      {chartTitle && <div className="HPAG-aso-chart-caption">{chartTitle}</div>}
    </div>
  );
}
