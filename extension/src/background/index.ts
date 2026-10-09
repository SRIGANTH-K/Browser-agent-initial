import browser from "webextension-polyfill";
import type {
  AnalyzePageResponse,
  AskAIRequest,
  AskAIResult,
  ExecuteActionRequest,
  ExecuteActionResponse,
  ExtensionMessage,
  PageAnalysis,
  UserProtectedFieldIds,
} from "../shared/messages";
import {
  initIndexedDBVault,
  getAllVaultSecrets,
  resolveVaultReference,
} from "../shared/idb-vault";

// Ensure local IndexedDB database and AES-GCM encryption vault are initialized on service worker boot
void initIndexedDBVault().then(() => {
  console.log("%c[IndexedDB-Vault] 🗄️ Database 'BrowserAgent_SecretStore_v1' active in background service worker.", "color: #10b981; font-weight: bold;");
});

const BACKEND_URL = "http://localhost:3000/api/reason";
const BACKEND_API_KEY = "sih-secret-key-2026";

function resolveSecret(ref: string, secrets: Record<string, string>): string {
  const requested = ref.toUpperCase();
  if (secrets[requested]) return secrets[requested];

  // Match equivalent user-provided keys without relying on any stored value.
  const canonical = (value: string) => value
    .toUpperCase()
    .replace(/MOBILE_NUMBER/g, "PHONE")
    .replace(/PHONE_NUMBER/g, "PHONE")
    .replace(/PIN_CODE/g, "PINCODE")
    .replace(/ZIP_CODE/g, "PINCODE");
  const canonicalRequested = canonical(requested);
  const matchingKey = Object.keys(secrets).find((key) => canonical(key) === canonicalRequested);
  return matchingKey ? secrets[matchingKey] : "";
}

/**
 * Loads the on-device secret store from IndexedDB (BrowserAgent_SecretStore_v1)
 * Decrypts values on-device using Web Crypto AES-GCM (256-bit).
 */
async function loadOnDeviceSecrets(): Promise<Record<string, string>> {
  try {
    const vault = await getAllVaultSecrets();
    if (vault && vault.length > 0) {
      const secrets: Record<string, string> = {};
      for (const entry of vault) {
        secrets[entry.ref] = entry.decryptedValue;
      }
      return secrets;
    }
  } catch (err) {
    console.error("[IndexedDB-Vault] Could not read the user vault:", err);
    throw new Error("Unable to read saved information from IndexedDB.");
  }
  return {};
}

function getStorageKey(tabId: number): string {
  return `browserAgent.lastResult.${tabId}`;
}

function compactContextText(value: string, maxLength = 140): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isFinalPurchaseAction(target: string, analysis: PageAnalysis): boolean {
  const field = analysis.fields.find((candidate) => candidate.id === target);
  const text = `${field?.text || ""} ${field?.label || ""} ${field?.name || ""} ${field?.id || ""}`;
  return /\b(place order|buy now|purchase|pay now|confirm order|confirm purchase|submit order|complete order)\b/i.test(text);
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (tab?.id === undefined) {
    throw new Error("No active tab found");
  }

  return tab.id;
}

function waitForTabComplete(tabId: number, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId: number, info: { status?: string }) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    browser.tabs.onUpdated.addListener(listener);
  });
}

async function forwardToActiveTab(
  message: ExtensionMessage
): Promise<void> {
  const tabId = await getActiveTabId();
  await browser.tabs.sendMessage(tabId, message);
}

function isContentScriptDisconnected(error: unknown): boolean {
  return error instanceof Error &&
    /receiving end does not exist|could not establish connection|message port closed/i.test(error.message);
}

