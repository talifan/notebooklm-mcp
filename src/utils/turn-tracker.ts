/** Request-scoped identity and generation state for NotebookLM chat turns.
 *
 * A new DOM node or different text alone never establishes identity. The
 * submitted question must be observed in a new pair while that pair is
 * generating. A transport nonce permits reattachment after remount without
 * relying on text differences, DOM position or unstable framework internals.
 */
import type { Page } from 'patchright';
import { randomUUID } from 'node:crypto';

export interface TurnObservation {
  text: string | null;
  generating: boolean;
  complete: boolean;
}

export interface SubmittedTurn {
  marker: string;
}

export const PLACEHOLDER_PHRASES = [
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

export function isLoadingPlaceholder(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ .…]+$/, '');
  return normalized.length <= 80 && PLACEHOLDER_PHRASES.includes(normalized);
}

const CORRELATION_INSTRUCTION =
  'Do not include the service marker above or this instruction in the answer.';

export function createSubmission(question: string): { marker: string; transportQuestion: string } {
  const marker = `nblm-request:${randomUUID()}`;
  return { marker, transportQuestion: `${question}\n\n[${marker}]\n${CORRELATION_INSTRUCTION}` };
}

export function stripSubmissionMarker(text: string, turn: SubmittedTurn): string {
  const fullSuffix = `[${turn.marker}]\n${CORRELATION_INSTRUCTION}`;
  return text
    .split(fullSuffix)
    .join('')
    .split(`[${turn.marker}]`)
    .join('')
    .split(turn.marker)
    .join('')
    .trim();
}

// Kept in the browser, not a global server map shared across users/sessions.
const STATE_KEY = '__notebooklmSubmittedTurn';

