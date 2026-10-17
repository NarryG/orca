import { afterEach, describe, expect, it } from 'vitest'
import { acpFormPresentation } from './acp-form-elicitation'
import { acpLaunchSpecFor } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello
} from './acp-structured-adapter.test-support'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)
const form = (properties: Record<string, unknown>, required?: string[]) => ({
  sessionId: PROVIDER_SESSION,
  mode: 'form',
  message: 'Review the plan',
  requestedSchema: { type: 'object', properties, ...(required ? { required } : {}) }
})

describe('ACP form questions', () => {
  it.each(['grok', 'opencode'])('does not advertise unverified forms to %s', async (agent) => {
    const rig = await openAcpAdapterRig({ spec: acpLaunchSpecFor(agent)! })
    await rig.acquire()
    expect(rig.sent('initialize')[0]?.params).not.toHaveProperty('clientCapabilities.elicitation')
  })

  it('sends a human plan decision and rejects foreign-session or unsupported requests without rows', async () => {
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('omp')!,
      launch: { fullAccess: true }
    })
    await rig.acquire()
    await sendHello(rig, 'first')
    await rig.frame('session/prompt')
    const agent = rig.child().agent
    const params = form(
      { value: { type: 'string', enum: ['Approve and execute', 'Refine plan'] } },
      ['value']
    )
    expect(
      await agent.request(60, 'elicitation/create', { ...params, sessionId: 'other-session' })
    ).toMatchObject({ error: { code: -32602 } })
    expect(
      await agent.request(61, 'elicitation/create', form({ value: { type: 'object' } }))
    ).toMatchObject({ error: { code: -32602 } })
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'question')).toHaveLength(0)
    const requested = agent.request(62, 'elicitation/create', params)
    await rig.settle()
    const question = (await rig.rig.rows()).find((row) => row.body.kind === 'question')!
    await rig.adapter.answerPrompt({
      sessionId: SESSION,
      fence: 1,
      itemId: question.itemId,
      kind: 'question',
      response: {
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: ['o2'] }]
      },
      commit: async () => {}
    })
    expect(await requested).toMatchObject({
      result: { action: 'accept', content: { value: 'Refine plan' } }
    })
  })

  it('converts four fields of booleans, choices, numbers and multi choices to typed content', () => {
    const presentation = acpFormPresentation(
      form(
        {
          confirm: { type: 'boolean' },
          choice: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] },
          count: { type: 'integer', minimum: 1 },
          many: { type: 'array', items: { anyOf: [{ const: 'a' }, { const: 'b' }] } }
        },
        ['confirm', 'choice', 'count', 'many']
      )
    )
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['o2'] },
          { questionId: 'q2', optionIds: ['o1'] },
          { questionId: 'q3', optionIds: [], other: '3' },
          { questionId: 'q4', optionIds: ['o1', 'o2'] }
        ]
      })
    ).toEqual({
      action: 'accept',
      content: {
        confirm: false,
        choice: 'a',
        count: 3,
        many: ['a', 'b']
      }
    })
    expect(presentation.reply(null)).toEqual({ action: 'cancel' })
  })

  it('delivers a human decline without requiring answers or stopping the turn', async () => {
    const rig = await openAcpAdapterRig({ spec: acpLaunchSpecFor('omp')! })
    await rig.acquire()
    await sendHello(rig, 'first')
    await rig.frame('session/prompt')
    const requested = rig
      .child()
      .agent.request(63, 'elicitation/create', form({ confirm: { type: 'boolean' } }, ['confirm']))
    await rig.settle()
    const question = (await rig.rig.rows()).find((row) => row.body.kind === 'question')!
    await rig.adapter.answerPrompt({
      sessionId: SESSION,
      fence: 1,
      itemId: question.itemId,
      kind: 'question',
      response: { kind: 'option', optionId: 'acp-form-decline' },
      commit: async () => {}
    })
    expect(await requested).toMatchObject({ result: { action: 'decline' } })
    expect(rig.sent('session/cancel')).toHaveLength(0)
  })

  it('folds native OMP ask companions into three answerable questions', () => {
    const presentation = acpFormPresentation(
      form({
        q0: { type: 'string', title: 'First choice', oneOf: [{ const: 'a' }] },
        q0__other: { type: 'string', title: 'Une autre réponse' },
        q1: { type: 'array', title: 'Multiple choices', items: { anyOf: [{ const: 'x' }] } },
        q1__other: { type: 'string', title: 'Other (type your own)' },
        q2: { type: 'string', title: 'Last choice', oneOf: [{ const: 'b' }] },
        q2__other: { type: 'string', title: 'Other (type your own)' }
      })
    )
    expect(presentation.body).toMatchObject({
      questions: [
        { id: 'q1', question: 'First choice', freeTextQuestionId: 'q1' },
        { id: 'q2', question: 'Multiple choices', freeTextQuestionId: 'q2' },
        { id: 'q3', question: 'Last choice', freeTextQuestionId: 'q3' }
      ]
    })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: [], other: 'custom' },
          { questionId: 'q2', optionIds: ['o1'], other: 'also' },
          { questionId: 'q3', optionIds: ['o1'] }
        ]
      })
    ).toEqual({
      action: 'accept',
      content: { q0__other: 'custom', q1: ['x'], q1__other: 'also', q2: 'b' }
    })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: [], other: '' },
          { questionId: 'q2', optionIds: ['empty'] },
          { questionId: 'q3', optionIds: ['o1'] }
        ]
      })
    ).toEqual({ action: 'accept', content: { q0__other: '', q1: [], q2: 'b' } })
  })

  it.each([
    {
      other: { type: 'string', enum: ['custom'] },
      required: undefined,
      answer: { questionId: 'q2', optionIds: ['o1'] }
    },
    {
      other: { type: 'string' },
      required: ['q0__other'],
      answer: { questionId: 'q2', optionIds: [], other: 'custom' }
    }
  ])('does not fold a companion with its own choices or required presence: %j', (testCase) => {
    const presentation = acpFormPresentation(
      form(
        { q0: { type: 'string', enum: ['preset'] }, q0__other: testCase.other },
        testCase.required
      )
    )
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: ['o1'] }, testCase.answer]
      })
    ).toEqual({ action: 'accept', content: { q0: 'preset', q0__other: 'custom' } })
  })

  it('accepts an unknown string format without inventing format validation', () => {
    const presentation = acpFormPresentation(
      form({ value: { type: 'string', format: 'provider-specific-format' } }, ['value'])
    )
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [], other: 'value' }]
      })
    ).toEqual({ action: 'accept', content: { value: 'value' } })
  })

  it('distinguishes empty required and optional arrays from an omitted property', () => {
    const answer = (required: boolean, optionId: string) => {
      const presentation = acpFormPresentation(
        form(
          { targets: { type: 'array', items: { anyOf: [{ const: 'web' }] } } },
          required ? ['targets'] : []
        )
      )
      const question = presentation.body.kind === 'question' && presentation.body.questions?.[0]
      const option = question && question.options.find((entry) => entry.id === optionId)
      if (!question || !option) {
        throw new Error(`Missing array answer: ${optionId}`)
      }
      return presentation.reply({
        kind: 'answers',
        answers: [{ questionId: question.id, optionIds: [option.id] }]
      })
    }
    expect(answer(true, 'empty')).toEqual({ action: 'accept', content: { targets: [] } })
    expect(answer(false, 'empty')).toEqual({ action: 'accept', content: { targets: [] } })
    expect(answer(false, 'omit')).toEqual({ action: 'accept', content: {} })
  })

  it('refuses forms that cannot fit the journal and response contract', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`field${index}`, { type: 'boolean' }])
    )
    expect(() => acpFormPresentation(form(properties))).toThrowError(
      expect.objectContaining({ code: -32602 })
    )
  })

  it('refuses choices that would truncate a synthetic empty-array answer', () => {
    expect(() =>
      acpFormPresentation(
        form(
          {
            targets: {
              type: 'array',
              items: {
                anyOf: Array.from({ length: 64 }, (_, index) => ({ const: `target${index}` }))
              }
            }
          },
          ['targets']
        )
      )
    ).toThrowError(expect.objectContaining({ code: -32602 }))
  })

  it('refuses a required field that is not an own schema property', () => {
    expect(() =>
      acpFormPresentation(form({ value: { type: 'string' } }, ['toString']))
    ).toThrowError(expect.objectContaining({ code: -32602 }))
  })

  it.each([
    ['omit', 'o1'],
    ['empty', 'o1'],
    ['empty', 'omit']
  ])('rejects mixed synthetic array choices from older clients: %j', (...optionIds) => {
    const presentation = acpFormPresentation(
      form({ targets: { type: 'array', items: { anyOf: [{ const: 'web' }] } } })
    )
    expect(() =>
      presentation.reply({
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds }]
      })
    ).toThrowError(expect.objectContaining({ code: -32602 }))
  })

  it.each([
    { value: { type: 'object' } },
    { value: { type: 'string', pattern: '.*' } },
    { value: { type: 'array', items: { type: 'string' } } }
  ])('refuses unsupported schemas without accepting them', (properties) => {
    expect(() => acpFormPresentation(form(properties))).toThrowError(
      expect.objectContaining({ code: -32602 })
    )
  })

  it('rejects invalid numeric answers rather than coercing empty input to zero', () => {
    const presentation = acpFormPresentation(
      form({ value: { type: 'integer', minimum: 1 } }, ['value'])
    )
    for (const other of ['', 'NaN', '0', '1.5']) {
      expect(() =>
        presentation.reply({
          kind: 'answers',
          answers: [{ questionId: 'q1', optionIds: [], other }]
        })
      ).toThrowError(expect.objectContaining({ code: -32602 }))
    }
  })

  it.each([false, true])(
    'keeps OMP plan review human under fullAccess=%s and cancels on Stop',
    async (fullAccess) => {
      const rig = await openAcpAdapterRig({
        spec: acpLaunchSpecFor('omp')!,
        launch: { fullAccess }
      })
      await rig.acquire()
      expect(rig.sent('initialize')[0]?.params).toMatchObject({
        clientCapabilities: { elicitation: { form: {} } }
      })
      await sendHello(rig, 'first')
      await rig.frame('session/prompt')
      const requested = rig.child().agent.request(
        51,
        'elicitation/create',
        form(
          {
            value: { type: 'string', enum: ['Approve and execute', 'Refine plan'] }
          },
          ['value']
        )
      )
      await rig.settle()
      const question = (await rig.rig.rows()).find((row) => row.body.kind === 'question')
      expect(question?.body).toMatchObject({ resolution: { state: 'pending' } })
      await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })
      expect(await requested).toMatchObject({ result: { action: 'cancel' } })
      const late = await rig
        .child()
        .agent.request(52, 'elicitation/create', form({ value: { type: 'boolean' } }))
      expect(late).toMatchObject({ result: { action: 'cancel' } })
      await expect(
        rig.adapter.answerPrompt({
          sessionId: SESSION,
          fence: 1,
          itemId: question!.itemId,
          kind: 'question',
          response: { kind: 'option', optionId: 'o1' },
          commit: async () => {}
        })
      ).rejects.toThrow(/no longer waiting/)
    }
  )
})
