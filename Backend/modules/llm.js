'use strict';

const OpenAI = require('openai');

// ---------------------------------------------------------------------------
// Provider presets — each maps to an OpenAI-compatible endpoint
// Set LLM_PROVIDER in config.env to pick one, then set the matching API key.
// Override anything with LLM_API_KEY / LLM_BASE_URL.
// ---------------------------------------------------------------------------
const PROVIDERS = {
  openai:     { keyEnv: 'OPENAI_API_KEY' },
  gemini:     { keyEnv: 'GEMINI_API_KEY',     baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  anthropic:  { keyEnv: 'ANTHROPIC_API_KEY',  baseURL: 'https://api.anthropic.com/v1/' },
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' },
};

const PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
const preset   = PROVIDERS[PROVIDER] || {};

const apiKey  = process.env.LLM_API_KEY  || process.env[preset.keyEnv] || process.env.OPENAI_API_KEY;
const baseURL = process.env.LLM_BASE_URL || preset.baseURL;

const client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });

const MODEL = process.env.HPA_MODEL;
if (!MODEL) throw new Error('HPA_MODEL environment variable is required');

module.exports = { client, MODEL, PROVIDER };