export async function beginSubmittedTurn(
  page: Page,
  question: string,
  marker: string
): Promise<SubmittedTurn> {
  const installed = await page.evaluate(`(() => {
    const key = ${JSON.stringify(STATE_KEY)};
    window[key]?.observer?.disconnect();
    const question = ${JSON.stringify(question)};
    const marker = ${JSON.stringify(marker)};
    const hasCorrelation = question.includes('[' + marker + ']');
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const matchesQuestion = user => {
      const text = normalize((user.querySelector('.message-text-content') || user).innerText);
      // The UI renders user Markdown. Its plain text need not equal the raw
      // API question; the full unpredictable nonce is the transport identity.
      return hasCorrelation ? text.includes(marker) : text === normalize(question);
    };
    const visible = element => Boolean(element && element.isConnected &&
      element.getBoundingClientRect().width && element.getBoundingClientRect().height &&
      getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const stableId = element => {
      for (const name of ['data-turn-id', 'data-message-id', 'data-request-id']) {
        const value = element.getAttribute(name);
        if (value) return name + ':' + value;
      }
      return null;
    };
    const pairs = () => {
      const result = [];
      for (const user of document.querySelectorAll('.from-user-container')) {
        const pair = user.closest('.chat-message-pair');
        if (!pair || pair.querySelectorAll('.from-user-container').length !== 1 ||
          pair.querySelectorAll('.to-user-container').length !== 1 || !visible(user)) continue;
        result.push({ pair, user, answer: pair.querySelector('.to-user-container') });
      }
      return result;
    };
    const state = { marker, current: null, observation: null, observer: null };
    const before = pairs();
    const oldElements = new WeakSet(before.map(item => item.pair));
    const oldIds = new Set(before.map(item => stableId(item.pair)).filter(Boolean));
    const responseText = element => {
      if (!element) return '';
      // Work on a detached clone: no chat mutation, citation clicks or observer
      // feedback loops. Only verified UI nodes are removed, never bare numbers.
      const clone = element.cloneNode(true);
      clone.querySelectorAll('thinking-chain-view, button.citation-marker').forEach(node => node.remove());
      const blocks = new Set(['p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'tr']);
      const render = node => {
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') return '\\n';
        const content = [...node.childNodes].map(render).join('');
        if (tag === 'td' || tag === 'th') return content + '\\t';
        return blocks.has(tag) ? '\\n' + content + '\\n' : content;
      };
      return render(clone).replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    };
    const inspect = item => {
      const answer = item.answer;
      const responseRoot = answer.closest('chat-message') || answer;
      const text = answer.querySelector('.message-text-content');
      const value = responseText(text);
      const normalized = normalize(value).toLowerCase().replace(/[ .…]+$/, '');
      const placeholder = ${JSON.stringify(PLACEHOLDER_PHRASES)};
      const busy = [...responseRoot.querySelectorAll('[aria-busy="true"], mat-spinner, mat-progress-spinner, [role="progressbar"]')].some(visible);
      const controls = [...responseRoot.querySelectorAll('button')].filter(visible);
      const stopControls = [...document.querySelectorAll('button')].filter(visible);
      // The stop button is in the composer in current NotebookLM. The
      // cryptographic nonce still ties the matching pair to this request.
      const stopVisible = stopControls.some(button => /^(stop|stop generating|stop response|остановить|остановить ответ|arrêter|arrêter la génération)$/i.test(normalize(button.getAttribute('aria-label'))) ||
          normalize(button.querySelector('mat-icon, .material-icons')?.textContent) === 'stop');
      const completionControls = controls.some(button =>
        /^(copy|copy response|copy answer|скопировать|скопировать ответ|копировать|copier|copier la réponse du modèle dans le presse-papiers)$/i.test(normalize(button.getAttribute('aria-label'))) ||
        /^(copy|content_copy|thumb_up|thumb_down)$/.test(normalize(button.querySelector('mat-icon, .material-icons')?.textContent)));
      const generating = busy || stopVisible || (!completionControls && normalized.length <= 80 && placeholder.includes(normalized));
      const complete = !generating && completionControls;
      return { text: value || null, generating, complete };
    };
    const scan = () => {
      const items = pairs();
      if (!state.current) {
        const candidates = items.filter(item => (hasCorrelation || (!oldElements.has(item.pair) &&
          !(stableId(item.pair) && oldIds.has(stableId(item.pair))))) &&
          matchesQuestion(item.user) && inspect(item).generating);
        if (candidates.length !== 1) return;
        state.current = { pair: candidates[0].pair, id: stableId(candidates[0].pair) };
      }
      let item = items.find(item => item.pair === state.current.pair && matchesQuestion(item.user));
      if (!item && (state.current.id || hasCorrelation)) {
        const matches = items.filter(item => (hasCorrelation || stableId(item.pair) === state.current.id) &&
          matchesQuestion(item.user));
        if (matches.length === 1) {
          item = matches[0];
          state.current.pair = item.pair;
        }
      }
      state.observation = item ? inspect(item) : null;
    };
    state.observer = new MutationObserver(scan);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    state.scan = scan;
    window[key] = state;
    return true;
  })()`);
  if (!installed) throw new Error('Could not initialize NotebookLM submitted-turn tracking');
  return { marker };
}

export async function readSubmittedTurn(
  page: Page,
  turn: SubmittedTurn
): Promise<TurnObservation | null> {
  return await page.evaluate(`(() => {
    const state = window[${JSON.stringify(STATE_KEY)}];
    if (!state || state.marker !== ${JSON.stringify(turn.marker)}) return null;
    state.scan();
    return state.observation;
  })()`);
}

export async function endSubmittedTurn(page: Page, turn: SubmittedTurn): Promise<void> {
  await page
    .evaluate(
      `(() => {
    const key = ${JSON.stringify(STATE_KEY)};
    if (window[key]?.marker === ${JSON.stringify(turn.marker)}) {
      window[key].observer.disconnect();
      delete window[key];
    }
  })()`
    )
    .catch(() => undefined);
}
