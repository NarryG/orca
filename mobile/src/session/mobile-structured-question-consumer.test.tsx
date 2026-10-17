import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextInput } from 'react-native'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { mobileChatQuestionKey } from './mobile-native-chat-question'
import {
  projectStructuredQuestion,
  type StructuredQuestionItem
} from './mobile-structured-agent-prompts'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import {
  advanceGroupedQuestion,
  type GroupedQuestionDraft
} from './mobile-structured-grouped-question'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  CircleHelp: 'CircleHelp',
  X: 'X'
}))

let renderer: ReactTestRenderer
let responses: {
  groupedDraft: GroupedQuestionDraft | null
  respondQuestion: (answer: string) => Promise<boolean>
}
const cancel = vi.fn(async () => true)

function prompt(): StructuredQuestionItem {
  return {
    itemId: 'form',
    revision: 4,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'question',
      question: 'Choose targets',
      options: [],
      declineOptionId: 'opaque:decline',
      questions: [
        {
          id: 'targets',
          question: 'Targets?',
          multiSelect: true,
          freeTextQuestionId: 'targets',
          options: [
            { id: 'web', label: 'Web' },
            { id: 'mobile', label: 'Mobile' },
            { id: 'none', label: 'No selections', exclusive: true }
          ]
        }
      ],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}

function Probe(props: {
  prompt: StructuredQuestionItem
  mutate: StructuredAgentSessionMutate
  supported?: boolean | null
  actionablePromptIds?: StructuredAgentSessionState['actionablePromptIds']
}) {
  const stateRef = useRef(EMPTY_STRUCTURED_AGENT_SESSION)
  stateRef.current = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    status: 'ready',
    items: [props.prompt],
    ...(props.actionablePromptIds ? { actionablePromptIds: props.actionablePromptIds } : {})
  }
  responses = useMobileStructuredPromptResponses({
    stateRef,
    sessionKey: 'session',
    mutate: props.mutate,
    questionAnswersSupported: props.supported ?? null,
    onSendError: vi.fn()
  })
  const question = projectStructuredQuestion(props.prompt, responses.groupedDraft)
  return question
    ? createElement(MobileNativeChatQuestion, {
        key: mobileChatQuestionKey(question),
        question,
        onAnswer: responses.respondQuestion,
        onCancel: cancel
      })
    : null
}

function mount(item = prompt(), supported: boolean | null = true) {
  const sent: Record<string, unknown>[] = []
  const mutate: StructuredAgentSessionMutate = async (_method, _fingerprint, fields) => {
    sent.push(fields)
    return { status: 'rejected' }
  }
  act(() => {
    renderer = create(createElement(Probe, { prompt: item, mutate, supported }))
  })
  return { sent, mutate }
}

async function pick(index: number) {
  await act(async () =>
    renderer.root.findAllByProps({ accessibilityRole: 'checkbox' })[index]!.props.onPress()
  )
}
async function press(label: string) {
  await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress())
}

afterEach(() => {
  act(() => renderer?.unmount())
  vi.clearAllMocks()
})

