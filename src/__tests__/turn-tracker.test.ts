import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import vm from 'node:vm';
import {
  beginSubmittedTurn,
  createSubmission,
  readSubmittedTurn,
  endSubmittedTurn,
  stripSubmissionMarker,
} from '../utils/turn-tracker.js';
import { isPlaceholder, waitForLatestAnswer } from '../utils/page-utils.js';

/** Small DOM boundary: production page.evaluate code, not a copied classifier. */
class Element {
  nodeType = 1;
  parentElement: Element | null = null;
  children: Element[] = [];
  isConnected = true;
  constructor(
    public tag: string,
    public className = '',
    public textContent = '',
    public attrs: Record<string, string> = {}
  ) {}
  append(...children: Element[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  get innerText(): string {
    return [this.textContent, ...this.children.map((child) => child.innerText)]
      .filter(Boolean)
      .join('\n');
  }
  get tagName() {
    return this.tag.toUpperCase();
  }
  get childNodes(): any[] {
    return [
      ...(this.textContent ? [{ nodeType: 3, nodeValue: this.textContent }] : []),
      ...this.children,
    ];
  }
  cloneNode(deep: boolean): Element {
    const clone = new Element(this.tag, this.className, this.textContent, { ...this.attrs });
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
  getAttribute(name: string) {
    return this.attrs[name] || null;
  }
  closest(selector: string): Element | null {
    const matches = selector.startsWith('.')
      ? this.className.split(' ').includes(selector.slice(1))
      : this.tag === selector;
    return matches ? this : this.parentElement?.closest(selector) || null;
  }
  getBoundingClientRect() {
    return { width: 100, height: 20 };
  }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(',').map((value) => value.trim());
    const matches = (element: Element) =>
      selectors.some((value) => {
        if (value.startsWith('.')) return element.className.split(' ').includes(value.slice(1));
        if (value.includes('.') && !value.startsWith('[')) {
          const [tag, cls] = value.split('.');
          return element.tag === tag && element.className.split(' ').includes(cls);
        }
        const attribute = value.match(/^\[([^=]+)="([^"]+)"\]$/);
        if (attribute) return element.getAttribute(attribute[1]) === attribute[2];
        return element.tag === value;
      });
    const result: Element[] = [];
    const visit = (element: Element) => {
      for (const child of element.children) {
        if (matches(child)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function pair(question: string, answer: string, generating = false, id?: string) {
  const root = new Element('div', 'chat-message-pair', '', id ? { 'data-turn-id': id } : {});
  const user = new Element('div', 'from-user-container', question);
  const text = new Element('div', 'message-text-content', answer);
  const assistant = new Element('div', 'to-user-container');
  assistant.append(text);
  if (generating) assistant.append(new Element('mat-progress-spinner'));
  else
    assistant.append(
      new Element('button', '', '', {
        'aria-label': 'Copier la réponse du modèle dans le presse-papiers',
      }).append(new Element('mat-icon', '', 'copy'))
    );
  root.append(
    new Element('chat-message').append(user),
    new Element('chat-message').append(assistant)
  );
  return { root, user, assistant, text };
}

function browser(initial: Element[] = []) {
  const body = new Element('body').append(...initial);
  const context = vm.createContext({
    window: {},
    document: { body, querySelectorAll: (selector: string) => body.querySelectorAll(selector) },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  let now = 0;
  let step = 0;
  const page: any = {
    evaluate: async (script: string) => vm.runInContext(script, context),
    $: async () => null,
    waitForTimeout: async (ms: number) => {
      now += ms;
      page.onPoll?.(++step);
    },
    replace: (...elements: Element[]) => {
      for (const old of body.children) old.isConnected = false;
      body.children = [];
      body.append(...elements);
    },
    add: (element: Element) => body.append(element),
    onPoll: null,
    now: () => now,
  };
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  return page;
}

describe('Submitted turn identity and completion', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts repeated identical answers from the proven current generating pair', async () => {
    const old = pair('old question', 'Да.');
    const page = browser([old.root]);
    const turn = await beginSubmittedTurn(page, 'new question', 'request-one');
    const current = pair('new question', 'Да.', true);
    page.add(current.root);
    expect((await readSubmittedTurn(page, turn))?.generating).toBe(true);
    current.assistant.children = [
      current.text,
      new Element('button').append(new Element('mat-icon', '', 'thumb_up')),
    ];
    expect(
      await waitForLatestAnswer(page, {
        submittedTurn: turn,
        ignoreTexts: ['Да.'],
        timeoutMs: 10000,
      })
    ).toBe('Да.');
  });

  it('does not bind remounted historical cards even when the question repeats', async () => {
    const page = browser([pair('same question', 'historical').root]);
    const turn = await beginSubmittedTurn(page, 'same question', 'request-two');
    page.replace(pair('same question', 'Previously unseen historical answer').root);
    expect(await readSubmittedTurn(page, turn)).toBeNull();
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 3000 })).toBeNull();
  });

  it('survives assistant child remount inside the current proven pair', async () => {
    const page = browser();
    const turn = await beginSubmittedTurn(page, 'question', 'child-remount');
    const current = pair('question', 'stream', true);
    page.add(current.root);
    await readSubmittedTurn(page, turn);
    const replacement = pair('question', 'Complete OBD2 answer.');
    current.root.children[1] = replacement.root.children[1];
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 5000 })).toBe(
      'Complete OBD2 answer.'
    );
  });

  it('reattaches a remounted pair by the same stable id and never to another id', async () => {
    const page = browser();
    const turn = await beginSubmittedTurn(page, 'question', 'stable-remount');
    page.add(pair('question', 'stream', true, 'current-id').root);
    await readSubmittedTurn(page, turn);
    page.replace(pair('question', 'historical answer', false, 'different-id').root);
    expect(await readSubmittedTurn(page, turn)).toBeNull();
    page.replace(pair('question', 'Complete DOT4 answer.', false, 'current-id').root);
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 5000 })).toBe(
      'Complete DOT4 answer.'
    );
  });

  it('fails closed on a full pair remount with no stable id', async () => {
    const page = browser();
    const turn = await beginSubmittedTurn(page, 'question', 'unsafe-remount');
    page.add(pair('question', 'stream', true).root);
    await readSubmittedTurn(page, turn);
    page.replace(pair('question', 'Unproven replacement answer.').root);
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 3000 })).toBeNull();
  });

  it('correlates full pair remount by a fresh nonce even for repeated question and answer', async () => {
    const prior = createSubmission('Повторяющийся вопрос?');
    const current = createSubmission('Повторяющийся вопрос?');
    expect(current.marker).not.toBe(prior.marker);
    const page = browser([pair(prior.transportQuestion, 'Да.').root]);
    const turn = await beginSubmittedTurn(page, current.transportQuestion, current.marker);
    page.add(pair(current.transportQuestion, 'Да.', true).root);
    expect((await readSubmittedTurn(page, turn))?.generating).toBe(true);
    page.replace(pair(prior.transportQuestion, 'Да.').root);
    expect(await readSubmittedTurn(page, turn)).toBeNull();
    page.replace(pair(current.transportQuestion, 'Да.').root);
    expect(
      await waitForLatestAnswer(page, {
        submittedTurn: turn,
        timeoutMs: 5000,
        ignoreTexts: ['Да.'],
      })
    ).toBe('Да.');
  });

  it('does not accept missing or foreign nonces even if their pairs are generating', async () => {
    const current = createSubmission('Question?');
    const foreign = createSubmission('Question?');
    const page = browser();
    const turn = await beginSubmittedTurn(page, current.transportQuestion, current.marker);
    page.add(pair('Question?', 'stream', true).root);
    page.add(pair(foreign.transportQuestion, 'stream', true).root);
    expect(await readSubmittedTurn(page, turn)).toBeNull();
  });

  it('correlates rendered user Markdown through the exact nonce without rewriting the public question', async () => {
    const question = '**OBD2**: какие значения (12)?';
    const submission = createSubmission(question);
    const page = browser();
    const turn = await beginSubmittedTurn(page, submission.transportQuestion, submission.marker);
    page.add(pair(submission.transportQuestion.replace('**OBD2**', 'OBD2'), 'stream', true).root);
    expect((await readSubmittedTurn(page, turn))?.generating).toBe(true);
    expect(question).toBe('**OBD2**: какие значения (12)?');
  });

  it('binds a recycled historical DOM node only after its user content has the current nonce', async () => {
    const recycled = pair('old question', 'old answer', false, 'recycled-slot');
    const page = browser([recycled.root]);
    const submission = createSubmission('new question');
    const turn = await beginSubmittedTurn(page, submission.transportQuestion, submission.marker);
    recycled.user.textContent = submission.transportQuestion;
    recycled.text.textContent = 'new answer';
    recycled.assistant.children = [recycled.text, new Element('mat-progress-spinner')];
    expect((await readSubmittedTurn(page, turn))?.generating).toBe(true);
    recycled.user.textContent = createSubmission('historical question').transportQuestion;
    expect(await readSubmittedTurn(page, turn)).toBeNull();
    recycled.user.textContent = submission.transportQuestion;
    recycled.assistant.children = [
      recycled.text,
      new Element('button').append(new Element('mat-icon', '', 'copy')),
    ];
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 5000 })).toBe(
      'new answer'
    );
  });

  it('removes only this request marker if echoed and preserves technical identifiers and other markers', () => {
    const current = createSubmission('Use DOT4 and OBD2 (12).');
    const foreign = createSubmission('Question?');
    const body = `DOT4 OBD2 (12).\n[${foreign.marker}]`;
    expect(stripSubmissionMarker(`${body}\n[${current.marker}]`, current)).toBe(body);
    expect(stripSubmissionMarker(current.transportQuestion, current)).toBe(
      'Use DOT4 and OBD2 (12).'
    );
  });

  it('uses the real global composer stop state and assistant sibling completion controls', async () => {
    const submission = createSubmission('Question?');
    const page = browser();
    const turn = await beginSubmittedTurn(page, submission.transportQuestion, submission.marker);
    const current = pair(submission.transportQuestion, 'Stable intermediate text.');
    // Actual NotebookLM can place controls beside the response content.
    const responseMessage = current.root.children[1];
    current.assistant.children = [current.text];
    responseMessage.append(new Element('button').append(new Element('mat-icon', '', 'copy')));
    const stop = new Element('button', '', '', { 'aria-label': 'Arrêter la génération' }).append(
      new Element('mat-icon', '', 'stop')
    );
    page.add(current.root);
    page.add(stop);
    expect((await readSubmittedTurn(page, turn))?.generating).toBe(true);
    page.onPoll = (step: number) => {
      if (step === 4) {
        stop.isConnected = false;
        current.text.textContent = 'Final completed answer.';
      }
    };
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 10000 })).toBe(
      'Final completed answer.'
    );
    expect(page.now()).toBeGreaterThanOrEqual(6000);
  });

  it('removes verified thinking/citation DOM nodes on a clone while retaining all technical numbers', async () => {
    const page = browser();
    const submission = createSubmission('Question?');
    const turn = await beginSubmittedTurn(page, submission.transportQuestion, submission.marker);
    const current = pair(submission.transportQuestion, 'stream', true);
    page.add(current.root);
    await readSubmittedTurn(page, turn);
    current.text.textContent = '';
    current.text.append(
      new Element('thinking-chain-view').append(
        new Element('button', 'thinking-chain__header', 'Thoughts')
      ),
      new Element('div', 'paragraph').append(
        new Element('span', '', 'Используйте DOT4 и OBD2 (12).'),
        new Element('button', 'citation-marker', '56'),
        new Element('button', 'citation-marker').append(new Element('mat-icon', '', 'more_horiz'))
      ),
      new Element('p', '', 'Задайте значение:'),
      new Element('p', '', '12'),
      new Element('p', '', 'Подождите 10 минут. Что показывает датчик?')
    );
    current.assistant.children = [
      current.text,
      new Element('button').append(new Element('mat-icon', '', 'copy')),
    ];
    const text = await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 5000 });
    expect(text).toBe(
      'Используйте DOT4 и OBD2 (12).\nЗадайте значение:\n12\nПодождите 10 минут. Что показывает датчик?'
    );
    expect(current.text.querySelector('thinking-chain-view')).not.toBeNull();
    expect(current.text.querySelectorAll('button.citation-marker')).toHaveLength(2);
  });

  it('does not complete a long stable fragment during a generation pause', async () => {
    const page = browser();
    const turn = await beginSubmittedTurn(page, 'question', 'pause');
    const current = pair('question', 'Partial text. '.repeat(40), true);
    page.add(current.root);
    page.onPoll = (step: number) => {
      if (step === 7) {
        current.text.textContent += '\nFinal conclusion: use DOT4.';
        current.assistant.children = [
          current.text,
          new Element('button').append(new Element('mat-icon', '', 'thumb_down')),
        ];
      }
    };
    const result = await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 15000 });
    expect(result).toContain('Final conclusion: use DOT4.');
    expect(page.now()).toBeGreaterThanOrEqual(9000);
  });

  it('waits through placeholder/missing polls and never returns the disappeared chunk', async () => {
    const page = browser();
    const turn = await beginSubmittedTurn(page, 'question', 'disappearance');
    const current = pair('question', 'Partial text. '.repeat(40), true);
    page.add(current.root);
    await readSubmittedTurn(page, turn);
    page.onPoll = (step: number) => {
      if (step === 1) current.text.textContent = 'Answer is being generated...';
      if (step === 3) page.replace();
      if (step === 12) {
        page.add(current.root);
        current.text.textContent =
          'Обработка кузова: подождите 10 минут. The loading capacity is 500 kg.';
        current.assistant.children = [
          current.text,
          new Element('button').append(new Element('mat-icon', '', 'thumb_up')),
        ];
      }
    };
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 20000 })).toBe(
      'Обработка кузова: подождите 10 минут. The loading capacity is 500 kg.'
    );
  });

  it('times out instead of returning any partial answer if the current pair disappears forever', async () => {
    const page = browser();
    const turn = await beginSubmittedTurn(page, 'question', 'missing-forever');
    page.add(pair('question', 'Partial text. '.repeat(40), true).root);
    await readSubmittedTurn(page, turn);
    page.replace();
    expect(await waitForLatestAnswer(page, { submittedTurn: turn, timeoutMs: 5000 })).toBeNull();
    await endSubmittedTurn(page, turn);
    expect(await readSubmittedTurn(page, turn)).toBeNull();
  });

  it('matches only normalized short placeholders, not technical prose or arbitrary ellipses', () => {
    expect(isPlaceholder('  Обработка… ')).toBe(true);
    expect(isPlaceholder('Answer is being generated...')).toBe(true);
    for (const text of [
      'Антикоррозийная обработка кузова.',
      'Обрабатываю данные CAN.',
      'Подождите 10 минут.',
      'The loading capacity is 500 kg.',
      'Продолжение в пункте 3…',
    ]) {
      expect(isPlaceholder(text)).toBe(false);
    }
  });
});
