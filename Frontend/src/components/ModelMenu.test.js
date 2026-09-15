import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelMenu from './ModelMenu';
import { fetchModelCatalog, saveProviderKey, removeProviderKey } from '../api/models';
jest.mock('../api/models', () => ({ AUTO_MODEL: 'auto', fetchModelCatalog: jest.fn(), saveProviderKey: jest.fn(), removeProviderKey: jest.fn() }));
let catalog;
beforeEach(() => {
  jest.clearAllMocks();
  catalog = {
    selection_enabled: true, provider_keys_enabled: true,
    active: { display_name: 'Default' },
    models: [
      { config_key: 'first', display_name: 'First model', provider: 'openai', provider_display_name: 'OpenAI', visitor_key: false, input_price_usd_per_million: 1, output_price_usd_per_million: 2 },
      { config_key: 'second', display_name: 'Second model', provider: 'anthropic', provider_display_name: 'Anthropic', visitor_key: false, input_price_usd_per_million: 1, output_price_usd_per_million: 2 }
    ],
    providers: [{ provider_key: 'openai', display_name: 'OpenAI', visitor_key: null }, { provider_key: 'anthropic', display_name: 'Anthropic', visitor_key: null }]
  };
  fetchModelCatalog.mockImplementation(async () => ({ ...catalog, models: catalog.models.map(model => ({ ...model })), providers: catalog.providers.map(provider => ({ ...provider })) }));
});
function App({ initial = 'auto', onChoose = () => {} }) {
  const [selected, setSelected] = useState(initial);
  return <ModelMenu selectedModel={selected} onSelectModel={key => { onChoose(key); setSelected(key); }} />;
}
async function openMore() {
  fireEvent.click(screen.getByRole('button', { name: /AtlasAI/ }));
  const more = await screen.findByRole('menuitem', { name: /More models/ });
  await waitFor(() => expect(more).toBeEnabled());
  fireEvent.click(more);
  return screen.getByRole('menu', { name: 'More models' });
}
test('the initial menu contains Auto and More models, with alternatives in the submenu only', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /AtlasAI/ }));
  expect(await screen.findByRole('menuitemradio', { name: /Auto/ })).toBeEnabled();
  expect(screen.getByRole('menuitem', { name: /More models/ })).toBeInTheDocument();
  expect(screen.queryByRole('menuitemradio', { name: /First model/ })).not.toBeInTheDocument();
});
test('no-key alternatives are locked and cannot select a model', async () => {
  const onChoose = jest.fn();
  render(<App onChoose={onChoose} />);
  const menu = await openMore();
  const first = within(menu).getByRole('menuitemradio', { name: /First model/ });
  expect(first).toBeDisabled();
  fireEvent.click(first);
  expect(onChoose).not.toHaveBeenCalled();
  expect(within(menu).getByRole('menuitem', { name: 'Add OpenAI API key' })).toBeEnabled();
});
test('a verified key unlocks only that provider, and saving does not automatically select a model', async () => {
  const onChoose = jest.fn();
  saveProviderKey.mockImplementation(async () => {
    catalog.models[0].visitor_key = true;
    catalog.providers[0].visitor_key = { suffix: 'test', verified_at: 1, use_count: 0 };
    return { models_visible: 2 };
  });
  render(<App onChoose={onChoose} />);
  const menu = await openMore();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add OpenAI API key' }));
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'test-provider-key' } });
  const dialog = screen.getByRole('dialog', { name: 'Provider API keys' });
  fireEvent.click(within(dialog).getAllByRole('button', { name: 'Verify & save' })[0]);
  await screen.findByText(/Verified, 2 models visible/);
  expect(onChoose).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close', exact: true }));
  const first = screen.getByRole('menuitemradio', { name: /First model/ });
  expect(first).toBeEnabled();
  expect(screen.getByRole('menuitemradio', { name: /Second model/ })).toBeDisabled();
  fireEvent.click(first);
  expect(onChoose).toHaveBeenCalledWith('first');
});
test('a rejected key leaves alternatives locked', async () => {
  saveProviderKey.mockRejectedValue(Object.assign(new Error('Rejected'), { code: 'api_key_rejected' }));
  render(<App />);
  const menu = await openMore();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add OpenAI API key' }));
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'rejected-test-key' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Verify & save' })[0]);
  await screen.findByText('The provider rejected this key.');
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  expect(screen.getByRole('menuitemradio', { name: /First model/ })).toBeDisabled();
});
test('removing a provider key returns the selected model to Auto and locks its alternatives', async () => {
  catalog.models[0].visitor_key = true;
  catalog.providers[0].visitor_key = { suffix: 'test', verified_at: 1, use_count: 0 };
  removeProviderKey.mockImplementation(async () => {
    catalog.models[0].visitor_key = false;
    catalog.providers[0].visitor_key = null;
  });
  const onChoose = jest.fn();
  render(<App initial="first" onChoose={onChoose} />);
  const menu = await openMore();
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Manage your API keys/ }));
  fireEvent.click(screen.getByTitle('Remove key'));
  await screen.findByText('Key removed.');
  await waitFor(() => expect(onChoose).toHaveBeenCalledWith('auto'));
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  expect(screen.getByRole('menuitemradio', { name: /First model/ })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Auto is selected');
});

test('key management excludes providers with no models in More models, even with an older broad catalog', async () => {
  catalog.providers.push(
    { provider_key: 'vigil2', display_name: 'Vigil2 (local vLLM, DGX Spark)', visitor_key: null },
    { provider_key: 'cerebras', display_name: 'Cerebras', visitor_key: null },
    { provider_key: 'openai-responses', display_name: 'OpenAI (Responses API)', visitor_key: null }
  );
  render(<App />);
  const menu = await openMore();
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Manage your API keys/ }));
  const dialog = screen.getByRole('dialog', { name: 'Provider API keys' });
  expect(within(dialog).getByLabelText('OpenAI API key')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Anthropic API key')).toBeInTheDocument();
  expect(within(dialog).queryByText(/Vigil2|Cerebras|Responses API/)).not.toBeInTheDocument();
  expect(within(dialog).getAllByPlaceholderText('Paste your API key')).toHaveLength(2);
});

test('a selectable provider without a logo displays its name only once', async () => {
  catalog.models[0] = { ...catalog.models[0], provider: 'example-provider', provider_display_name: 'Example Provider' };
  catalog.providers[0] = { provider_key: 'example-provider', display_name: 'Example Provider', visitor_key: null };
  render(<App />);
  const menu = await openMore();
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Manage your API keys/ }));
  const dialog = screen.getByRole('dialog', { name: 'Provider API keys' });
  expect(within(dialog).getAllByText('Example Provider', { exact: true })).toHaveLength(1);
});
