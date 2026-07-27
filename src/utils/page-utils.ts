/**
 * Page utilities for extracting responses from NotebookLM web UI
 *
 * This module provides functions to:
 * - Extract latest assistant responses from the page
 * - Wait for new responses with streaming detection
 * - Detect placeholders and loading states
 * - Snapshot existing responses for comparison
 *
 * Based on the Python implementation from page_utils.py
 */

import type { Page } from 'patchright';
import { log } from './logger.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * CSS selectors to find assistant response elements
 * Ordered by priority (most specific first)
 */
const RESPONSE_SELECTORS = [
  '.to-user-container .message-text-content',
  "[data-message-author='bot']",
  "[data-message-author='assistant']",
  "[data-message-role='assistant']",
  "[data-author='assistant']",
  "[data-renderer*='assistant']",
  "[data-automation-id='response-text']",
  "[data-automation-id='assistant-response']",
  "[data-automation-id='chat-response']",
  "[data-testid*='assistant']",
  "[data-testid*='response']",
  "[aria-live='polite']",
  "[role='listitem'][data-message-author]",
];

const DEFAULT_RESPONSE_STABLE_POLLS = 3;
const DEFAULT_DISAPPEARED_ANSWER_POLLS = 10;
const DEFAULT_DISAPPEARED_ANSWER_MIN_CHARS = 300;

function getPositiveInteger(value: number | undefined, envName: string, fallback: number): number {
  if (Number.isFinite(value) && value && value > 0) {
    return Math.floor(value);
  }

  const envValue = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(envValue) && envValue > 0 ? envValue : fallback;
}

/**
 * Text snippets that indicate a placeholder/loading state
 */
const PLACEHOLDER_SNIPPETS = [
  'antwort wird erstellt',
  'answer wird erstellt',
  'answer is being created',
  'answer is being generated',
  'creating answer',
  'generating answer',
  'wird erstellt',
  'getting the context', // NotebookLM initial loading message
  'getting the gist', // NotebookLM loading message (English)
  'analyse en cours', // NotebookLM loading message (French)
  'loading',
  'please wait',
  'обработка',
  'обрабатываю',
  'идет обработка',
  'идёт обработка',
  'ответ формируется',
  'формируется ответ',
  'генерируется ответ',
  'подождите',
  // NotebookLM English loading messages (seen in logs)
  'looking for clues',
  'reading full chapters',
  'examining the specifics',
  'checking the scope',
  'opening your notes',
  'analyzing your files',
  'searching your docs',
  'scanning sources',
  'reviewing content',
  'processing request',
];

// Error messages from NotebookLM that indicate failure
// These trigger immediate return (no stability wait) but NOT account rotation.
const ERROR_SNIPPETS = [
  "le système n'a pas pu répondre", // French: The system could not respond
  'the system could not respond',
  'системе не удалось ответить',
  "le système n'a pas réussi",
  'the system failed',
  'an error occurred',
  'произошла ошибка',
  'une erreur est survenue',
  'try again later',
  'повторите попытку позже',
  'réessayez plus tard',
];

// Rate limit specific messages (trigger account rotation)
// IMPORTANT: Must be VERY specific — generic phrases like "daily limit" or "revenez plus tard"
// can appear in academic answers and cause false positives.
const RATE_LIMIT_MESSAGES = [
  'vous avez atteint la limite quotidienne', // French: You have reached the daily limit
  'limite quotidienne de discussions', // French: Daily discussion limit
  'daily discussion limit',
  'daily limit reached',
  'query limit reached',
  'rate limit exceeded',
];

/**
 * Standalone UI control labels that can leak into extracted response text.
 * Only strip them when they appear as isolated lines to avoid mutating
 * legitimate answer content.
 */
const UI_CONTROL_LINES = new Set([
  'more_horiz',
  'more_vert',
  'open_in_new',
  'content_copy',
  'bookmark_border',
  'expand_more',
  'expand_less',
]);

/**
 * Check if text is an error message from NotebookLM
 */
export function isErrorMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_SNIPPETS.some((snippet) => lower.includes(snippet));
}

