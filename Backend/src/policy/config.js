'use strict';

// The active platform_config row as a normalized, cached snapshot. Loaded once at startup,
// refreshed in the background, and read synchronously everywhere else (routes, agents).

const CONFIG_SQL = `
  SELECT c.*, m.config_key AS fallback_model_config_key
    FROM \`atlasai\`.\`platform_config\` c
    LEFT JOIN \`atlasai\`.\`inference_models\` m ON m.id = c.fallback_inference_model_id
   WHERE c.active_singleton = 1
   LIMIT 2
`;

function number(value) {
  return value === null || value === undefined ? null : Number(value);
}

function usd(value) {
  return value === null || value === undefined ? null : Number(value);
}

function flag(value) {
  return Number(value) === 1;
}

function normalize(row) {
  return Object.freeze({
    id: Number(row.id),
    label: row.label,
    revision: Number(row.revision),
    activeHpaVersion: row.active_hpa_version,
    offlineAgentsEnabled: flag(row.offline_agents_enabled),
    budgetWindowMode: row.budget_window_mode,
    platformBudgetUsd: Object.freeze({
      day: usd(row.platform_budget_usd_per_day),
      week: usd(row.platform_budget_usd_per_week),
      month: usd(row.platform_budget_usd_per_month)
    }),
    overBudgetBehaviour: row.over_budget_behaviour,
    fallbackInferenceModelId: number(row.fallback_inference_model_id),
    fallbackModelConfigKey: row.fallback_model_config_key ?? null,
    unpricedModelBehaviour: row.unpriced_model_behaviour,
    visitorBudgetUsd: Object.freeze({
      day: usd(row.visitor_budget_usd_per_day),
      week: usd(row.visitor_budget_usd_per_week),
      month: usd(row.visitor_budget_usd_per_month)
    }),
    visitorRequests: Object.freeze({
      minute: number(row.visitor_requests_per_minute),
      hour: number(row.visitor_requests_per_hour),
      day: number(row.visitor_requests_per_day)
    }),
    visitorTokensPerDay: number(row.visitor_tokens_per_day),
    visitorRunsPerDay: number(row.visitor_runs_per_day),
    visitorAsoRunsPerDay: number(row.visitor_aso_runs_per_day),
    visitorConcurrentRuns: number(row.visitor_concurrent_runs),
    visitorBatchQueriesPerDay: number(row.visitor_batch_queries_per_day),
    globalRequestsPerMinute: number(row.global_requests_per_minute),
    globalConcurrentRuns: number(row.global_concurrent_runs),
    visitorModelSelectionEnabled: flag(row.visitor_model_selection_enabled),
    visitorProviderKeysEnabled: flag(row.visitor_provider_keys_enabled),
    visitorKeysBypassSpendLimits: flag(row.visitor_keys_bypass_spend_limits),
    visitorKeysBypassVolumeLimits: flag(row.visitor_keys_bypass_volume_limits),
    queryMaxCharacters: Number(row.query_max_characters),
    modelHistoryMessages: Number(row.model_history_messages),
    batchMaxQueries: Number(row.batch_max_queries),
    batchConcurrency: Number(row.batch_concurrency),
    deepResearchMaxRetries: Number(row.deep_research_max_retries),
    asoMaxSteps: Number(row.aso_max_steps),
    asoParallelLimit: Number(row.aso_parallel_limit),
    asoTopX: Number(row.aso_top_x)
  });
}

class PlatformConfig {
  constructor(db, { refreshMs = 5000 } = {}) {
    this.db = db;
    this.refreshMs = refreshMs;
    this.snapshot = null;
    this.timer = null;
  }

  async reload() {
    const [rows] = await this.db.execute(CONFIG_SQL);
    if (rows.length !== 1) {
      throw new Error(`Exactly one active platform_config row is required; found ${rows.length}.`);
    }
    this.snapshot = normalize(rows[0]);
    return this.snapshot;
  }

  startRefreshing() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reload().catch(error => {
        console.error('[PLATFORM_CONFIG_REFRESH_FAILED]', error?.code || error?.message || String(error));
      });
    }, this.refreshMs);
    this.timer.unref();
  }

  stopRefreshing() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current() {
    if (!this.snapshot) throw new Error('Platform configuration is not loaded.');
    return this.snapshot;
  }
}

let instance = null;

async function initializePlatformConfig(db, options) {
  if (instance) throw new Error('Platform configuration is already initialized.');
  instance = new PlatformConfig(db, options);
  await instance.reload();
  instance.startRefreshing();
  return instance;
}

function platformConfig() {
  if (!instance) throw new Error('Platform configuration is not initialized.');
  return instance.current();
}

function platformConfigInstance() {
  if (!instance) throw new Error('Platform configuration is not initialized.');
  return instance;
}

module.exports = { PlatformConfig, initializePlatformConfig, platformConfig, platformConfigInstance, normalize };
