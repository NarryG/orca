import { z } from 'zod'
import type { AgentJournalQuestion } from '../../shared/agent-session-journal-types'
import {
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers
} from '../../shared/agent-session-question-answer'
import { pendingAcpResolution, type AcpRequestPresentation } from './acp-dialects/acp-dialect'
import { AcpRpcError } from './acp-errors'
import {
  MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS,
  MAX_JOURNAL_PROMPT_OPTIONS
} from '../native-chat/agent-session-journal/journal-prompt-body-bounds'

const choiceSchema = z
  .object({
    const: z.string(),
    title: z.string().optional(),
    description: z.string().optional()
  })
  .strict()
const propertySchema = z
  .object({
    type: z.enum(['string', 'boolean', 'number', 'integer', 'array']),
    title: z.string().optional(),
    description: z.string().optional(),
    format: z.string().nullish(),
    default: z.union([z.string(), z.boolean(), z.number()]).optional(),
    enum: z.array(z.string()).nonempty().optional(),
    oneOf: z.array(choiceSchema).nonempty().optional(),
    items: z
      .object({ anyOf: z.array(choiceSchema).nonempty() })
      .strict()
      .optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional()
  })
  .strict()
const formSchema = z.object({
  sessionId: z.string(),
  mode: z.literal('form'),
  message: z.string(),
  requestedSchema: z
    .object({
      type: z.literal('object'),
      properties: z.record(z.string(), propertySchema),
      required: z.array(z.string()).optional()
    })
    .strict()
})

export const ACP_FORM_ELICITATION_METHOD = 'elicitation/create'

