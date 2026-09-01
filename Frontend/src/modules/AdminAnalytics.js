import React, { useState } from 'react';
import './AdminAnalytics.css';
import { getApiEndpoint } from './hpaConfig';

const COLORS = ['#0f766e', '#1d4ed8', '#7c3aed', '#be123c', '#ea580c'];

const AdminAnalytics = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authHeader, setAuthHeader] = useState('');
  const [summary, setSummary] = useState(null);
  const [geo, setGeo] = useState([]);
  const [visitors, setVisitors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');

  const hasData = Boolean(summary);

  const buildAuthHeader = (user, pass) => `Basic ${window.btoa(`${user}:${pass}`)}`;

  const fetchJsonWithAuth = async (endpointKey, credsHeader, fallbackMessage) => {
    const resp = await fetch(getApiEndpoint(endpointKey), {
      method: 'GET',
      headers: { Authorization: credsHeader, Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store'
    });
    if (resp.status === 401) throw new Error('Invalid admin credentials.');
    if (!resp.ok) {
      let msg = '';
      try { msg = (await resp.text())?.trim(); } catch {}
      throw new Error(msg || fallbackMessage);
    }
    return resp.json();
  };

  const postWithAuth = async (endpointKey, credsHeader, body, fallbackMessage) => {
    const resp = await fetch(getApiEndpoint(endpointKey), {
      method: 'POST',
      headers: {
        Authorization: credsHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify(body || {})
    });
    if (resp.status === 401) throw new Error('Invalid admin credentials.');
    if (!resp.ok) {
      let msg = '';
      try { msg = (await resp.text())?.trim(); } catch {}
      throw new Error(msg || fallbackMessage);
    }
    return resp.json();
  };

  const fetchAnalytics = async (credsHeader) => {
    const summaryJson = await fetchJsonWithAuth('adminSummary', credsHeader, 'Failed to fetch summary analytics.');
    const geoJson = await fetchJsonWithAuth('adminGeo', credsHeader, 'Failed to fetch geo analytics.');
    const visitorsJson = await fetchJsonWithAuth('adminVisitors', credsHeader, 'Failed to fetch visitors.');
    setSummary(summaryJson);
    setGeo(geoJson?.points || []);
    setVisitors(visitorsJson?.visitors || []);
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    try {
      const header = buildAuthHeader(username.trim(), password);
      await fetchAnalytics(header);
      setAuthHeader(header);
    } catch (err) {
      console.error('[AdminAnalytics] login error:', err);
      setError(err.message || 'Unable to authenticate.');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!authHeader) return;
    setError('');
    setNotice('');
    setLoading(true);
    try {
      await fetchAnalytics(authHeader);
    } catch (err) {
      console.error('[AdminAnalytics] refresh error:', err);
      setError(err.message || 'Failed to refresh analytics. Please log in again.');
    } finally {
      setLoading(false);
    }
  };

  const handleBlock = async (visitorId, action) => {
    if (!authHeader || !visitorId) return;
    setError('');
    setNotice('');
    setActionLoading(`${visitorId}:${action}`);
    try {
      await postWithAuth('adminBlock', authHeader, { visitorId, action }, 'Failed to update block status.');
      setNotice(
        action.startsWith('unblock')
          ? 'Access restored for the selected visitor.'
          : 'Visitor access has been restricted. Changes propagate within a few seconds.'
      );
      await fetchAnalytics(authHeader);
    } catch (err) {
      console.error('[AdminAnalytics] block error:', err);
      setError(err.message || 'Unable to update block settings.');
    } finally {
      setActionLoading('');
    }
  };

  const renderGlobeGradient = () => {
    if (!geo.length) return '#e5e7eb';
    const total = geo.reduce((acc, p) => acc + (p.sessions || 0), 0);
    if (!total) return '#e5e7eb';
    let start = 0;
    const slices = geo.map((point, idx) => {
      const pct = (point.sessions / total) * 100;
      const seg = { color: COLORS[idx % COLORS.length], start, end: start + pct };
      start = seg.end;
      return seg;
    });
    return `conic-gradient(${slices.map(seg => `${seg.color} ${seg.start}% ${seg.end}%`).join(', ')})`;
  };

  const renderGlobeLegend = () => {
    if (!geo.length) return <div className="HPAA-empty">No country data.</div>;
    const total = geo.reduce((acc, point) => acc + (point.sessions || 0), 0) || 1;
    return geo.map((point, idx) => (
      <div key={`${point.country}-${idx}`} className="HPAA-legend-row">
        <span
          className="HPAA-legend-color"
          style={{ backgroundColor: COLORS[idx % COLORS.length] }}
        />
        <span className="HPAA-legend-country">{point.country || 'UNKNOWN'}</span>
        <span className="HPAA-legend-count">{point.sessions} sessions</span>
        <span className="HPAA-legend-percent">
          {((point.sessions / total) * 100).toFixed(1)}%
        </span>
      </div>
    ));
  };

  const formatTimestamp = (value) => {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  const filteredVisitors = visitors.filter(row => {
    if (!filter) return true;
    const needle = filter.toLowerCase();
    return [
      row.visitor_id,
      row.country,
      row.last_ip,
      row.last_user_agent
    ].some(field => (field || '').toLowerCase().includes(needle));
  });

  return (
    <div className="HPAA-container">
      <div className="HPAA-inner">
        <header className="HPAA-header">
        <div>
          <h1>Atlas Admin</h1>
          <p>Monitor request volume and geographic distribution.</p>
        </div>
        {hasData && (
          <button onClick={handleRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
        </header>

        {!hasData && (
          <div className="HPAA-card HPAA-login">
            <form onSubmit={handleLogin}>
              <label>
                Username
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <button type="submit" disabled={loading}>
                {loading ? 'Authenticating…' : 'View Analytics'}
              </button>
              {(error || notice) && (
                <div className={error ? 'HPAA-error' : 'HPAA-notice'}>
                  {error || notice}
                </div>
              )}
            </form>
          </div>
        )}

        {hasData && (
          <>
            <div className="HPAA-stats">
              <div className="HPAA-card">
                <p className="HPAA-statt-label">Unique Visitors</p>
                <p className="HPAA-statt-value">{summary.visitors}</p>
              </div>
              <div className="HPAA-card">
                <p className="HPAA-statt-label">Conversations</p>
                <p className="HPAA-statt-value">{summary.conversations}</p>
              </div>
              <div className="HPAA-card">
                <p className="HPAA-statt-label">Messages</p>
                <p className="HPAA-statt-value">{summary.messages}</p>
              </div>
              <div className="HPAA-card">
                <p className="HPAA-statt-label">Tokens</p>
                <p className="HPAA-statt-value">
                  {summary.tokens?.toLocaleString?.() || summary.tokens || 0}
                </p>
              </div>
            </div>

            <div className="HPAA-card HPAA-geo">
              <div className="HPAA-globe" style={{ backgroundImage: renderGlobeGradient() }}>
                <span>Usage</span>
              </div>
              <div className="HPAA-legend">
                <h2>By country</h2>
                <div className="HPAA-legend-body">{renderGlobeLegend()}</div>
              </div>
            </div>

            <div className="HPAA-card HPAA-sessions">
              <div className="HPAA-sessions-header">
                <div>
                  <h2>Recent Sessions</h2>
                  <p>Last 50 visitors with blocking controls.</p>
                </div>
                <input
                  type="text"
                  placeholder="Filter by visitor, IP, or country"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <div className="HPAA-table-wrapper">
                <table className="HPAA-table">
                  <thead>
                    <tr>
                      <th>Visitor ID</th>
                      <th>Country</th>
                      <th>IP</th>
                      <th>Accesses</th>
                      <th>Last seen</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVisitors.length === 0 && (
                      <tr>
                        <td colSpan={7} className="HPAA-empty-row">No sessions match your filter.</td>
                      </tr>
                    )}
                    {filteredVisitors.map(row => {
                      const fpBlocked = row.block_fingerprint === 1;
                      const ipBlocked = row.block_ip === 1;
                      const fingerprintAction = fpBlocked ? 'unblock_fingerprint' : 'block_fingerprint';
                      const ipAction = ipBlocked ? 'unblock_ip' : 'block_ip';
                      const isFpLoading = actionLoading === `${row.visitor_id}:${fingerprintAction}`;
                      const isIpLoading = actionLoading === `${row.visitor_id}:${ipAction}`;
                      return (
                        <tr key={row.visitor_id}>
                          <td>
                            <code>{row.visitor_id}</code>
                            <div className="HPAA-subtext">{row.last_user_agent || '—'}</div>
                          </td>
                          <td>{row.country || 'UNKNOWN'}</td>
                          <td>{row.last_ip || '—'}</td>
                          <td>{row.access_count}</td>
                          <td>{formatTimestamp(row.last_seen)}</td>
                          <td>
                            <div className="HPAA-pill-row">
                              <span className={`HPAA-pill ${fpBlocked ? 'HPAA-pill-bad' : 'HPAA-pill-ok'}`}>
                                FP
                              </span>
                              <span className={`HPAA-pill ${ipBlocked ? 'HPAA-pill-bad' : 'HPAA-pill-ok'}`}>
                                IP
                              </span>
                            </div>
                          </td>
                          <td className="HPAA-actions">
                            <button
                              className="HPAA-action-btn"
                              onClick={() => handleBlock(row.visitor_id, fingerprintAction)}
                              disabled={isFpLoading}
                            >
                              {isFpLoading ? 'Updating…' : fpBlocked ? 'Unblock FP' : 'Block FP'}
                            </button>
                            <button
                              className="HPAA-action-btn"
                              onClick={() => handleBlock(row.visitor_id, ipAction)}
                              disabled={isIpLoading}
                            >
                              {isIpLoading ? 'Updating…' : ipBlocked ? 'Unblock IP' : 'Block IP'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {(error || notice) && (
              <div className={error ? 'HPAA-error' : 'HPAA-notice'}>
                {error || notice}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default AdminAnalytics;