/**
 * Check if text indicates a rate limit error (should trigger account rotation)
 */
export function isRateLimitMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_MESSAGES.some((msg) => lower.includes(msg));
}

/**
 * Remove leaked UI-control text from NotebookLM responses.
 */
export function sanitizeResponseText(text: string): string {
  const trimmed = text.replace(/\r/g, '').trim();
  if (!trimmed) return '';

  const rawLines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const cleanedLines: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const prev = rawLines[i - 1] ?? '';
    const next = rawLines[i + 1] ?? '';
    const lower = line.toLowerCase();
    const prevIsUi = UI_CONTROL_LINES.has(prev.toLowerCase());
    const nextIsUi = UI_CONTROL_LINES.has(next.toLowerCase());

    if (UI_CONTROL_LINES.has(lower)) {
      continue;
    }

    if (/^\d+$/.test(line) && nextIsUi) {
      continue;
    }

    if (/^[.,;:!?]+$/.test(line) && (prevIsUi || nextIsUi)) {
      continue;
    }

    cleanedLines.push(line);
  }

  return cleanedLines
    .join('\n')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Simple string hash function (for efficient comparison)
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

/**
 * Check if text is a placeholder/loading message
 * Also treats short texts ending with "..." or "…" as placeholders (loading indicators)
 */
