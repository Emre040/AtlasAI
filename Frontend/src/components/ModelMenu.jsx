import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronRight, faChevronLeft, faLock, faKey, faSpinner, faTimes, faTrash, faCheck } from '@fortawesome/free-solid-svg-icons';
import { providerLogo } from '../assets/providers';
import { AUTO_MODEL, fetchModelCatalog, removeProviderKey, saveProviderKey } from '../api/models';
import './ModelMenu.css';

function priceLabel(model) {
  if (model.input_price_usd_per_million === null || model.output_price_usd_per_million === null) return 'price not published';
  const usd = value => (value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`);
  return `${usd(model.input_price_usd_per_million)} in · ${usd(model.output_price_usd_per_million)} out / 1M tokens`;
}

function ProviderMark({ providerKey }) {
  const logo = providerLogo(providerKey);
  if (!logo) return null;
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
        <ProviderMark providerKey={provider.provider_key} />
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
          aria-label={`${provider.display_name} API key`}
          data-provider={provider.provider_key}
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

function ProviderKeysModal({ catalog, onClose, onChanged, initialProvider }) {
  const dialogRef = useRef(null);
  const modelProviders = new Set(catalog.models.map(model => model.provider));
  const providers = catalog.providers.filter(provider => modelProviders.has(provider.provider_key));
  useEffect(() => {
    const inputs = [...dialogRef.current.querySelectorAll('input')];
    (inputs.find(input => input.dataset.provider === initialProvider) || inputs[0])?.focus();
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, initialProvider]);

  return (
    <div className="HPAG-mm-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="HPAG-mm-modal" role="dialog" aria-modal="true" aria-label="Provider API keys">
        <div className="HPAG-mm-modal-head">
          <div>
            <div className="HPAG-mm-modal-title">Your provider keys</div>
            <div className="HPAG-mm-modal-sub">
              Choose additional models using your own provider account. Keys are verified with the provider,
              encrypted at rest, and used only for your requests.
            </div>
          </div>
          <button className="HPAG-mm-close" onClick={onClose} aria-label="Close">
            <FontAwesomeIcon icon={faTimes} />
          </button>
        </div>
        <div className="HPAG-mm-modal-body">
          {providers.map(provider => (
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [placement, setPlacement] = useState('right');
  const [showKeys, setShowKeys] = useState(false);
  const [keyProvider, setKeyProvider] = useState(null);
  const [selectionNotice, setSelectionNotice] = useState('');
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const moreRef = useRef(null);
  const submenuRef = useRef(null);
  const id = useId();

  const load = useCallback(async () => {
    try {
      setCatalog(await fetchModelCatalog());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const closeMenu = () => { setOpen(false); setMoreOpen(false); };
  useEffect(() => {
    if (!open) return undefined;
    const onClick = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useLayoutEffect(() => {
    if (!moreOpen) return undefined;
    const position = () => {
      const bounds = menuRef.current.getBoundingClientRect();
      setPlacement(bounds.right + 356 <= window.innerWidth ? 'right' : bounds.left >= 356 ? 'left' : 'overlay');
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [moreOpen]);

  const models = useMemo(() => catalog?.models || [], [catalog]);
  const current = selectedModel === AUTO_MODEL ? null : models.find(model => model.config_key === selectedModel) || null;
  const canChoose = Boolean(catalog?.selection_enabled && catalog?.provider_keys_enabled);

  useEffect(() => {
    if (catalog && selectedModel !== AUTO_MODEL && (!canChoose || !current?.visitor_key)) {
      onSelectModel(AUTO_MODEL);
      setSelectionNotice('Your previous model is unavailable with your saved keys. Auto is selected.');
    }
  }, [catalog, selectedModel, current, canChoose, onSelectModel]);

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
    if (key !== AUTO_MODEL && (!canChoose || !models.some(model => model.config_key === key && model.visitor_key))) return;
    onSelectModel(key);
    setSelectionNotice('');
    closeMenu();
    triggerRef.current?.focus();
  };
  const focusFirst = ref => requestAnimationFrame(() => [...(ref.current?.querySelectorAll('[role^="menuitem"]:not(:disabled)') || [])].find(item => getComputedStyle(item).display !== 'none')?.focus());
  const showMore = (focus = false) => {
    setMoreOpen(true);
    if (focus) focusFirst(submenuRef);
  };
  const openKeys = (provider = null) => { setKeyProvider(provider); closeMenu(); setShowKeys(true); };
  const closeKeys = useCallback(() => {
    setShowKeys(false);
    setOpen(true);
    setMoreOpen(true);
    requestAnimationFrame(() => [...(submenuRef.current?.querySelectorAll('[role^="menuitem"]:not(:disabled)') || [])].find(item => getComputedStyle(item).display !== 'none')?.focus());
  }, []);
  const menuKey = event => {
    const menu = event.target.closest('[role="menu"]');
    if (!menu) return;
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && menu === submenuRef.current)) {
      event.preventDefault();
      event.stopPropagation();
      if (moreOpen) { setMoreOpen(false); requestAnimationFrame(() => moreRef.current?.focus()); }
      else { closeMenu(); triggerRef.current?.focus(); }
      return;
    }
    if (event.key === 'ArrowRight' && event.target === moreRef.current) {
      event.preventDefault(); showMore(true); return;
    }
    const items = [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')].filter(item => item.closest('[role="menu"]') === menu && getComputedStyle(item).display !== 'none');
    const at = items.indexOf(event.target);
    let next;
    if (event.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab') { closeMenu(); return; }
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  const active = catalog?.active || null;
  const headline = current ? current.display_name : 'Auto';

  return (
    <div className="HPAG-model-selector" ref={rootRef}>
      <button ref={triggerRef} className="HPAG-model-button" onClick={() => {
        if (open) closeMenu();
        else { setOpen(true); load(); }
      }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); focusFirst(menuRef); }
      }} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}>
        <span className="HPAG-model-name">AtlasAI</span>
        <span className="HPAG-model-version">{headline}</span>
        {current && <ProviderMark providerKey={current.provider} />}
        <FontAwesomeIcon icon={faChevronDown} className="HPAG-mm-chevron" />
      </button>
      {open && (
        <div ref={menuRef} id={`${id}-menu`} className={`HPAG-model-dropdown HPAG-mm-dropdown${moreOpen && placement === 'overlay' ? ' is-overlay-open' : ''}`} role="menu" aria-label="AI model" onKeyDown={menuKey}>
          <button
            className={`HPAG-model-item HPAG-mm-item ${selectedModel === AUTO_MODEL ? 'HPAG-model-active' : ''}`}
            onClick={() => choose(AUTO_MODEL)} onMouseEnter={() => setMoreOpen(false)}
            role="menuitemradio" aria-checked={selectedModel === AUTO_MODEL}
          >
            <div className="HPAG-model-item-name HPAG-mm-auto-name">Auto {selectedModel === AUTO_MODEL && <FontAwesomeIcon icon={faCheck} />}</div>
            <div className="HPAG-model-item-desc">{active ? `AtlasAI default · ${active.display_name}` : 'AtlasAI default'}</div>
          </button>
          <button ref={moreRef} className={`HPAG-model-item HPAG-mm-item HPAG-mm-more${moreOpen ? ' is-open' : ''}`}
            role="menuitem" aria-haspopup="menu" aria-expanded={moreOpen} aria-controls={moreOpen ? `${id}-more` : undefined}
            disabled={!catalog || !canChoose} onMouseEnter={() => canChoose && showMore()}
            onClick={event => showMore(event.detail === 0)}>
            <span><span className="HPAG-model-item-name">More models</span><span className="HPAG-model-item-desc">{!catalog ? 'Loading models…' : canChoose ? 'Use your own API key' : 'Model selection unavailable'}</span></span>
            <FontAwesomeIcon icon={faChevronRight} />
          </button>
          {selectionNotice && <div className="HPAG-mm-empty" role="status">{selectionNotice}</div>}
          {failed && <div className="HPAG-mm-empty" role="status">The model catalog could not be loaded. <button className="HPAG-mm-inline-action" onClick={load}>Retry</button></div>}
          {moreOpen && canChoose && <div ref={submenuRef} id={`${id}-more`} className={`HPAG-mm-submenu opens-${placement}`} role="menu" aria-label="More models">
            <div className="HPAG-mm-submenu-head">
              <button type="button" className="HPAG-mm-back" role="menuitem" onClick={() => { setMoreOpen(false); requestAnimationFrame(() => moreRef.current?.focus()); }} aria-label="Back to Auto"><FontAwesomeIcon icon={faChevronLeft} /></button>
              <div><strong>More models</strong><span>Requires your own provider key</span></div>
              <FontAwesomeIcon icon={faKey} />
            </div>
            <div className="HPAG-mm-model-list">
              {groups.map(group => {
                const hasKey = group.models.some(model => model.visitor_key);
                return <div key={group.provider} className="HPAG-mm-group" role="group" aria-label={group.displayName}>
                  <div className="HPAG-mm-provider">
                    <ProviderMark providerKey={group.provider} />
                    <span className="HPAG-mm-provider-name">{group.displayName}</span>
                    {hasKey ? <span className="HPAG-mm-badge">your key</span> : <button className="HPAG-mm-add-key" role="menuitem" onClick={() => openKeys(group.provider)} aria-label={`Add ${group.displayName} API key`}><FontAwesomeIcon icon={faKey} /> Add key</button>}
                  </div>
                  {group.models.map(model => <button key={model.config_key}
                    className={`HPAG-model-item HPAG-mm-item ${selectedModel === model.config_key ? 'HPAG-model-active' : ''}`}
                    disabled={!model.visitor_key} onClick={() => choose(model.config_key)} role="menuitemradio" aria-checked={selectedModel === model.config_key}>
                    <div className="HPAG-model-item-name">{model.display_name}
                      {model.reasoning && <span className="HPAG-mm-tag">reasoning</span>}
                      {!model.visitor_key && <FontAwesomeIcon icon={faLock} className="HPAG-mm-lock" />}
                    </div>
                    <div className="HPAG-model-item-desc">{model.visitor_key ? priceLabel(model) : 'Add a provider key to use this model'}</div>
                  </button>)}
                </div>;
              })}
              {!groups.length && <div className="HPAG-mm-empty">No additional models are available.</div>}
            </div>
            <button className="HPAG-mm-keys-btn" role="menuitem" onClick={() => openKeys()}><FontAwesomeIcon icon={faKey} /> Manage your API keys</button>
          </div>}
        </div>
      )}
      {showKeys && catalog && <ProviderKeysModal catalog={catalog} onClose={closeKeys} onChanged={load} initialProvider={keyProvider} />}
    </div>
  );
}