describe('structured mobile question consumer', () => {
  it.each([
    { picks: [0, 2], ids: ['none'] },
    { picks: [2, 0, 1], ids: ['web', 'mobile'] },
    { picks: [0, 1, 2], ids: ['none'] }
  ])('submits exclusive choices separately: $picks', async ({ picks, ids }) => {
    const { sent } = mount()
    for (const index of picks) {
      await pick(index)
    }
    await press('Submit selected options')
    expect(sent).toEqual([
      {
        itemId: 'form',
        expectedRevision: 4,
        answers: [{ questionId: 'targets', optionIds: ids }]
      }
    ])
  })

  it.each([true, false])(
    'keeps Other separate from exclusive choices (typed first=%s)',
    async (typedFirst) => {
      const { sent } = mount()
      if (!typedFirst) {
        await pick(2)
      }
      await act(async () => renderer.root.findByType(TextInput).props.onChangeText('Custom'))
      if (typedFirst) {
        await pick(2)
      }
      await press(typedFirst ? 'Submit selected options' : 'Send reply')
      expect(sent[0]?.answers).toEqual([
        {
          questionId: 'targets',
          optionIds: typedFirst ? ['none'] : [],
          ...(typedFirst ? {} : { other: 'Custom' })
        }
      ])
    }
  )

  it('rejects an invalid early step before it can poison the remaining draft', async () => {
    const item = prompt()
    item.body.questions!.push({
      id: 'next',
      question: 'Next?',
      multiSelect: false,
      options: [{ id: 'ok', label: 'OK' }]
    })
    const { sent } = mount(item)
    const card = projectStructuredQuestion(item)!
    const invalid = `${card.optionTokens[0]}, ${card.optionTokens[2]}`
    await act(async () => expect(await responses.respondQuestion(invalid)).toBe(false))
    expect(responses.groupedDraft).toBeNull()
    expect(sent).toEqual([])
    await pick(0)
    await press('Submit selected options')
    expect(responses.groupedDraft?.answers).toEqual([{ questionId: 'targets', optionIds: ['web'] }])
    expect(renderer.root.findByType(MobileNativeChatQuestion).props.question.question).toContain(
      'Next?'
    )
  })

  it.each([true, false, null])(
    'sends Decline as the existing option transport (answers support=%s)',
    async (supported) => {
      const item = prompt()
      item.body.questions!.push({
        id: 'next',
        question: 'Next?',
        multiSelect: false,
        options: [{ id: 'ok', label: 'OK' }]
      })
      const { sent } = mount(item, supported)
      await pick(0)
      await press('Submit selected options')
      await press('Decline request')
      expect(sent).toEqual([{ itemId: 'form', expectedRevision: 4, optionId: 'opaque:decline' }])
      expect(cancel).not.toHaveBeenCalled()
      // A rejected refusal keeps the user's accumulated answers available.
      expect(responses.groupedDraft?.answers).toHaveLength(1)
      await press('Cancel')
      expect(cancel).toHaveBeenCalledWith({ itemId: 'form', expectedRevision: 4 })
      expect(sent).toHaveLength(1)
    }
  )

  it.each([
    { kind: 'question-option', questionId: '', optionId: 'opaque:decline' },
    { kind: 'question-decline', optionId: 7 }
  ])('rejects old or malformed decline tokens without a mutation: %j', async (payload) => {
    const { sent } = mount()
    const token = `structured-agent-prompt:${encodeURIComponent(
      JSON.stringify({ itemId: 'form', revision: 4, ...payload })
    )}`
    await act(async () => expect(await responses.respondQuestion(token)).toBe(false))
    expect(sent).toEqual([])
  })

  it('does not send a stale decline after a revision changes', async () => {
    const item = prompt()
    const token = projectStructuredQuestion(item)!.declineToken!
    const { sent, mutate } = mount(item)
    act(() => renderer.update(createElement(Probe, { prompt: { ...item, revision: 5 }, mutate })))
    await act(async () => expect(await responses.respondQuestion(token)).toBe(false))
    expect(sent).toEqual([])
  })

  it('does not send a decline once the host retires the actionable prompt', async () => {
    const item = prompt()
    const token = projectStructuredQuestion(item)!.declineToken!
    const { sent, mutate } = mount(item)
    act(() =>
      renderer.update(createElement(Probe, { prompt: item, mutate, actionablePromptIds: [] }))
    )
    await act(async () => expect(await responses.respondQuestion(token)).toBe(false))
    expect(sent).toEqual([])
  })

  it('discards collected answers after an unconfirmed decline leaves the phone', async () => {
    const item = prompt()
    item.body.questions!.push({
      id: 'next',
      question: 'Next?',
      multiSelect: false,
      options: [{ id: 'ok', label: 'OK' }]
    })
    mount(item)
    await pick(0)
    await press('Submit selected options')
    expect(responses.groupedDraft?.answers).toHaveLength(1)
    const mutate: StructuredAgentSessionMutate = async () => ({ status: 'unknown' })
    act(() => renderer.update(createElement(Probe, { prompt: item, mutate })))
    await press('Decline request')
    expect(responses.groupedDraft).toBeNull()
    expect(renderer.root.findByType(MobileNativeChatQuestion).props.question.question).toContain(
      'Targets?'
    )
  })

  it('keeps older prompts without decline or exclusivity unchanged', async () => {
    const item = prompt()
    delete item.body.declineOptionId
    delete item.body.questions![0]!.options[2]!.exclusive
    const { sent } = mount(item)
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Decline request' })).toHaveLength(0)
    await pick(0)
    await pick(2)
    await press('Submit selected options')
    expect(sent[0]).toMatchObject({
      answers: [{ questionId: 'targets', optionIds: ['web', 'none'] }]
    })
  })

  it.each([true, false])(
    'allows empty default text through the single-question wire (answers support=%s)',
    async (supported) => {
      const item = prompt()
      delete item.body.questions
      item.body.freeTextQuestionId = 'input'
      item.body.freeTextInput = {
        allowEmpty: true,
        multiline: true,
        initialValue: '',
        placeholder: 'Write here'
      }
      const { sent } = mount(item, supported)
      expect(renderer.root.findByType(TextInput).props).toMatchObject({
        value: '',
        placeholder: 'Write here',
        multiline: true,
        returnKeyType: 'default'
      })
      expect(renderer.root.findByType(TextInput).props.onSubmitEditing).toBeUndefined()
      await press('Send reply')
      expect(sent).toEqual([
        {
          itemId: 'form',
          expectedRevision: 4,
          ...(supported
            ? { answers: [{ questionId: 'input', optionIds: [], other: '' }] }
            : { optionId: 'input:' })
        }
      ])
    }
  )

  it.each([false, true])(
    'preserves grouped default and empty text with choices=%s',
    async (choices) => {
      const item = prompt()
      if (!choices) {
        item.body.questions![0]!.options = []
      }
      item.body.questions![0]!.multiSelect = false
      item.body.questions![0]!.freeTextInput = {
        allowEmpty: true,
        multiline: true,
        initialValue: '  draft\n'
      }
      const { sent } = mount(item)
      expect(renderer.root.findByType(TextInput).props.value).toBe('  draft\n')
      await press('Send reply')
      expect(sent[0]).toMatchObject({
        answers: [{ questionId: 'targets', optionIds: [], other: '  draft\n' }]
      })
      const card = projectStructuredQuestion(item)!
      expect(
        advanceGroupedQuestion({
          response: `${card.freeTextToken}:`,
          questions: item.body.questions!,
          draft: null,
          promptKey: 'form:4'
        })
      ).toEqual({ kind: 'submit', answers: [{ questionId: 'targets', optionIds: [], other: '' }] })
    }
  )
})