function isPlaceholder(text: string): boolean {
  const lower = text.toLowerCase();

  // Known placeholder phrases
  if (PLACEHOLDER_SNIPPETS.some((snippet) => lower.includes(snippet))) {
    return true;
  }

  // Short text ending with "..." or "…" is likely a loading message
  // Real responses are typically > 50 chars
  if (text.length < 50 && /(?:\.\.\.|…)$/.test(text.trim())) {
    return true;
  }

  return false;
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Snapshot the latest response text currently visible
 * Returns null if no response found
 */
export async function snapshotLatestResponse(page: Page): Promise<string | null> {
  return await extractLatestText(page, new Set(), false, 0);
}

/**
 * Snapshot ALL existing assistant response texts
 * Used to capture visible responses BEFORE submitting a new question
 */
export async function snapshotAllResponses(page: Page): Promise<string[]> {
  const allTexts: string[] = [];
  const primarySelector = '.to-user-container';

  try {
    const containers = await page.$$(primarySelector);
    if (containers.length > 0) {
      for (const container of containers) {
        try {
          const textElement = await container.$('.message-text-content');
          if (textElement) {
            const text = await textElement.innerText();
            if (text && text.trim()) {
              const sanitized = sanitizeResponseText(text);
              if (sanitized) {
                allTexts.push(sanitized);
              }
            }
          }
        } catch {
          continue;
        }
      }

      log.info(`📸 [SNAPSHOT] Captured ${allTexts.length} existing responses`);
    }
  } catch (error) {
    log.warning(`⚠️ [SNAPSHOT] Failed to snapshot responses: ${error}`);
  }

  return allTexts;
}

/**
 * Count `.to-user-container` elements (the primary answer-container selector).
 *
 * Used as a position-based baseline: NotebookLM adds exactly one new
 * `.to-user-container` per submitted question, so "index >= baseline" reliably
 * identifies the new answer even when its text happens to match a prior
 * answer's text (e.g. two questions both answered "Yes"). Text-hash dedup
 * alone cannot distinguish that case — see `extractLatestText`.
 */
export async function countAnswerContainers(page: Page): Promise<number> {
  try {
    return (await page.$$('.to-user-container')).length;
  } catch {
    return 0;
  }
}

/**
 * Marks assistant response containers that were already present before a
 * question is submitted. A DOM position alone is not a reliable identity:
 * NotebookLM virtualizes the chat and can mount an old response after the
 * baseline was captured. The marker stays local to the browser page and is
 * used only while waiting for this one answer.
 */
export async function markExistingAnswerContainers(page: Page, marker: string): Promise<void> {
  try {
    await page.evaluate(`
      (() => {
        const marker = ${JSON.stringify(marker)};
        document.querySelectorAll('.to-user-container').forEach((container) => {
          container.setAttribute('data-nblm-answer-before-request', marker);
        });
      })()
    `);
  } catch (error) {
    log.warning(`⚠️ [SNAPSHOT] Failed to mark existing responses: ${error}`);
  }
}

/**
 * Count the number of visible assistant response elements
 */
export async function countResponseElements(page: Page): Promise<number> {
  let count = 0;
  for (const selector of RESPONSE_SELECTORS) {
    try {
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        // Count only visible elements
        for (const el of elements) {
          try {
            const isVisible = await el.isVisible();
            if (isVisible) {
              count++;
            }
          } catch {
            continue;
          }
        }
        // If we found elements with this selector, stop trying others
        if (count > 0) {
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return count;
}

/**
 * Wait for a new assistant response with streaming detection
 *
 * This function:
 * 1. Polls the page for new response text
 * 2. Detects streaming (text changes) vs. complete (text stable)
 * 3. Requires text to be stable for 3 consecutive polls before returning
 * 4. Ignores placeholders, question echoes, and known responses
 *
 * @param page Playwright page instance
 * @param options Options for waiting
 * @returns The new response text, or null if timeout
 */
export async function waitForLatestAnswer(
  page: Page,
  options: {
    question?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    ignoreTexts?: string[];
    /**
     * Value assigned to answer containers that existed before submission.
     * Containers with this value must never be returned for the current
     * request, even if the UI reorders them.
     */
    existingAnswerMarker?: string;
    /**
     * Count of `.to-user-container` elements captured (via
     * `countAnswerContainers`) BEFORE the question was submitted. When
     * provided, the new answer is identified by DOM position (any container
     * at index >= baseline) instead of by text-hash dedup, so a repeated
     * answer text (e.g. two "Yes" answers) is still detected correctly.
     */
    baselineContainerCount?: number;
    debug?: boolean;
    stablePolls?: number;
    disappearedAnswerPolls?: number;
    disappearedAnswerMinChars?: number;
  } = {}
): Promise<string | null> {
  const {
    question = '',
    timeoutMs = 120000,
    pollIntervalMs = 1000,
    ignoreTexts = [],
    existingAnswerMarker,
    baselineContainerCount,
    debug = false,
    stablePolls,
    disappearedAnswerPolls,
    disappearedAnswerMinChars,
  } = options;

  const deadline = Date.now() + timeoutMs;
  const sanitizedQuestion = question.trim().toLowerCase();

  // Track ALL known texts as HASHES (memory efficient!)
  const knownHashes = new Set<number>();
  for (const text of ignoreTexts) {
    if (typeof text === 'string' && text.trim()) {
      knownHashes.add(hashString(text.trim()));
    }
  }

  if (debug) {
    log.debug(`🔍 [DEBUG] Waiting for NEW answer. Ignoring ${knownHashes.size} known responses`);
  }

  let pollCount = 0;
  let lastCandidate: string | null = null;
  let stableCount = 0; // Track how many times we see the same text
  let missingAfterCandidateCount = 0;
  const requiredStablePolls = getPositiveInteger(
    stablePolls,
    'NOTEBOOKLM_STABLE_POLLS',
    DEFAULT_RESPONSE_STABLE_POLLS
  );
  const requiredDisappearedPolls = getPositiveInteger(
    disappearedAnswerPolls,
    'NOTEBOOKLM_DISAPPEARED_ANSWER_POLLS',
    DEFAULT_DISAPPEARED_ANSWER_POLLS
  );
  const disappearedAnswerMinimumLength = getPositiveInteger(
    disappearedAnswerMinChars,
    'NOTEBOOKLM_DISAPPEARED_ANSWER_MIN_CHARS',
    DEFAULT_DISAPPEARED_ANSWER_MIN_CHARS
  );

  while (Date.now() < deadline) {
    pollCount++;

    // CHECK INPUT FIELD for rate limit message (appears there after submit)
    try {
      const inputField = await page.$('textarea.query-box-input');
      if (inputField) {
        // Check placeholder
        const placeholder = await inputField.getAttribute('placeholder');
        if (placeholder && isRateLimitMessage(placeholder)) {
          log.error(`🚫 [INPUT] Rate limit in placeholder: "${placeholder.substring(0, 60)}..."`);
          return placeholder; // Return immediately to trigger rotation
        }
        // Check value
        const value = await inputField.inputValue();
        if (value && isRateLimitMessage(value)) {
          log.error(`🚫 [INPUT] Rate limit in input value: "${value.substring(0, 60)}..."`);
          return value; // Return immediately to trigger rotation
        }
      }
    } catch {
      // Input check failed, continue with normal extraction
    }

    // Extract latest NEW text
    const candidate = await extractLatestText(
      page,
      knownHashes,
      debug,
      pollCount,
      baselineContainerCount,
      existingAnswerMarker
    );

    if (candidate) {
      const normalized = candidate.trim();
      if (normalized) {
        const lower = normalized.toLowerCase();

        // Check if it's a placeholder
        if (isPlaceholder(lower)) {
          if (lastCandidate && lastCandidate.length >= disappearedAnswerMinimumLength) {
            missingAfterCandidateCount++;
            if (missingAfterCandidateCount >= requiredDisappearedPolls) {
              log.warning(
                `⚠️ [RESPONSE] Returning last observed answer after ${missingAfterCandidateCount} placeholder polls (${lastCandidate.length} chars)`
              );
              return lastCandidate;
            }
          }
          if (debug) {
            log.debug(
              `🔍 [DEBUG] Found placeholder: "${normalized.substring(0, 50)}..." - continuing...`
            );
          }
          await page.waitForTimeout(250);
          continue;
        }

        missingAfterCandidateCount = 0;

        // IMMEDIATE RETURN: Error messages don't need stability check
        if (isErrorMessage(normalized)) {
          log.warning(
            `⚠️ [RESPONSE] NotebookLM error detected: "${normalized.substring(0, 60)}..."`
          );
          return normalized; // Return immediately, no need to wait for stability
        }

        // IMMEDIATE RETURN: Rate limit messages trigger immediate return
        if (isRateLimitMessage(normalized)) {
          log.error(`🚫 [RESPONSE] Rate limit detected: "${normalized.substring(0, 60)}..."`);
          return normalized; // Return immediately to trigger account rotation
        }

        // DEBUG: Log the candidate text to see what we're getting
        if (debug && normalized !== lastCandidate) {
          log.debug(
            `🔍 [DEBUG] New candidate text (${normalized.length} chars): "${normalized.substring(0, 100)}..."`
          );
        }

        // Check if it's the question echo
        if (lower === sanitizedQuestion) {
          if (debug) {
            log.debug('🔍 [DEBUG] Found question echo, ignoring');
          }
          knownHashes.add(hashString(normalized)); // Mark as seen
          await page.waitForTimeout(pollIntervalMs);
          continue;
        }

        // ========================================
        // STREAMING DETECTION: Check if text is stable
        // ========================================
        if (normalized === lastCandidate) {
          // Text hasn't changed - it's stable
          stableCount++;
          if (debug && stableCount === requiredStablePolls) {
            log.debug(
              `✅ [DEBUG] Text stable for ${stableCount} polls (${normalized.length} chars)`
            );
          }
        } else {
          // Text changed - streaming in progress
          if (debug && lastCandidate) {
            log.debug(
              `🔄 [DEBUG] Text changed (${normalized.length} chars, was ${lastCandidate.length})`
            );
          }
          stableCount = 1;
          lastCandidate = normalized;
        }

        // Only return once text is stable
        if (stableCount >= requiredStablePolls) {
          if (debug) {
            log.debug(`✅ [DEBUG] Returning stable answer (${normalized.length} chars)`);
          }
          return normalized;
        }
      }
    } else if (lastCandidate && lastCandidate.length >= disappearedAnswerMinimumLength) {
      missingAfterCandidateCount++;
      if (missingAfterCandidateCount >= requiredDisappearedPolls) {
        log.warning(
          `⚠️ [RESPONSE] Returning last observed answer after ${missingAfterCandidateCount} missing polls (${lastCandidate.length} chars)`
        );
        return lastCandidate;
      }
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  if (debug) {
    log.debug(`⏱️ [DEBUG] Timeout after ${pollCount} polls`);
  }
  return null;
}

/**
 * Extract the latest NEW response text from the page
 *
 * When `baselineContainerCount` is provided, identity is by DOM position:
 * only `.to-user-container` elements added after the baseline are
 * considered "new" (scanned from the end, most recent first). This is the
 * reliable path — NotebookLM adds exactly one new container per submitted
 * question, so position can't be fooled by a repeated answer text.
 *
 * Falls back to hash-based text dedup when no baseline is given (e.g.
 * `snapshotLatestResponse`, which has no "before" state to compare against).
 * The hash fallback has a known false-negative: if the new answer's text
 * happens to match an earlier answer's text, it gets skipped as "known".
 *
 * @param page Playwright page instance
 * @param knownHashes Set of hashes of already-seen response texts (hash-fallback path only)
 * @param debug Enable debug logging
 * @param pollCount Current poll number (for conditional logging)
 * @param baselineContainerCount Container count before the question was submitted (position path)
 * @param existingAnswerMarker Marker for containers present before the request
 * @returns First NEW response text found, or null
 */
async function extractLatestText(
  page: Page,
  knownHashes: Set<number>,
  debug: boolean,
  pollCount: number,
  baselineContainerCount?: number,
  existingAnswerMarker?: string
): Promise<string | null> {
  // Try the primary selector first (most specific for NotebookLM)
  const primarySelector = '.to-user-container';
  try {
    const containers = await page.$$(primarySelector);
    const totalContainers = containers.length;

    // Log container count (but don't early exit - always check content)
    if (debug && pollCount % 5 === 0) {
      log.dim(
        `⏭️ [EXTRACT] Checking ${totalContainers} containers (${knownHashes.size} known hashes)`
      );
    }

    if (existingAnswerMarker) {
      // Do not trust a position-based baseline on its own. NotebookLM can
      // virtualize the transcript and insert an old card after that baseline.
      // The response is valid only if it is a container not present before
      // this request and its text was not already visible in the transcript.
      for (let idx = containers.length - 1; idx >= 0; idx--) {
        const container = containers[idx];
        try {
          if (
            (await container.getAttribute('data-nblm-answer-before-request')) ===
            existingAnswerMarker
          ) {
            continue;
          }
          const textElement = await container.$('.message-text-content');
          if (textElement) {
            const text = await textElement.innerText();
            const sanitized = sanitizeResponseText(text || '');
            if (sanitized && !knownHashes.has(hashString(sanitized))) {
              log.success(
                `✅ [EXTRACT] Found unmarked new text in container[${idx}]: ${sanitized.length} chars`
              );
              return sanitized;
            }
          }
        } catch {
          continue;
        }
      }
      if (debug && pollCount % 5 === 0) {
        log.dim(`⏭️ [EXTRACT] No unmarked new response in ${totalContainers} containers`);
      }
      return null;
    }

    if (typeof baselineContainerCount === 'number') {
      // Position-based identity: scan only containers added after the
      // baseline, most recent first, and return the first with extractable
      // text. Deliberately does NOT compare text content — a container at a
      // new position IS the new answer, regardless of what it says.
      for (let idx = containers.length - 1; idx >= baselineContainerCount; idx--) {
        const container = containers[idx];
        try {
          const textElement = await container.$('.message-text-content');
          if (textElement) {
            const text = await textElement.innerText();
            const sanitized = sanitizeResponseText(text || '');
            if (sanitized) {
              log.success(
                `✅ [EXTRACT] Found new-position text in container[${idx}] (baseline ${baselineContainerCount}): ${sanitized.length} chars`
              );
              return sanitized;
            }
          }
        } catch {
          continue;
        }
      }
      if (debug && pollCount % 5 === 0) {
        log.dim(
          `⏭️ [EXTRACT] No container past baseline ${baselineContainerCount} yet (${totalContainers} total)`
        );
      }
      return null;
    }

    if (containers.length > 0) {
      // Only log every 5th poll to reduce noise
      if (debug && pollCount % 5 === 0) {
        log.dim(`🔍 [EXTRACT] Scanning ${totalContainers} containers (${knownHashes.size} known)`);
      }

      let skipped = 0;
      let empty = 0;

      // Scan ALL containers to find the FIRST with NEW text
      for (let idx = 0; idx < containers.length; idx++) {
        const container = containers[idx];
        try {
          const textElement = await container.$('.message-text-content');
          if (textElement) {
            const text = await textElement.innerText();
            const sanitized = sanitizeResponseText(text || '');
            if (sanitized) {
              // Hash-based comparison (faster & less memory)
              const textHash = hashString(sanitized);
              if (!knownHashes.has(textHash)) {
                log.success(
                  `✅ [EXTRACT] Found NEW text in container[${idx}]: ${sanitized.length} chars`
                );
                return sanitized;
              } else {
                skipped++;
              }
            } else {
              empty++;
            }
          }
        } catch {
          continue;
        }
      }

      // Only log summary if debug enabled
      if (debug && pollCount % 5 === 0) {
        log.dim(`⏭️ [EXTRACT] No NEW text (skipped ${skipped} known, ${empty} empty)`);
      }
      return null; // Don't fall through to fallback!
    } else {
      if (debug) {
        log.warning('⚠️ [EXTRACT] No containers found');
      }
    }
  } catch (error) {
    log.error(`❌ [EXTRACT] Primary selector failed: ${error}`);
  }

  // Fallback: Try other selectors (only if primary selector failed/found nothing)
  if (debug) {
    log.dim('🔄 [EXTRACT] Trying fallback selectors...');
  }

  for (const selector of RESPONSE_SELECTORS) {
    try {
      const elements = await page.$$(selector);
      if (elements.length === 0) continue;

      // Scan ALL elements to find the first with NEW text
      for (const element of elements) {
        try {
          // Prefer full container text when available
          let container = element;
          try {
            const closest = await element.evaluateHandle((el) => {
              return el.closest(
                '[data-message-author], [data-message-role], [data-author], ' +
                  "[data-testid*='assistant'], [data-automation-id*='response'], article, section"
              );
            });
            if (closest) {
              container = closest.asElement() || element;
            }
          } catch {
            container = element;
          }

          const text = await container.innerText();
          const sanitized = sanitizeResponseText(text || '');
          if (sanitized && !knownHashes.has(hashString(sanitized))) {
            return sanitized;
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  // Final fallback: JavaScript evaluation
  try {
    const fallbackText = await page.evaluate((): string | null => {
      // @ts-expect-error - DOM types available in browser context
      const unique = new Set<Element>();
      // @ts-expect-error - DOM types available in browser context
      const isVisible = (el: Element): boolean => {
        // @ts-expect-error - DOM types available in browser context
        if (!el || !(el as HTMLElement).isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // @ts-expect-error - window available in browser context
        const style = window.getComputedStyle(el as HTMLElement);
        if (
          style.visibility === 'hidden' ||
          style.display === 'none' ||
          parseFloat(style.opacity || '1') === 0
        ) {
          return false;
        }
        return true;
      };

      const selectors = [
        '[data-message-author]',
        '[data-message-role]',
        '[data-author]',
        "[data-renderer*='assistant']",
        "[data-testid*='assistant']",
        "[data-automation-id*='response']",
      ];

      const candidates: string[] = [];
      for (const selector of selectors) {
        // @ts-expect-error - document available in browser context
        for (const el of document.querySelectorAll(selector)) {
          if (!isVisible(el)) continue;
          if (unique.has(el)) continue;
          unique.add(el);

          // @ts-expect-error - DOM types available in browser context
          const text = (el as HTMLElement).innerText || (el as HTMLElement).textContent || '';
          if (!text.trim()) continue;

          candidates.push(text.trim());
        }
      }

      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }

      return null;
    });

    if (typeof fallbackText === 'string') {
      const sanitized = sanitizeResponseText(fallbackText);
      if (sanitized) {
        return sanitized;
      }
    }
  } catch {
    // Ignore evaluation errors
  }

  return null;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  snapshotLatestResponse,
  snapshotAllResponses,
  countAnswerContainers,
  countResponseElements,
  sanitizeResponseText,
  waitForLatestAnswer,
};
