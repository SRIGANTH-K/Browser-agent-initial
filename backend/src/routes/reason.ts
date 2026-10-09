import { Router, Request, Response } from 'express';
import { SanitizedContextSchema, validateAndSanitizeVlmResponse, EMPTY_ACTION_FALLBACK } from '../validation/schema.js';
import { callVlm } from '../vlm/client.js';

const router = Router();

router.post('/reason', async (req: Request, res: Response) => {
  // 1. Validate incoming SanitizedContext request body
  const parseResult = SanitizedContextSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'invalid_context',
      message: parseResult.error.message
    });
  }

  const context = parseResult.data;

  try {
    // Ask the configured language model to interpret the complete user task.
    let rawVlmOutput = await callVlm(context);

    // Validate the model response before any browser action is returned.
    let validationResult = validateAndSanitizeVlmResponse(rawVlmOutput, context);

    // Some providers return a generic data response even though the current
    // page contains search controls or result links. Give the same planner one
    // explicit continuation attempt; never execute a local or guessed action.
    if (validationResult.valid && validationResult.response.response_type === 'data') {
      const plannerData = validationResult.response.data || {};
      const detail = String(plannerData.message || '');
      const hasConcreteQuestion = [plannerData.missing, plannerData.required, plannerData.questions]
        .some((value) => Array.isArray(value) && value.length > 0);
      const hasPageTargets = Boolean(
        (context.fields && context.fields.length) ||
        (context.buttons && context.buttons.length) ||
        (context.links && context.links.length)
      );
      const hasSearchControl = Boolean(
        context.fields?.some((field) => /search|query|keyword|product/i.test(`${field.label || ''} ${field.target}`)) ||
        context.buttons?.some((button) => /search|find|go/i.test(`${button.text || ''} ${button.target}`))
      );
      const isGenericStop = !hasConcreteQuestion &&
        (!detail || /needs? more information|need more info|cannot continue|before it can continue/i.test(detail));
      const stoppedBeforeSearch = hasSearchControl &&
        /could not find|couldn't find|not found|no (?:matching|qualifying)|current search results/i.test(detail) &&
        !/search|query|keyword/i.test(detail);

      if (hasPageTargets && (isGenericStop || stoppedBeforeSearch)) {
        rawVlmOutput = await callVlm({
          ...context,
          planner_nudge: 'Continue the requested task now. Use an exact non-empty target from the supplied fields, buttons, or links. If a search field/control is visible, search for the complete product request before judging whether an exact product exists. For shopping tasks, use visible search or result controls instead of asking for a product link or ID. Return data only if no usable target exists or a concrete required user value is missing.',
        });
        validationResult = validateAndSanitizeVlmResponse(rawVlmOutput, context);
      }
    }

    if (!validationResult.valid) {
      console.warn(`[VLM Response Rejected] Reason: ${validationResult.errorReason}`);
      return res.status(422).json({
        error: 'vlm_output_rejected',
        message: validationResult.errorReason,
        response: EMPTY_ACTION_FALLBACK
      });
    }

    // 5. Return validated response
    return res.status(200).json(validationResult.response);
  } catch (err: any) {
    const errorMessage = err?.message || 'Configured VLM provider failed.';
    const isConfigurationError = /missing api key|unsupported vlm provider|mock vlm provider/i.test(errorMessage);
    const isRateLimited = /429|too many requests|rate limit/i.test(errorMessage);
    const isPayloadTooLarge = /payload too large|request too large|context is too large|413/i.test(errorMessage);
    console.error(`[Reason Route Error] ${errorMessage}`);
    return res.status(isConfigurationError ? 503 : isRateLimited ? 429 : isPayloadTooLarge ? 413 : 502).json({
      error: isConfigurationError ? 'vlm_not_configured' : isRateLimited ? 'vlm_rate_limited' : isPayloadTooLarge ? 'planner_context_too_large' : 'vlm_unavailable',
      message: isRateLimited ? 'The configured VLM provider rate limit was reached. Wait for the provider reset window, then retry.' : isPayloadTooLarge ? 'The page context is too large for the configured VLM provider. The extension must reduce the page context before retrying.' : errorMessage,
      response: EMPTY_ACTION_FALLBACK
    });
  }
});

export default router;
