import { z } from 'zod'
import { Identifier } from './structured-agent-session-identifiers'
import { MAX_PROMPT_BYTES } from './structured-agent-session-message-params'
import {
  AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES,
  AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH as MAX_RESPONSE_OPTION_ID_LENGTH,
  decodeAgentSessionQuestionAnswers,
  GROUP_ANSWER_PREFIX
} from '../agent-session-question-answer'

/** Matches the journal's bounds on one grouped prompt. */
const MAX_QUESTION_ANSWER_QUESTIONS = 4
const MAX_QUESTION_ANSWER_OPTIONS = 64

const QuestionAnswer = z
  .object({
    // Codex question ids are model-written and untrimmed; the host matches them exactly.
    questionId: z
      .string()
      .min(1, 'Invalid question id')
      .max(MAX_RESPONSE_OPTION_ID_LENGTH, 'Invalid question id'),
    optionIds: z
      .array(Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH))
      .max(MAX_QUESTION_ANSWER_OPTIONS),
    // Hashed verbatim by both peers, so no trim or transform here.
    other: z
      .string()
      .max(AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES)
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES,
        'Answer is too large'
      )
      .optional()
  })
  .strict()

export const QuestionAnswers = z
  .array(QuestionAnswer)
  .min(1)
  .max(MAX_QUESTION_ANSWER_QUESTIONS)
  .refine(
    (answers) => Buffer.byteLength(JSON.stringify(answers), 'utf8') <= MAX_PROMPT_BYTES,
    'Answer is too large'
  )

const ScalarQuestionOptionId = Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH)
export const QuestionOptionId = z.string().refine((value) => {
  if (
    value.length <= MAX_RESPONSE_OPTION_ID_LENGTH &&
    ScalarQuestionOptionId.safeParse(value).success
  ) {
    return true
  }
  // Older clients percent-encode every UTF-8 byte; cap before decoding their JSON.
  if (value.length > GROUP_ANSWER_PREFIX.length + MAX_PROMPT_BYTES * 3) {
    return false
  }
  const answers = decodeAgentSessionQuestionAnswers(value)
  return answers !== null && QuestionAnswers.safeParse(answers).success
}, 'Invalid option id')