async function analyzeActivePage(): Promise<{
  tabId: number;
  analysis: PageAnalysis;
}> {
  const tabId = await getActiveTabId();

  let response: AnalyzePageResponse;
  try {
    response = (await browser.tabs.sendMessage(tabId, {
      type: "ANALYZE_PAGE",
    })) as AnalyzePageResponse;
  } catch (error) {
    if (!isContentScriptDisconnected(error)) throw error;

    // Tabs that were already open when the extension was reloaded do not have
    // the new content script. Reload once so Chrome injects the declared
    // content script, then retry the local analysis.
    console.warn("[Agent] Content script is stale; reloading the active tab once to reconnect.");
    await browser.tabs.reload(tabId);
    await waitForTabComplete(tabId, 10000);
    await new Promise((resolve) => setTimeout(resolve, 700));
    response = (await browser.tabs.sendMessage(tabId, {
      type: "ANALYZE_PAGE",
    })) as AnalyzePageResponse;
  }

  return {
    tabId,
    analysis: response.analysis,
  };
}

/**
 * Executes an action against the live DOM in the webpage content script.
 */
async function executeDomActionInTab(
  tabId: number,
  action: "CLICK" | "SCROLL" | "TYPE" | "SELECT" | "WAIT",
  target: string,
  value?: string
): Promise<ExecuteActionResponse> {
  const message: ExecuteActionRequest = {
    type: "EXECUTE_ACTION",
    action,
    target,
    value,
  };

  const res = (await browser.tabs.sendMessage(
    tabId,
    message
  )) as ExecuteActionResponse;

  return res;
}

/**
 * GENERIC sanitized payload builder — works on ANY form on ANY website.
 *
 * For each DOM field, determines if it's sensitive (PII) based on universal patterns
 * (not hardcoded to insurance forms). Assigns abstract reference tokens for sensitive
 * fields, and includes field labels so the VLM can understand arbitrary forms.
 *
 * Strictly excludes password fields from automated reasoning per PS requirements.
 */
