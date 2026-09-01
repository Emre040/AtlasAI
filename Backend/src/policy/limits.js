'use strict';

// Admission control for model-backed requests. Reads the active platform configuration and the
// ledgers already kept by the gateway (inference_calls, runs, request_events, batch_jobs), then
// allows the request, swaps the model for the configured fallback, or refuses it. Every refusal
// and fallback is written to policy_decisions with the measured value and the limit.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MICROUSD_PER_USD = 1_000_000;

const CALLS = '`atlasai`.`inference_calls`';
const RUNS = '`atlasai`.`runs`';
const REQUEST_EVENTS = '`atlasai`.`request_events`';
const BATCH_JOBS = '`atlasai`.`batch_jobs`';
const DECISIONS = '`atlasai`.`policy_decisions`';

const REQUEST_PATHS = ['/query/stream', '/batch'];

class PolicyRefusal extends Error {
  constructor(reason, { measured, limit, retryAfterSeconds = null, scope }) {
    super(`Request refused by policy: ${reason}.`);
    this.name = 'PolicyRefusal';
    this.status = 429;
    this.code = reason;
    this.reason = reason;
    this.measured = measured;
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
    this.scope = scope;
  }
}

function startOfUtcDay(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfIsoWeek(now) {
  const day = startOfUtcDay(now);
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - weekday * DAY_MS;
}

function startOfUtcMonth(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function windowStart(period, mode, now) {
  if (period === 'minute') return now - 60_000;
  if (period === 'hour') return now - 3_600_000;
  if (mode === 'calendar_utc') {
    if (period === 'day') return startOfUtcDay(now);
    if (period === 'week') return startOfIsoWeek(now);
    if (period === 'month') return startOfUtcMonth(now);
  }
  if (period === 'day') return now - DAY_MS;
  if (period === 'week') return now - WEEK_MS;
  if (period === 'month') return now - 30 * DAY_MS;
  throw new Error(`Unknown policy period '${period}'.`);
}

function retryAfter(period, mode, now) {
  if (period === 'minute') return 60;
  if (period === 'hour') return 3600;
  if (mode !== 'calendar_utc') return null;
  if (period === 'day') return Math.ceil((startOfUtcDay(now) + DAY_MS - now) / 1000);
  if (period === 'week') return Math.ceil((startOfIsoWeek(now) + WEEK_MS - now) / 1000);
  if (period === 'month') {
    const date = new Date(now);
    return Math.ceil((Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now) / 1000);
  }
  return null;
}

function usdFromMicro(value) {
  return Number(value || 0) / MICROUSD_PER_USD;
}

class PolicyEngine {
  constructor(db, platformConfig) {
    this.db = db;
    this.platformConfig = platformConfig;
  }

  async scalar(sql, params) {
    const [rows] = await this.db.execute(sql, params);
    const value = rows[0] ? Object.values(rows[0])[0] : 0;
    return Number(value || 0);
  }

  platformSpendUsd(since) {
    return this.scalar(
      `SELECT COALESCE(SUM(cost_microusd), 0) FROM ${CALLS} WHERE credential_source = 'platform' AND started_unix_ms >= ?`,
      [since]
    ).then(usdFromMicro);
  }

  visitorSpendUsd(visitorId, since) {
    return this.scalar(
      `SELECT COALESCE(SUM(cost_microusd), 0) FROM ${CALLS}
        WHERE visitor_id = ? AND credential_source = 'platform' AND started_unix_ms >= ?`,
      [visitorId, since]
    ).then(usdFromMicro);
  }

  visitorRequests(visitorId, since) {
    return this.scalar(
      `SELECT COUNT(*) FROM ${REQUEST_EVENTS}
        WHERE visitor_id = ? AND received_unix_ms >= ? AND request_path IN (?, ?)`,
      [visitorId, since, ...REQUEST_PATHS]
    );
  }

  globalRequests(since) {
    return this.scalar(
      `SELECT COUNT(*) FROM ${REQUEST_EVENTS} WHERE received_unix_ms >= ? AND request_path IN (?, ?)`,
      [since, ...REQUEST_PATHS]
    );
  }

  visitorTokens(visitorId, since) {
    return this.scalar(
      `SELECT COALESCE(SUM(total_tokens), 0) FROM ${CALLS}
        WHERE visitor_id = ? AND credential_source = 'platform' AND started_unix_ms >= ?`,
      [visitorId, since]
    );
  }

  visitorRuns(visitorId, since, toolKey = null) {
    return this.scalar(
      `SELECT COUNT(*) FROM ${RUNS} WHERE visitor_id = ? AND started_unix_ms >= ?${toolKey ? ' AND tool_key = ?' : ''}`,
      toolKey ? [visitorId, since, toolKey] : [visitorId, since]
    );
  }

  visitorRunningRuns(visitorId) {
    return this.scalar(`SELECT COUNT(*) FROM ${RUNS} WHERE visitor_id = ? AND status = 'running'`, [visitorId]);
  }

  globalRunningRuns() {
    return this.scalar(`SELECT COUNT(*) FROM ${RUNS} WHERE status = 'running'`);
  }

  visitorBatchQueries(visitorId, since) {
    return this.scalar(
      `SELECT COALESCE(SUM(total_queries), 0) FROM ${BATCH_JOBS} WHERE visitor_id = ? AND created_unix_ms >= ?`,
      [visitorId, since]
    );
  }

  async record(decision, refusal, { visitorId, requestEventId, modelId, routeKind }) {
    await this.db.execute(
      `INSERT INTO ${DECISIONS} (
         visitor_id, request_event_id, inference_model_id, decision, reason,
         measured_value, limit_value, route_kind, created_unix_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [visitorId, requestEventId ?? null, modelId ?? null, decision, refusal.reason,
        Number(refusal.measured.toFixed(4)), Number(refusal.limit.toFixed(4)), routeKind, Date.now()]
    );
  }

  // Resolves to { model, modelSelection } or throws PolicyRefusal (after recording it).
  async admit({
    visitorId,
    requestEventId = null,
    model,
    modelSelection,
    credentialSource,
    routeKind,
    batchQueryCount = 0,
    loadFallbackModel
  }) {
    const config = this.platformConfig.current();
    const now = Date.now();
    const mode = config.budgetWindowMode;
    const usesVisitorKey = credentialSource === 'visitor';
    const skipSpend = usesVisitorKey && config.visitorKeysBypassSpendLimits;
    const skipVolume = usesVisitorKey && config.visitorKeysBypassVolumeLimits;
    const context = { visitorId, requestEventId, modelId: model.id, routeKind };

    const refuse = async refusal => {
      await this.record('blocked', refusal, context);
      throw refusal;
    };

    // Volume limits (abuse control) come first: they are cheap and apply even with a visitor key
    // unless configured otherwise.
    if (!skipVolume) {
      for (const [period, limit, reason] of [
        ['minute', config.visitorRequests.minute, 'visitor_requests_minute'],
        ['hour', config.visitorRequests.hour, 'visitor_requests_hour'],
        ['day', config.visitorRequests.day, 'visitor_requests_day']
      ]) {
        if (limit === null) continue;
        const measured = await this.visitorRequests(visitorId, windowStart(period, mode, now));
        if (measured > limit) await refuse(new PolicyRefusal(reason, { measured, limit, retryAfterSeconds: retryAfter(period, mode, now), scope: 'visitor' }));
      }
      if (config.globalRequestsPerMinute !== null) {
        const measured = await this.globalRequests(windowStart('minute', mode, now));
        if (measured > config.globalRequestsPerMinute) {
          await refuse(new PolicyRefusal('global_requests_minute', { measured, limit: config.globalRequestsPerMinute, retryAfterSeconds: 60, scope: 'platform' }));
        }
      }
      if (config.visitorConcurrentRuns !== null) {
        const measured = await this.visitorRunningRuns(visitorId);
        if (measured >= config.visitorConcurrentRuns) {
          await refuse(new PolicyRefusal('visitor_concurrent_runs', { measured, limit: config.visitorConcurrentRuns, retryAfterSeconds: 30, scope: 'visitor' }));
        }
      }
      if (config.globalConcurrentRuns !== null) {
        const measured = await this.globalRunningRuns();
        if (measured >= config.globalConcurrentRuns) {
          await refuse(new PolicyRefusal('global_concurrent_runs', { measured, limit: config.globalConcurrentRuns, retryAfterSeconds: 30, scope: 'platform' }));
        }
      }
      if (config.visitorTokensPerDay !== null) {
        const measured = await this.visitorTokens(visitorId, windowStart('day', mode, now));
        if (measured >= config.visitorTokensPerDay) {
          await refuse(new PolicyRefusal('visitor_tokens_day', { measured, limit: config.visitorTokensPerDay, retryAfterSeconds: retryAfter('day', mode, now), scope: 'visitor' }));
        }
      }
      if (routeKind === 'query') {
        if (config.visitorRunsPerDay !== null) {
          const measured = await this.visitorRuns(visitorId, windowStart('day', mode, now));
          if (measured >= config.visitorRunsPerDay) {
            await refuse(new PolicyRefusal('visitor_runs_day', { measured, limit: config.visitorRunsPerDay, retryAfterSeconds: retryAfter('day', mode, now), scope: 'visitor' }));
          }
        }
        if (config.visitorAsoRunsPerDay !== null) {
          const measured = await this.visitorRuns(visitorId, windowStart('day', mode, now), 'aso_hpa');
          if (measured >= config.visitorAsoRunsPerDay) {
            await refuse(new PolicyRefusal('visitor_aso_runs_day', { measured, limit: config.visitorAsoRunsPerDay, retryAfterSeconds: retryAfter('day', mode, now), scope: 'visitor' }));
          }
        }
      }
      if (routeKind === 'batch' && config.visitorBatchQueriesPerDay !== null) {
        const measured = await this.visitorBatchQueries(visitorId, windowStart('day', mode, now));
        if (measured + batchQueryCount > config.visitorBatchQueriesPerDay) {
          await refuse(new PolicyRefusal('visitor_batch_queries_day', { measured: measured + batchQueryCount, limit: config.visitorBatchQueriesPerDay, retryAfterSeconds: retryAfter('day', mode, now), scope: 'visitor' }));
        }
      }
    }

    if (skipSpend) return { model, modelSelection };

    const anyPlatformBudget = Object.values(config.platformBudgetUsd).some(value => value !== null);
    const anyVisitorBudget = Object.values(config.visitorBudgetUsd).some(value => value !== null);
    if ((anyPlatformBudget || anyVisitorBudget) && model.inputPriceMicroUsdPerMillion === null
      && config.unpricedModelBehaviour === 'block') {
      await refuse(new PolicyRefusal('unpriced_model', { measured: 0, limit: 0, scope: 'platform' }));
    }

    for (const [period, limit, reason] of [
      ['day', config.visitorBudgetUsd.day, 'visitor_budget_day'],
      ['week', config.visitorBudgetUsd.week, 'visitor_budget_week'],
      ['month', config.visitorBudgetUsd.month, 'visitor_budget_month']
    ]) {
      if (limit === null) continue;
      const measured = await this.visitorSpendUsd(visitorId, windowStart(period, mode, now));
      if (measured >= limit) await refuse(new PolicyRefusal(reason, { measured, limit, retryAfterSeconds: retryAfter(period, mode, now), scope: 'visitor' }));
    }

    for (const [period, limit, reason] of [
      ['day', config.platformBudgetUsd.day, 'platform_budget_day'],
      ['week', config.platformBudgetUsd.week, 'platform_budget_week'],
      ['month', config.platformBudgetUsd.month, 'platform_budget_month']
    ]) {
      if (limit === null) continue;
      const measured = await this.platformSpendUsd(windowStart(period, mode, now));
      if (measured < limit) continue;
      const refusal = new PolicyRefusal(reason, { measured, limit, retryAfterSeconds: retryAfter(period, mode, now), scope: 'platform' });
      const fallbackId = config.fallbackInferenceModelId;
      if (config.overBudgetBehaviour === 'fallback_model' && fallbackId !== null && fallbackId !== model.id) {
        const fallback = await loadFallbackModel(fallbackId);
        if (fallback) {
          await this.record('fallback', refusal, context);
          return { model: fallback, modelSelection: 'fallback' };
        }
      }
      await refuse(refusal);
    }

    return { model, modelSelection };
  }
}

module.exports = { PolicyEngine, PolicyRefusal, windowStart };
