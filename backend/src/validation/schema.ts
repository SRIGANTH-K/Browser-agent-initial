import { z } from 'zod';

// Input Contract Schema (Section 4)
export const SanitizedFieldSchema = z.object({
  ref: z.string(),
  type: z.string(),
  target: z.string(),
  label: z.string().optional(),
  sensitive: z.boolean().optional()
});

export const SanitizedButtonSchema = z.object({
  text: z.string().optional(),
  target: z.string()
});

export const SanitizedLinkSchema = z.object({
  text: z.string().optional(),
  target: z.string()
});

export const SanitizedContextSchema = z.object({
  user_task: z.string(),
  page_title: z.string().optional(),
  page_url: z.string().optional(),
  fields: z.array(SanitizedFieldSchema).optional(),
  buttons: z.array(SanitizedButtonSchema).optional(),
  links: z.array(SanitizedLinkSchema).optional(),
  // Backward-compat: single button
  button: SanitizedButtonSchema.optional()
});


export type SanitizedContext = z.infer<typeof SanitizedContextSchema>;

// Allowed Action Vocabulary (Section 5)
export const ALLOWED_ACTIONS = [
  'CLICK',
  'SCROLL',
  'SELECT',
  'TYPE',
  'TYPE_REFERENCE',
  'NAVIGATE',
  'WAIT'
] as const;

export const ActionItemSchema = z.object({
  action: z.enum(ALLOWED_ACTIONS),
  target: z.string(),
  reference: z.string().optional(),
  value: z.string().optional()
});

export const StructuredActionResponseSchema = z.object({
  response_type: z.enum(['action', 'data']),
  actions: z.array(ActionItemSchema).optional(),
  data: z.record(z.any()).optional()
});

export type StructuredActionResponse = z.infer<typeof StructuredActionResponseSchema>;

export const EMPTY_ACTION_FALLBACK: StructuredActionResponse = {
  response_type: 'action',
  actions: []
};

// Regex patterns for Defense-in-Depth PII leak checks (Section 7 rule 6)
const PII_PATTERNS = [
  // Email address pattern
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
  // US / Int'l Phone number pattern (10+ digits, optional delimiters)
  /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  // Credit card number pattern (13-19 digits, optional dashes/spaces)
  /\b(?:\d[ -]*?){13,19}\b/
];

/**
 * Validates VLM raw text output against all Section 7 rules:
 * 1. Markdown fence stripping
 * 2. Valid JSON parsing
 * 3. Schema validation (Zod)
 * 4. Fixed action vocabulary
 * 5. Target existence in original request context
 * 6. TYPE_REFERENCE reference token validity
 * 7. Defense-in-depth PII regex scanner
 */
export function validateAndSanitizeVlmResponse(
  rawOutput: string,
  context: SanitizedContext
): { valid: boolean; response: StructuredActionResponse; errorReason?: string } {
  if (!rawOutput || typeof rawOutput !== 'string') {
    return { valid: false, response: EMPTY_ACTION_FALLBACK, errorReason: 'Empty VLM output' };
  }

  // 1. Strip markdown code fences defensively
  let cleaned = rawOutput.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  // Extract substring between first { and last } if surrounded by prose or backticks
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  // Clean trailing commas before closing brackets/braces (common LLM artifact)
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

  // 2. Defense in depth: Run PII regex check across raw cleaned string before parsing
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(cleaned)) {
      return {
        valid: false,
        response: EMPTY_ACTION_FALLBACK,
        errorReason: 'Defense-in-depth PII check failed: potential raw PII detected in output'
      };
    }
  }

  // 3. Parse JSON
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    console.warn(`[JSON Parse Error] ${err?.message}. Raw input (${rawOutput.length} chars): "${rawOutput}"`);
    return { valid: false, response: EMPTY_ACTION_FALLBACK, errorReason: 'Malformed JSON output' };
  }

  // 4. Schema validation using Zod
  const zodResult = StructuredActionResponseSchema.safeParse(parsed);
  if (!zodResult.success) {
    return {
      valid: false,
      response: EMPTY_ACTION_FALLBACK,
      errorReason: `Schema validation failed: ${zodResult.error.message}`
    };
  }

  const data = zodResult.data;

  // If response_type is 'data', accept if valid schema
  if (data.response_type === 'data') {
    return { valid: true, response: data };
  }

  const actions = data.actions || [];

  // Extract allowed targets and reference tokens from original context
  const allowedTargets = new Set<string>();
  const allowedRefs = new Set<string>();

  if (context.fields) {
    for (const f of context.fields) {
      allowedTargets.add(f.target);
      allowedRefs.add(f.ref);
    }
  }
  if (context.button?.target) {
    allowedTargets.add(context.button.target);
  }
  if (context.buttons) {
    for (const b of context.buttons) {
      allowedTargets.add(b.target);
    }
  }
  if (context.links) {
    for (const link of context.links) {
      allowedTargets.add(link.target);
    }
  }

  // 5. Action checks: Target existence & TYPE_REFERENCE token validity.
  // A model can occasionally append one malformed action after otherwise valid
  // actions. Drop only the malformed action; never reject valid actions or pass
  // an unknown target to the browser executor.
  const safeActions = [];
  const rejectedActions: string[] = [];
  for (const act of actions) {
    // Target check
    if (act.action === 'NAVIGATE' && /^https?:\/\//i.test(act.target)) {
      safeActions.push(act);
      continue;
    }
    if (!allowedTargets.has(act.target)) {
      rejectedActions.push(`Target element '${act.target}' was not present in original request context`);
      continue;
    }

    // TYPE_REFERENCE reference token check
    if (act.action === 'TYPE_REFERENCE') {
      if (!act.reference || !allowedRefs.has(act.reference)) {
        rejectedActions.push(`TYPE_REFERENCE action missing valid reference token '${act.reference}'`);
        continue;
      }
    }

    safeActions.push(act);
  }

  if (rejectedActions.length > 0) {
    console.warn(`[VLM Response] Dropped ${rejectedActions.length} invalid action(s): ${rejectedActions.join('; ')}`);
  }

  if (safeActions.length === 0 && actions.length > 0) {
    return {
      valid: true,
      response: {
        response_type: 'data',
        data: {
          message: 'The planner did not produce a valid action for the current page. No fields were changed.',
          rejected_actions: rejectedActions,
        },
      },
    };
  }

  return { valid: true, response: { ...data, actions: safeActions } };
}