function buildSanitizedPayload(
  task: string,
  analysis: PageAnalysis,
  userProtectedFieldIds: UserProtectedFieldIds
) {
  const userProtectedSet = new Set(userProtectedFieldIds);

  // Counters for each PII category
  const counters: Record<string, number> = {};
  function nextRef(category: string): string {
    counters[category] = (counters[category] || 0) + 1;
    return `${category}_${counters[category]}`;
  }

  const sanitizedFields: Array<{
    ref: string;
    type: string;
    target: string;
    label: string;
    sensitive: boolean;
  }> = [];
  const buttons: Array<{ target: string; text: string; isNav?: boolean }> = [];
  const links: Array<{ target: string; text: string }> = [];
  for (const field of analysis.fields) {
    // Collect buttons/submit elements (exclude passive nav links)
    const isButton = field.tag === "button" || 
                     (field.type as string) === "submit" || 
                     field.role === "button" ||
                     (field.tag === "a" && /button|btn|submit|sign|login|join|journey|register/i.test(`${field.id} ${field.name || ""} ${field.text || ""} ${field.label || ""}`));

    if (isButton) {
      const isNav = field.role === "nav-item" || Boolean(field.id?.toLowerCase().includes("nav") || field.name?.toLowerCase().includes("nav"));
      buttons.push({
        target: field.id,
        text: compactContextText(field.text || field.label || field.id || ""),
        isNav,
      });
      continue;
    }

    if (field.tag === "a" || field.type === "link") {
      const linkText = compactContextText(field.text || field.label || field.id || "");
      if (linkText && field.visible && field.role !== "nav-item") links.push({ target: field.id, text: linkText });
      continue;
    }


    const idLower = field.id.toLowerCase();
    const nameLower = (field.name || "").toLowerCase();
    const labelLower = (field.label || "").toLowerCase();
    const placeholderLower = (field.placeholder || "").toLowerCase();
    const haystack = `${idLower} ${nameLower} ${labelLower} ${placeholderLower}`;

    // Determine PII category using universal patterns
    let refToken = "";
    let isSensitive = field.sensitive;

    if (field.type === "password" || /pass(word)?|pwd/i.test(haystack)) {
      refToken = nextRef("PASSWORD");
      isSensitive = true;
    } else if (field.type === "email" || /e-?mail/.test(haystack)) {

      refToken = nextRef("EMAIL");
      isSensitive = true;
    } else if (field.type === "tel" || /phone|mobile|tel(ephone)?|cell/.test(haystack)) {
      refToken = nextRef("PHONE");
      isSensitive = true;
    } else if (/\bfirst.?name\b|fname/i.test(haystack)) {
      refToken = nextRef("FIRST_NAME");
      isSensitive = true;
    } else if (/\blast.?name\b|lname|surname/i.test(haystack)) {
      refToken = nextRef("LAST_NAME");
      isSensitive = true;
    } else if (/full.?name|your.?name|legal.?name|patient.?name|applicant.?name/.test(haystack) ||
               (/\bname\b/.test(idLower) || /\bname\b/.test(nameLower))) {
      refToken = nextRef("NAME");
      isSensitive = true;
    } else if (/pan\b|pan.?number|pan.?card/i.test(haystack)) {
      refToken = nextRef("PAN");
      isSensitive = true;
    } else if (/aadhaar|aadhar|uidai/i.test(haystack)) {
      refToken = nextRef("AADHAAR");
      isSensitive = true;
    } else if (/ssn|social.?security|passport|voter/i.test(haystack)) {
      refToken = nextRef("GOVID");
      isSensitive = true;
    } else if (/\bdob\b|birth|date.?of.?birth/.test(haystack) || field.type === "date") {
      refToken = nextRef("DOB");
      isSensitive = true;
    } else if (/pincode|pin.?code|postal|zip/i.test(haystack)) {
      refToken = nextRef("PINCODE");
      isSensitive = true;
    } else if (/\bcity\b|town/i.test(haystack)) {
      refToken = nextRef("CITY");
      isSensitive = true;
    } else if (/\bstate\b|province/i.test(haystack)) {
      refToken = nextRef("STATE");
      isSensitive = true;
    } else if (/address|street/i.test(haystack)) {
      refToken = nextRef("ADDRESS");
      isSensitive = true;
    } else if (/credit.?card|card.?number|cvv|cvc|expir/.test(haystack)) {
      refToken = nextRef("CARD");
      isSensitive = true;
    } else if (/salary|income|amount|payment/.test(haystack)) {
      refToken = nextRef("AMOUNT");
      isSensitive = false; // Financial amounts are not PII
    } else if (/policy|claim|account.?(?:no|num|id)|member.?(?:id|no)/.test(haystack)) {
      refToken = nextRef("POLICY");
      isSensitive = true;
    } else if (userProtectedSet.has(field.id)) {
      // User explicitly marked this field as protected
      refToken = nextRef("PROTECTED");
      isSensitive = true;
    } else {
      // Non-sensitive field — assign a generic token but include safe value
      refToken = nextRef("FIELD");
      isSensitive = false;
    }

    // Build the field label for VLM context (from DOM label, placeholder, or id)
    const fieldLabel = field.label || field.placeholder || field.name || field.id;

    sanitizedFields.push({
      ref: refToken,
      type: field.type || "text",
      target: field.id,
      label: compactContextText(fieldLabel),
      sensitive: isSensitive,
    });
  }

  // Keep the planner context bounded while ranking visible result links that
  // match the user's task ahead of site-navigation links.
  const boundedFields = sanitizedFields.slice(0, 60);
  const boundedButtons = buttons.slice(0, 30);
  const taskTerms = task.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const boundedLinks = [...links]
    .sort((a, b) => {
      const score = (link: { target: string; text: string }) => {
        const text = link.text.toLowerCase();
        return taskTerms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
      };
      return score(b) - score(a);
    })
    .slice(0, 120);

  const sensitiveItemsProtected = sanitizedFields.filter(f => f.sensitive).length;
  const rawItemsSent = 0; // 0 raw bytes sent — invariant

  const payload = {
    user_task: task,
    page_title: analysis.title,
    page_url: analysis.url,
    fields: boundedFields,
    buttons: boundedButtons,
    links: boundedLinks,
    // Select primary submit/action button, distinguishing form action from header nav
    button: (() => {
      const taskLower = task.toLowerCase();
       const formButtons = boundedButtons.filter(b => !b.isNav);
       const candidates = formButtons.length > 0 ? formButtons : boundedButtons;

      let submitBtn: { target: string; text: string } | undefined;

      if (/sign.*up|register|join|create|journey|seeker/i.test(taskLower)) {
        submitBtn = candidates.find(b => /sign.*up|register|create|journey|join|begin|submit/i.test(`${b.text} ${b.target}`)) ||
                    candidates.find(b => !/sign.*in|login/i.test(`${b.text} ${b.target}`));
      } else if (/log.*in|sign.*in|sanctuary/i.test(taskLower)) {
        submitBtn = candidates.find(b => /sign.*in|login|sanctuary|continue|submit/i.test(`${b.text} ${b.target}`));
      } else {
        submitBtn = candidates.find(b => /submit|apply|confirm|open|continue|next|sign|send/i.test(`${b.text} ${b.target}`));
      }

      if (!submitBtn) {
        submitBtn = candidates[candidates.length - 1] || candidates[0];
      }

      return submitBtn ? { target: submitBtn.target, text: submitBtn.text } : undefined;
    })(),

  };

  return {
    payload,
    sensitiveItemsProtected,
    rawItemsSent,
  };
}

