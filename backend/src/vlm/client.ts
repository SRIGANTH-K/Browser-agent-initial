import { config } from '../config.js';
import { VLM_SYSTEM_PROMPT } from './system-prompt.js';

export interface VlmMessage {
  role: 'system' | 'user';
  content: string;
}

export async function callVlm(contextPayload: Record<string, any>): Promise<string> {
  const provider = config.vlmProvider;
  const isLocalProvider = provider === 'vllm' || provider === 'ollama' || provider === 'local';
  const hasAuthOrLocal = Boolean(config.vlmApiKey) || isLocalProvider;

  if (provider === 'mock') {
    throw new Error('Mock VLM provider is disabled. Configure a real VLM_PROVIDER.');
  }
  if (!hasAuthOrLocal && config.nodeEnv !== 'test') {
    throw new Error(`Missing API key for VLM provider '${provider}'.`);
  }
  if (config.nodeEnv === 'test') {
    throw new Error('VLM calls are disabled in test mode.');
  }

  const taskTerms = String(contextPayload.user_task || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
  const relevantLinks = Array.isArray(contextPayload.links)
    ? [...contextPayload.links]
      .sort((a, b) => {
        const score = (link: any) => taskTerms.reduce((total, term) =>
          total + (String(link.text || "").toLowerCase().includes(term) ? 1 : 0), 0);
        return score(b) - score(a);
      })
      .slice(0, 40)
      .map((link: any) => ({ target: link.target, text: String(link.text || "").slice(0, 140) }))
    : undefined;
  const compactContext = {
    user_task: contextPayload.user_task,
    page_title: contextPayload.page_title,
    page_url: contextPayload.page_url,
    fields: Array.isArray(contextPayload.fields) ? contextPayload.fields.slice(0, 40) : undefined,
    buttons: Array.isArray(contextPayload.buttons) ? contextPayload.buttons.slice(0, 20) : undefined,
    links: relevantLinks,
    button: contextPayload.button,
  };
  const serializedContext = JSON.stringify(compactContext);
  if (serializedContext.length > 24000) {
    throw new Error(`Planner context is too large (${serializedContext.length} characters).`);
  }
  const plannerNudge = typeof contextPayload.planner_nudge === 'string'
    ? `\nPlanner continuation instruction: ${contextPayload.planner_nudge}`
    : '';
  const promptText = `User Task: ${contextPayload.user_task}\nPage Context: ${serializedContext}${plannerNudge}`;

  console.log(`[VLM-Client] Calling ${provider} (model: ${config.vlmModel || (provider === 'vllm' ? 'Qwen/Qwen2-VL-7B-Instruct' : provider === 'ollama' ? 'llama3.2-vision' : 'default')})...`);
  const startTime = Date.now();

  try {
    let result: string;

    if (provider === 'openai' || provider === 'groq' || provider === 'vllm' || provider === 'ollama' || provider === 'local') {
      result = await callOpenAI(promptText);
    } else if (provider === 'anthropic') {
      result = await callAnthropic(promptText);
    } else if (provider === 'gemini') {
      result = await callGemini(promptText);
    } else {
      throw new Error(`Unsupported VLM provider: ${provider}`);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[VLM-Client] ${provider} responded in ${elapsed}ms (${result.length} chars)`);
    return result;
  } catch (err: any) {
    console.error(`[VLM-Client] Remote VLM call failed: ${err?.message || 'network error'}`);
    throw err;
  }
}

async function callOpenAI(promptText: string): Promise<string> {
  const provider = config.vlmProvider;
  let endpoint = config.vlmEndpoint;
  if (!endpoint) {
    if (provider === 'vllm') {
      endpoint = 'http://localhost:8000/v1/chat/completions';
    } else if (provider === 'ollama') {
      endpoint = 'http://localhost:11434/v1/chat/completions';
    } else if (provider === 'groq') {
      endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    } else {
      endpoint = 'https://api.openai.com/v1/chat/completions';
    }
  }

  const defaultModel =
    provider === 'groq'
      ? 'openai/gpt-oss-20b'
      : provider === 'vllm'
      ? 'Qwen/Qwen2-VL-7B-Instruct'
      : provider === 'ollama'
        ? 'llama3.2-vision'
        : 'gpt-4o';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.vlmApiKey) {
    headers['Authorization'] = `Bearer ${config.vlmApiKey}`;
  }

  const request = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.vlmModel || defaultModel,
      messages: [
        { role: 'system', content: VLM_SYSTEM_PROMPT },
        { role: 'user', content: promptText }
      ],
      temperature: 0.1
    })
  };

  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(endpoint, request);
    if (response.status !== 429 || attempt === 2) break;

    const retryAfter = Number(response.headers.get('retry-after') || '1');
    const waitMs = Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 1000), 5000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (!response) throw new Error(`${provider.toUpperCase()} request did not return a response.`);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`${provider.toUpperCase()} API error: ${response.status} ${response.statusText} — ${errorBody.slice(0, 200)}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(promptText: string): Promise<string> {
  const endpoint = config.vlmEndpoint || 'https://api.anthropic.com/v1/messages';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.vlmApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.vlmModel || 'claude-3-5-sonnet-20241022',
      system: VLM_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: promptText }
      ],
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText} — ${errorBody.slice(0, 200)}`);
  }

  const data: any = await response.json();
  return data.content?.[0]?.text || '';
}

async function callGemini(promptText: string): Promise<string> {
  const modelName = config.vlmModel || 'gemini-3.6-flash';
  const endpoint = config.vlmEndpoint || `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${config.vlmApiKey}`;
  
  const request = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: VLM_SYSTEM_PROMPT }]
      },
      contents: [
        {
          parts: [{ text: promptText }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json'
      }
    })
  };

  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(endpoint, request);
    const retryable = response.status === 429 || response.status === 500 ||
      response.status === 502 || response.status === 503 || response.status === 504;
    if (response.ok || !retryable || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }

  if (!response) throw new Error('Gemini request did not return a response.');

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error: ${response.status} ${response.statusText} — ${errorBody.slice(0, 300)}`);
  }

  const data: any = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log(`[VLM-Client] Raw response from Gemini (${rawText.length} chars): ${rawText.slice(0, 200)}...`);
  return rawText;
}
