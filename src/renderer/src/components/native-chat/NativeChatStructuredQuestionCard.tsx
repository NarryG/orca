import type { RefObject } from 'react'
import type { AgentJournalQuestion } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session-question-answer'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'

export function NativeChatStructuredQuestionCard({
  questions,
  onAnswer,
  onCancel,
  declineOptionId,
  isSubmitting,
  shouldFocus,
  answerInputRef
}: {
  questions: readonly AgentJournalQuestion[]
  onAnswer: (response: AgentSessionPromptResponse) => void
  onCancel: () => void
  declineOptionId?: string
  isSubmitting?: boolean
  shouldFocus?: boolean
  answerInputRef?: RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  return (
    <NativeChatQuestionCard
      prompt={{
        questions: questions.map((question) => ({
          question: question.question,
          ...(question.header ? { header: question.header } : {}),
          multiSelect: question.multiSelect,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            ...(option.exclusive ? { exclusive: true } : {})
          }))
        }))
      }}
      allowOther={questions.map((question) => Boolean(question.freeTextQuestionId))}
      freeTextInputs={questions.map((question) => question.freeTextInput)}
      onAnswer={(answers) => {
        const chosen = questions.map((question, index) => {
          const answer = answers[index]
          const other = question.freeTextInput?.allowEmpty ? answer?.other : answer?.other?.trim()
          return {
            questionId: question.id,
            optionIds: (answer?.indices ?? []).flatMap((optionIndex) => {
              const id = question.options[optionIndex]?.id
              return id ? [id] : []
            }),
            ...(other !== undefined &&
            (other.length > 0 ||
              (question.freeTextInput?.allowEmpty && answer?.indices?.length === 0))
              ? { other }
              : {})
          }
        })
        if (chosen.every((answer) => answer.optionIds.length > 0 || answer.other !== undefined)) {
          onAnswer({ kind: 'answers', answers: chosen })
        }
      }}
      onCancel={onCancel}
      onDecline={
        declineOptionId ? () => onAnswer({ kind: 'option', optionId: declineOptionId }) : undefined
      }
      isSubmitting={isSubmitting}
      shouldFocus={shouldFocus}
      answerInputRef={answerInputRef}
    />
  )
}