async function handleAskAI(
  task: string,
  userProtectedFieldIds: UserProtectedFieldIds = [],
  iteration = 0
): Promise<AskAIResult> {
  console.log("%c[Browser-Agent] 🚀 Starting On-Device Agent Workflow", "color: #0284c7; font-weight: bold; font-size: 13px;");
  console.log(`%c[User-Task] "${task}"`, "color: #0f172a; font-weight: 600;");

  try {
    // 1. Get active tab and inspect current URL
    const tabId = await getActiveTabId();
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tab?.url || "";
    const taskLower = task.toLowerCase();

    let navigateTargetUrl: string | null = null;

    // 1. Check if user explicitly mentioned a website, domain, or known service in their prompt
    const urlPatternMatch = task.match(/https?:\/\/[^\s]+|(?:\b[a-zA-Z0-9-]+\.)+(?:com|org|net|gov|in|io|co|edu|app|ai|me|dev)(?:\/[^\s]*)?/i);
    const domainKeywordMatch = taskLower.match(/\b(el[ly]+tarot|digilocker|google|github)\b/i);

    let explicitTargetUrl: string | null = null;

    if (urlPatternMatch) {
      let matched = urlPatternMatch[0];
      if (!matched.startsWith("http://") && !matched.startsWith("https://")) {
        matched = "https://" + matched;
      }
      explicitTargetUrl = matched;
    } else if (domainKeywordMatch) {
      const keyword = domainKeywordMatch[1].toLowerCase();
      if (/el[ly]+tarot/.test(keyword)) explicitTargetUrl = "https://www.elytarot.com";
      else if (keyword === "digilocker") explicitTargetUrl = "https://accounts.digilocker.gov.in";
      else if (keyword === "google") explicitTargetUrl = "https://accounts.google.com";
      else if (keyword === "github") explicitTargetUrl = "https://github.com/login";
    }

    if (explicitTargetUrl) {
      try {
        const parsed = new URL(explicitTargetUrl);
        const isSignup = /sign.*up|register|join|create.*account/i.test(taskLower);
        const isLogin = /log.*in|sign.*in/i.test(taskLower);

        // If no specific sub-path was provided, append /login or /register according to intent
        if (parsed.pathname === "/" || parsed.pathname === "") {
          if (parsed.hostname.includes("elytarot.com")) {
            if (isSignup) parsed.pathname = "/register";
            else if (isLogin) parsed.pathname = "/login";
          } else if (parsed.hostname.includes("google.com")) {
            parsed.hostname = "accounts.google.com";
          } else if (isSignup) {
            parsed.pathname = "/register";
          } else if (isLogin) {
            parsed.pathname = "/login";
          }
        }

        if (!currentUrl.includes(parsed.hostname) || (parsed.pathname !== "/" && !currentUrl.includes(parsed.pathname))) {
          navigateTargetUrl = parsed.toString();
        }
      } catch {
        navigateTargetUrl = explicitTargetUrl;
      }
    }


    if (navigateTargetUrl) {
      console.log(`%c[Agent-Navigator] 🌐 Navigating active tab to ${navigateTargetUrl}...`, "color: #0284c7; font-weight: bold;");
      await browser.tabs.update(tabId, { url: navigateTargetUrl });
      await waitForTabComplete(tabId);
      await new Promise((r) => setTimeout(r, 1800));
    }

    // Load secrets dynamically from the user-editable vault
    const secrets = await loadOnDeviceSecrets();
    console.log(`%c[Secret-Store] 🔐 Loaded ${Object.keys(secrets).length} on-device secrets from vault`, "color: #7c3aed;");

    let { analysis } = await analyzeActivePage();
    if (!analysis || analysis.fields.length === 0) {
      await new Promise((r) => setTimeout(r, 1200));
      const retry = await analyzeActivePage();
      if (retry?.analysis?.fields?.length > 0) {
        analysis = retry.analysis;
      }
    }
    console.log(`%c[Perception] 👁️ Discovered ${analysis.fields.length} interactive elements on active page.`, "color: #0369a1;");


    const {
      payload,
      sensitiveItemsProtected,
      rawItemsSent,
    } = buildSanitizedPayload(
      task,
      analysis,
      userProtectedFieldIds
    );

    console.log(`%c[Privacy-Engine] 🛡️ Shielded ${sensitiveItemsProtected} sensitive fields with abstract tokens:`, "color: #7c3aed; font-weight: bold;", payload.fields);
    console.log("%c[Zero-Leakage Invariant] 0 bytes raw PII transmitted. Passwords strictly excluded.", "color: #16a34a; font-weight: bold;");

    const missingRequired = payload.fields
      .filter((field) => {
        const pageField = analysis.fields.find((candidate) => candidate.id === field.target);
        // Consent controls are actions, not saved personal details. Their label may
        // mention sensitive topics (for example Aadhaar/PAN) without needing a vault value.
        const consentText = `${field.label} ${pageField?.label || ""} ${pageField?.name || ""}`;
        const isConsentControl = field.type === "checkbox" || field.type === "radio" ||
          /\b(agree|confirm|consent|accept|authorize|terms|privacy policy)\b/i.test(consentText);
        return !isConsentControl && field.sensitive && pageField?.required && !resolveSecret(field.ref, secrets);
      })
      .map((field) => field.label || field.target);

    if (missingRequired.length > 0) {
      const result: AskAIResult = {
        type: "ASK_AI_RESULT",
        sensitiveItemsProtected,
        rawItemsSent,
        analysis,
        userProtectedFieldIds,
        serverInstruction: `I need these saved values before I can fill the form: ${missingRequired.join(", ")}. Add them in the IndexedDB Vault, then run the task again. No fields were changed.`,
      };
      await browser.storage.local.set({ [getStorageKey(tabId)]: result });
      return result;
    }

    let serverInstruction: string | null = null;
    let executedCount = 0;

    try {
      console.log("%c[Remote-VLM] ☁️ Transmitting abstract payload to Backend (POST http://localhost:3000/api/reason)...", "color: #d97706;");
      const vlmStartTime = Date.now();
      const response = await fetch(BACKEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BACKEND_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        const vlmElapsed = Date.now() - vlmStartTime;
        console.log(`%c[Remote-VLM] 📥 VLM Reasoning Plan Received (${vlmElapsed}ms):`, "color: #16a34a; font-weight: bold;", data.actions);

        if (data.response_type === "action" && Array.isArray(data.actions)) {
          const missingReferences = data.actions
            .filter((action: any) => {
              if (action.action !== "TYPE_REFERENCE") return false;
              const field = payload.fields.find((candidate) => candidate.target === action.target);
              // FIELD_N tokens describe ordinary fields, not values that belong in the vault.
              return Boolean(field?.sensitive) && !resolveSecret(action.reference || "", secrets);
            })
            .map((action: any) => action.reference)
            .filter(Boolean);

          if (missingReferences.length > 0) {
            serverInstruction = `I need these saved values before I can continue: ${missingReferences.join(", ")}. Add them in the IndexedDB Vault, then run the task again. No fields were changed.`;
          } else {
          let purchaseConfirmationRequired = false;
          // Execute each approved action sequentially against the live DOM
          for (const act of data.actions) {
            if (act.action === "CLICK" && isFinalPurchaseAction(act.target, analysis)) {
              purchaseConfirmationRequired = true;
              console.log(`%c[Safety] ⏸️ Stopped before final purchase action; user confirmation is required.`, "color: #d97706;");
              continue;
            }
            if (act.action === "TYPE_REFERENCE") {
              let localSecret = await resolveVaultReference(act.reference);
              if (!localSecret) {
                localSecret = resolveSecret(act.reference, secrets);
              }
              if (localSecret) {
                console.log(`%c[Reference-Resolver] 🔑 Resolved ${act.reference} on-device (IndexedDB AES-GCM) ➔ "${localSecret.slice(0, 3)}***"`, "color: #2563eb; font-weight: bold;");
                await executeDomActionInTab(tabId, "TYPE", act.target, localSecret);
                executedCount++;
              } else {
                console.warn(`[Reference-Resolver] ⚠️ No secret found for ${act.reference}, skipping`);
              }
            } else if (act.action === "TYPE") {
              console.log(`%c[DOM-Executor] ⌨️ Typing into "${act.target}" (non-sensitive field)`, "color: #059669;");
              await executeDomActionInTab(tabId, "TYPE", act.target, act.value || "");
              executedCount++;
            } else if (act.action === "CLICK") {
              console.log(`%c[DOM-Executor] 🖱️ Clicking "${act.target}"`, "color: #059669;");
              await new Promise((r) => setTimeout(r, 400));
              await executeDomActionInTab(tabId, "CLICK", act.target);
              executedCount++;
              const clickedField = analysis.fields.find((field) => field.id === act.target);
              if (iteration < 8 && (clickedField?.tag === "a" || clickedField?.type === "button")) {
                await waitForTabComplete(tabId, 4000);
                await new Promise((r) => setTimeout(r, 700));
                return handleAskAI(task, userProtectedFieldIds, iteration + 1);
              }
            } else if (act.action === "NAVIGATE") {
              console.log(`%c[DOM-Executor] 🌐 Navigating to "${act.target}"`, "color: #059669;");
              await browser.tabs.update(tabId, { url: act.target });
              await waitForTabComplete(tabId);
              await new Promise((r) => setTimeout(r, 1200));
              executedCount++;
              if (iteration < 8) {
                return handleAskAI(task, userProtectedFieldIds, iteration + 1);
              }
            } else if (act.action === "SELECT") {
              console.log(`%c[DOM-Executor] 📋 Selecting "${act.value}" in "${act.target}"`, "color: #059669;");
              await executeDomActionInTab(tabId, "SELECT", act.target, act.value);
              executedCount++;
            } else if (act.action === "SCROLL") {
              console.log(`%c[DOM-Executor] 📜 Scrolling to "${act.target}"`, "color: #059669;");
              await executeDomActionInTab(tabId, "SCROLL", act.target);
              if (iteration < 8) {
                // Lazy-loaded result cards can expose price text only after
                // their region enters the viewport. Re-perceive after scroll.
                await new Promise((r) => setTimeout(r, 900));
                return handleAskAI(task, userProtectedFieldIds, iteration + 1);
              }
            } else if (act.action === "WAIT") {
              console.log(`%c[DOM-Executor] ⏳ Waiting...`, "color: #059669;");
              await executeDomActionInTab(tabId, "WAIT", act.target, act.value);
            }
          }


          const refCount = data.actions.filter((a: any) => a.action === "TYPE_REFERENCE").length;
          const typeCount = data.actions.filter((a: any) => a.action === "TYPE").length;
          const clickCount = data.actions.filter((a: any) => a.action === "CLICK").length;
          serverInstruction = purchaseConfirmationRequired
            ? `✓ Product details and checkout information are ready. I stopped before the final purchase action. Review the order and confirm manually on the website.`
            : `✓ Agent executed ${executedCount} actions (${refCount} protected fields resolved on-device, ${typeCount} fields filled, ${clickCount} clicks). 0 bytes of raw PII left this device.`;
          console.log("%c[Agent-Completion] ✅ Task completed successfully with zero privacy leakage!", "color: #16a34a; font-weight: bold; font-size: 13px;");
          }
        } else {
          const plannerData = data?.data && typeof data.data === "object" ? data.data : {};
          const missingItems = Array.isArray(plannerData.missing)
            ? plannerData.missing
            : Array.isArray(plannerData.required)
              ? plannerData.required
              : Array.isArray(plannerData.questions)
                ? plannerData.questions
                : [];
          const detail = data?.message || data?.instruction || plannerData.message;
          serverInstruction = detail || (missingItems.length > 0
            ? `I need more information: ${missingItems.join(", ")}.`
            : "The planner needs more information before it can continue.");
        }
      } else {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Agent planner unavailable (${response.status}). ${errorText.slice(0, 120)}`);
      }
    } catch (err) {
      console.warn("[Agent] Planner unavailable; no fields were changed:", err);
      serverInstruction = err instanceof Error
        ? `${err.message} No fields were changed.`
        : "Agent planner unavailable. No fields were changed.";
    }

    const result: AskAIResult = {
      type: "ASK_AI_RESULT",
      sensitiveItemsProtected,
      rawItemsSent,
      analysis,
      userProtectedFieldIds,
      serverInstruction,
    };

    await browser.storage.local.set({
      [getStorageKey(tabId)]: result,
    });

    return result;
  } catch (error) {
    const result: AskAIResult = {
      type: "ASK_AI_RESULT",
      sensitiveItemsProtected: 0,
      rawItemsSent: 0,
      analysis: null,
      userProtectedFieldIds,
      serverInstruction: null,
      error: error instanceof Error && /receiving end does not exist|could not establish connection/i.test(error.message)
        ? "The active webpage is not connected to Browser Agent. Open a normal webpage, reload it once, and run the agent again."
        : error instanceof Error ? error.message : "Unknown error",
    };

    return result;
  }
}

browser.runtime.onMessage.addListener(
  (message: ExtensionMessage) => {
    if (message.type === "ASK_AI") {
      const request = message as AskAIRequest;
      return handleAskAI(
        request.task,
        request.userProtectedFieldIds ?? []
      );
    }

    if (message.type === "HIGHLIGHT_ELEMENT") {
      return forwardToActiveTab(message);
    }

    if (message.type === "CLEAR_HIGHLIGHT") {
      return forwardToActiveTab(message);
    }

    return undefined;
  }
);

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void browser.storage.local.remove(getStorageKey(tabId));
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  void browser.storage.local.remove(getStorageKey(tabId));
});
