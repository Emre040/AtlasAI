import openai from './openai.svg';
import gemini from './gemini.svg';
import glm from './glm.svg';
import anthropic from './anthropic.svg';
import alibaba from './alibaba.svg';
import deepseek from './deepseek.svg';

// Official marks from Wikimedia Commons, keyed by inference_providers.provider_key.
const PROVIDER_LOGOS = Object.freeze({
  openai: { src: openai, alt: 'OpenAI' },
  gemini: { src: gemini, alt: 'Google Gemini' },
  glm: { src: glm, alt: 'Z.ai' },
  anthropic: { src: anthropic, alt: 'Anthropic' },
  alibaba: { src: alibaba, alt: 'Alibaba Cloud' },
  deepseek: { src: deepseek, alt: 'DeepSeek' }
});

export function providerLogo(providerKey) {
  return PROVIDER_LOGOS[providerKey] || null;
}
