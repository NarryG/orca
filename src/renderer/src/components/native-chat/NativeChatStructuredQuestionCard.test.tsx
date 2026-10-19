// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import type { AgentJournalQuestion } from '../../../../shared/agent-session-journal-types'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(question: AgentJournalQuestion | AgentJournalQuestion[], declineOptionId?: string) {
  const onAnswer = vi.fn()
  const onCancel = vi.fn()
  act(() =>
    root.render(
      <NativeChatStructuredQuestionCard
        questions={Array.isArray(question) ? question : [question]}
        onAnswer={onAnswer}
        onCancel={onCancel}
        declineOptionId={declineOptionId}
      />
    )
  )
  return { onAnswer, onCancel }
}
function submit(): void {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === 'Submit'
  )
  if (!button) {
    throw new Error('Missing Submit button')
  }
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function clickOption(label: string): void {
  const button = [...container.querySelectorAll('button[aria-pressed]')].find(
    (node) => node.textContent?.replace(/^\d+\s*/, '').trim() === label
  )
  if (!button) {
    throw new Error(`Missing option: ${label}`)
  }
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

const input: AgentJournalQuestion = {
  id: 'text',
  question: 'Enter text',
  options: [],
  multiSelect: false,
  freeTextQuestionId: 'text',
  freeTextInput: { allowEmpty: true, placeholder: 'Provider placeholder' }
}

describe('structured extension question cards', () => {
  it('keeps exclusive structured choices separate when encoding their option ids', () => {
    const { onAnswer } = render({
      id: 'targets',
      question: 'Choose targets',
      multiSelect: true,
      options: [
        { id: 'web', label: 'Web' },
        { id: 'mobile', label: 'Mobile' },
        { id: 'none', label: 'No selections', exclusive: true }
      ]
    })
    clickOption('Web')
    clickOption('Mobile')
    clickOption('No selections')
    submit()
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [{ questionId: 'targets', optionIds: ['none'] }]
    })
  })

  it('offers decline only for forms and delivers it without requiring field answers or cancelling', () => {
    render(input)
    expect(container.textContent).not.toContain('Decline request')
    const { onAnswer, onCancel } = render(input, 'acp-form-decline')
    const decline = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Decline request'
    )!
    act(() => decline.click())
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'option', optionId: 'acp-form-decline' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('submits an empty input as an answer', () => {
    const { onAnswer } = render(input)
    expect(container.querySelector('input')?.placeholder).toBe('Provider placeholder')
    submit()
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [{ questionId: 'text', optionIds: [], other: '' }]
    })
  })

  it('renders the editor prefill and preserves whitespace, newlines and Unicode separators', () => {
    const text = ' first\nsecond\u2028third\u2029fourth '
    const { onAnswer } = render({
      ...input,
      freeTextInput: { allowEmpty: true, multiline: true, initialValue: text }
    })
    expect(container.querySelector('textarea')?.value).toBe(text)
    expect(container.querySelector('input')).toBeNull()
    submit()
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [{ questionId: 'text', optionIds: [], other: text }]
    })
  })

  it('shows the default hint in an editor box that has no hint of its own', () => {
    render({ ...input, freeTextInput: { allowEmpty: true, multiline: true, initialValue: '' } })
    expect(container.querySelector('textarea')?.placeholder).toBe('Type your answer')
  })

  it('submits the text the user edited in the editor, not its prefill', () => {
    const { onAnswer } = render({
      ...input,
      freeTextInput: { allowEmpty: true, multiline: true, initialValue: 'prefill' }
    })
    const textarea = container.querySelector('textarea')
    if (!textarea) {
      throw new Error('Missing editor textarea')
    }
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(textarea, 'prefill, then edited\nsecond line')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    submit()
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [{ questionId: 'text', optionIds: [], other: 'prefill, then edited\nsecond line' }]
    })
  })

  it.each([false, true])(
    'submits optional blank choices without cancelling or attaching blank text to a preset: %s',
    (pickLast) => {
      const { onAnswer, onCancel } = render([
        {
          id: 'first',
          question: 'First?',
          options: [{ id: 'alpha', label: 'Alpha' }],
          multiSelect: false,
          freeTextQuestionId: 'first',
          freeTextInput: { allowEmpty: true }
        },
        {
          id: 'second',
          question: 'Second?',
          options: [{ id: 'beta', label: 'Beta' }],
          multiSelect: false,
          freeTextQuestionId: 'second',
          freeTextInput: { allowEmpty: true }
        }
      ])
      const advance = () => {
        const button = [...container.querySelectorAll('button')].find((node) =>
          ['Next', 'Skip', 'Submit'].includes(node.textContent?.trim() ?? '')
        )
        if (!button) {
          throw new Error('Missing question action')
        }
        act(() => button.click())
      }
      advance()
      if (pickLast) {
        clickOption('Beta')
      }
      advance()
      expect(onAnswer).toHaveBeenCalledWith({
        kind: 'answers',
        answers: [
          { questionId: 'first', optionIds: [], other: '' },
          pickLast
            ? { questionId: 'second', optionIds: ['beta'] }
            : { questionId: 'second', optionIds: [], other: '' }
        ]
      })
      expect(onCancel).not.toHaveBeenCalled()
    }
  )

  it('keeps legacy empty input disabled', () => {
    const { onAnswer } = render({ ...input, freeTextInput: undefined })
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Submit'
      )
    ).toBe(false)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('keeps select-only questions limited to their offered values', () => {
    const { onAnswer } = render({
      id: 'q1',
      question: 'Select',
      options: [{ id: 'opaque-index-0', label: 'Choice' }],
      multiSelect: false
    })
    expect(container.querySelector('input')).toBeNull()
    const button = container.querySelector('button[aria-pressed]')
    if (!button) {
      throw new Error('Missing choice button')
    }
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    submit()
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [{ questionId: 'q1', optionIds: ['opaque-index-0'] }]
    })
  })
})