/** Only schemas representable by the existing question rows are accepted. */
export function acpFormPresentation(params: unknown): AcpRequestPresentation {
  const parsed = formSchema.safeParse(params)
  if (!parsed.success) {
    throw new AcpRpcError(-32602, 'Unsupported ACP elicitation form')
  }
  const { message, requestedSchema } = parsed.data
  const entries = Object.entries(requestedSchema.properties)
  const required = new Set(requestedSchema.required ?? [])
  if (
    !entries.length ||
    entries.length > MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS * 2 ||
    [...required].some((key) => !Object.hasOwn(requestedSchema.properties, key))
  ) {
    throw new AcpRpcError(-32602, 'Unsupported ACP elicitation form')
  }
  const companionKeys = new Set<string>()
  for (const [key, property] of entries) {
    const otherKey = `${key}__other`
    const other = requestedSchema.properties[otherKey]
    if (
      /^q\d+$/.test(key) &&
      (property.type === 'array' || property.oneOf || property.enum) &&
      other?.type === 'string' &&
      !other.enum &&
      !other.oneOf &&
      !other.items &&
      other.minimum === undefined &&
      other.maximum === undefined &&
      !required.has(key) &&
      !required.has(otherKey)
    ) {
      companionKeys.add(otherKey)
    }
  }
  const questionEntries = entries.filter(([key]) => !companionKeys.has(key))
  if (questionEntries.length > MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS) {
    throw new AcpRpcError(-32602, 'Unsupported ACP elicitation form')
  }
  const fields = questionEntries.map(([key, property], index) => {
    const otherKey = `${key}__other`
    const companion = companionKeys.has(otherKey) ? requestedSchema.properties[otherKey] : undefined
    const textProperty = companion ?? property
    const choices: { const: string; title?: string; description?: string }[] | undefined =
      property.type === 'boolean'
        ? [
            { const: 'true', title: 'Yes' },
            { const: 'false', title: 'No' }
          ]
        : property.type === 'array'
          ? property.items?.anyOf
          : (property.oneOf ?? property.enum?.map((value) => ({ const: value, title: value })))
    if (
      (property.type === 'array' && !choices) ||
      (property.type !== 'array' && property.items) ||
      (property.type !== 'string' && (property.enum || property.oneOf)) ||
      (property.enum && property.oneOf) ||
      (!['number', 'integer'].includes(property.type) &&
        (property.minimum !== undefined || property.maximum !== undefined)) ||
      (choices && new Set(choices.map((choice) => choice.const)).size !== choices.length)
    ) {
      throw new AcpRpcError(-32602, 'Unsupported ACP elicitation property')
    }
    const id = `q${index + 1}`
    const question: AgentJournalQuestion = {
      id,
      question: property.title ?? (questionEntries.length === 1 ? message : key),
      ...(property.description ? { header: property.description } : {}),
      multiSelect: property.type === 'array',
      options: choices
        ? [
            ...choices.map((choice, choiceIndex) => ({
              id: `o${choiceIndex + 1}`,
              label: choice.title ?? choice.const,
              ...(choice.description ? { description: choice.description } : {})
            })),
            ...(property.type === 'array'
              ? [{ id: 'empty', label: 'No selections', exclusive: true }]
              : []),
            ...(!required.has(key) && !companion
              ? [{ id: 'omit', label: 'Leave unset', exclusive: true }]
              : [])
          ]
        : [],
      ...(!choices || companion
        ? {
            freeTextQuestionId: id,
            freeTextInput: {
              allowEmpty: companion
                ? property.type !== 'array' && questionEntries.length > 1
                : textProperty.type === 'string' || !required.has(key),
              multiline: !companion && property.type === 'string',
              ...(textProperty.default !== undefined
                ? { initialValue: String(textProperty.default) }
                : {})
            }
          }
        : {})
    }
    if (question.options.length > MAX_JOURNAL_PROMPT_OPTIONS) {
      throw new AcpRpcError(-32602, 'Unsupported ACP elicitation choices')
    }
    return { key, property, choices, question, otherKey: companion ? otherKey : undefined }
  })
  const questions = fields.map((field) => field.question)
  const body = {
    kind: 'question' as const,
    question: message,
    options: questions[0]!.options,
    questions,
    declineOptionId: 'acp-form-decline',
    resolution: pendingAcpResolution
  }
  return {
    body,
    reply(response) {
      if (!response) {
        return { action: 'cancel' }
      }
      if (response.kind === 'option' && response.optionId === body.declineOptionId) {
        return { action: 'decline' }
      }
      const answers =
        response.kind === 'answers'
          ? response.answers
          : legacyAgentSessionQuestionAnswers(body, response.optionId)
      if (!answers || !isValidAgentSessionQuestionAnswers(questions, answers)) {
        throw new AcpRpcError(-32602, 'Invalid ACP elicitation answer')
      }
      const content: Record<string, string | boolean | number | string[]> = {}
      for (const field of fields) {
        const answer = answers.find((entry) => entry.questionId === field.question.id)!
        if (field.otherKey && answer.other !== undefined) {
          content[field.otherKey] = answer.other
        }
        if (answer.optionIds.includes('omit')) {
          continue
        }
        if (answer.optionIds.includes('empty')) {
          content[field.key] = []
          continue
        }
        const values = answer.optionIds.map((id) => {
          const index = field.question.options.findIndex((option) => option.id === id)
          return field.choices![index]!.const
        })
        if (field.otherKey && values.length === 0) {
          continue
        }
        if (field.property.type === 'array') {
          content[field.key] = values
        } else if (field.property.type === 'boolean') {
          content[field.key] = values[0] === 'true'
        } else if (field.property.type === 'string') {
          const value = values[0] ?? answer.other ?? ''
          if (required.has(field.key) || value !== '') {
            content[field.key] = value
          }
        } else {
          const text = answer.other ?? ''
          if (!required.has(field.key) && text.trim() === '') {
            continue
          }
          const value = Number(text)
          if (
            text.trim() === '' ||
            !Number.isFinite(value) ||
            (field.property.type === 'integer' && !Number.isInteger(value)) ||
            (field.property.minimum !== undefined && value < field.property.minimum) ||
            (field.property.maximum !== undefined && value > field.property.maximum)
          ) {
            throw new AcpRpcError(-32602, 'Invalid ACP elicitation number')
          }
          content[field.key] = value
        }
      }
      return { action: 'accept', content }
    }
  }
}
