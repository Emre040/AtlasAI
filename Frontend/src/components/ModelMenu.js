import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faKey, faSpinner, faTimes, faTrash, faCheck } from '@fortawesome/free-solid-svg-icons';
import { providerLogo } from '../assets/providers';
import { AUTO_MODEL, fetchModelCatalog, removeProviderKey, saveProviderKey } from '../api/models';
import './ModelMenu.css';

function priceLabel(model) {
  if (model.input_price_usd_per_million === null || model.output_price_usd_per_million === null) return 'price not published';
  const usd = value => (value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`);
  return `${usd(model.input_price_usd_per_million)} in · ${usd(model.output_price_usd_per_million)} out / 1M tokens`;
}

function ProviderMark({ providerKey, fallback }) {
  const logo = providerLogo(providerKey);
  if (!logo) return <span className="HPAG-mm-logo-text">{fallback}</span>;
  return <img className="HPAG-mm-logo" src={logo.src} alt={logo.alt} />;
}

function formatWhen(unixMs) {
  return new Date(unixMs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ProviderKeyRow({ provider, bypassSpend, onChanged }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const stored = provider.visitor_key;

  const save = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await saveProviderKey(provider.provider_key, value.trim());
      setValue('');
      setNotice({ ok: true, text: `Verified, ${result.models_visible} models visible to this key.` });
      await onChanged();
    } catch (error) {
      setNotice({ ok: false, text: error.code === 'api_key_rejected' ? 'The provider rejected this key.' : error.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await removeProviderKey(provider.provider_key);
      setNotice({ ok: true, text: 'Key removed.' });
      await onChanged();
    } catch (error) {
      setNotice({ ok: false, text: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="HPAG-mm-key-row">
      <div className="HPAG-mm-key-head">
        <ProviderMark providerKey={provider.provider_key} fallback={provider.display_name} />
        <span className="HPAG-mm-key-provider">{provider.display_name}</span>
        {stored && (
          <span className="HPAG-mm-badge HPAG-mm-badge-ok">
            <FontAwesomeIcon icon={faCheck} /> key ending in {stored.suffix}
          </span>
        )}
      </div>
      <div className="HPAG-mm-key-controls">
        <input
          type="password"
          className="HPAG-mm-key-input"
          placeholder={stored ? 'Paste a new key to replace it' : 'Paste your API key'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && save()}
          disabled={busy}
        />
        <button className="HPAG-mm-btn HPAG-mm-btn-primary" onClick={save} disabled={busy || !value.trim()}>
          {busy ? <FontAwesomeIcon icon={faSpinner} spin /> : 'Verify & save'}
        </button>
        {stored && (
          <button className="HPAG-mm-btn HPAG-mm-btn-danger" onClick={remove} disabled={busy} title="Remove key">
            <FontAwesomeIcon icon={faTrash} />
          </button>
        )}
      </div>
      {stored && (
        <div className="HPAG-mm-key-meta">
          Verified {formatWhen(stored.verified_at)} · used {stored.use_count} {stored.use_count === 1 ? 'time' : 'times'}
          {bypassSpend ? ' · bypasses platform spending limits' : ''}
        </div>
      )}
      {notice && <div className={`HPAG-mm-notice ${notice.ok ? 'HPAG-mm-notice-ok' : 'HPAG-mm-notice-err'}`}>{notice.text}</div>}
    </div>
  );
}

function ProviderKeysModal({ catalog, onClose, onChanged }) {
  useEffect(() => {
    const onKey = event => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="HPAG-mm-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="HPAG-mm-modal" role="dialog" aria-label="Provider API keys">
        <div className="HPAG-mm-modal-head">
          <div>
            <div className="HPAG-mm-modal-title">Your provider keys</div>
            <div className="HPAG-mm-modal-sub">
              Requests to a provider use your key instead of the platform key. Keys are checked with the provider,
              encrypted at rest, and only ever used for your own requests.
            </div>
          </div>
          <button className="HPAG-mm-close" onClick={onClose} aria-label="Close">
            <FontAwesomeIcon icon={faTimes} />
          </button>
        </div>
        <div className="HPAG-mm-modal-body">
          {catalog.providers.map(provider => (
            <ProviderKeyRow
              key={provider.provider_key}
              provider={provider}
              bypassSpend={catalog.visitor_keys_bypass_spend_limits}
              onChanged={onChanged}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ModelMenu({ selectedModel, onSelectModel }) {
  const [catalog, setCatalog] = useState(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const rootRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setCatalog(await fetchModelCatalog());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const models = useMemo(() => catalog?.models || [], [catalog]);
  const current = selectedModel === AUTO_MODEL ? null : models.find(model => model.config_key === selectedModel) || null;

  // A remembered choice that is no longer offered silently returns to Auto.
  useEffect(() => {
    if (catalog && selectedModel !== AUTO_MODEL && !current) onSelectModel(AUTO_MODEL);
  }, [catalog, selectedModel, current, onSelectModel]);

  const groups = useMemo(() => {
    const byProvider = new Map();
    for (const model of models) {
      if (!byProvider.has(model.provider)) {
        byProvider.set(model.provider, { provider: model.provider, displayName: model.provider_display_name, models: [] });
      }
      byProvider.get(model.provider).models.push(model);
    }
    return [...byProvider.values()];
  }, [models]);

  const choose = key => {
    onSelectModel(key);
    setOpen(false);
  };

  const active = catalog?.active || null;
  const headline = current ? current.display_name : 'Auto';
  const closeKeys = useCallback(() => setShowKeys(false), []);

  return (
    <div className="HPAG-model-selector" ref={rootRef}>
      <button className="HPAG-model-button" onClick={() => setOpen(value => !value)} aria-haspopup="menu" aria-expanded={open}>
        <span className="HPAG-model-name">AtlasAI</span>
        <span className="HPAG-model-version">{headline}</span>
        {current && <ProviderMark providerKey={current.provider} fallback={current.provider_display_name} />}
        <FontAwesomeIcon icon={faChevronDown} className="HPAG-mm-chevron" />
      </button>
      {open && (
        <div className="HPAG-model-dropdown HPAG-mm-dropdown" role="menu">
          <button
            className={`HPAG-model-item HPAG-mm-item ${selectedModel === AUTO_MODEL ? 'HPAG-model-active' : ''}`}
            onClick={() => choose(AUTO_MODEL)}
            role="menuitemradio"
            aria-checked={selectedModel === AUTO_MODEL}
          >
            <div className="HPAG-model-item-name">Auto</div>
            <div className="HPAG-model-item-desc">
              {active ? `Platform default, currently ${active.display_name}` : 'Platform default'}
            </div>
          </button>
          {failed && <div className="HPAG-mm-empty">The model catalog could not be loaded.</div>}
          {catalog && !catalog.selection_enabled && (
            <div className="HPAG-mm-empty">Choosing a model is turned off right now.</div>
          )}
          {catalog?.selection_enabled && groups.map(group => (
            <div key={group.provider} className="HPAG-mm-group">
              <div className="HPAG-mm-provider">
                <ProviderMark providerKey={group.provider} fallback={group.displayName} />
                <span className="HPAG-mm-provider-name">{group.displayName}</span>
                {group.models[0].visitor_key && <span className="HPAG-mm-badge">your key</span>}
              </div>
              {group.models.map(model => (
                <button
                  key={model.config_key}
                  className={`HPAG-model-item HPAG-mm-item ${selectedModel === model.config_key ? 'HPAG-model-active' : ''}`}
                  onClick={() => choose(model.config_key)}
                  role="menuitemradio"
                  aria-checked={selectedModel === model.config_key}
                >
                  <div className="HPAG-model-item-name">
                    {model.display_name}
                    {model.reasoning && <span className="HPAG-mm-tag">reasoning</span>}
                  </div>
                  <div className="HPAG-model-item-desc">{priceLabel(model)}</div>
                </button>
              ))}
            </div>
          ))}
          {catalog?.provider_keys_enabled && (
            <button className="HPAG-mm-keys-btn" onClick={() => { setOpen(false); setShowKeys(true); }}>
              <FontAwesomeIcon icon={faKey} /> Use your own API keys
            </button>
          )}
        </div>
      )}
      {showKeys && catalog && <ProviderKeysModal catalog={catalog} onClose={closeKeys} onChanged={load} />}
    </div>
  );
}
