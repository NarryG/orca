import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function NativeChatQuestionOptionRow({
  badge,
  initialFocus,
  label,
  description,
  selected,
  disabled,
  onSelect
}: {
  badge: string
  initialFocus: boolean
  label: string
  description?: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      // Selection is otherwise only the visual check/badge swap; expose it to
      // assistive tech.
      aria-pressed={selected}
      data-native-chat-prompt-card-focus-target={initialFocus || undefined}
      className={cn(
        'flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors focus:bg-accent focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring disabled:pointer-events-none',
        selected ? 'bg-accent' : 'hover:bg-accent'
      )}
    >
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-medium',
          selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        )}
      >
        {selected ? <Check className="size-3.5" strokeWidth={3} /> : badge}
      </span>
      <span className="min-w-0">
        <span className="block break-words text-sm text-foreground">{label}</span>
        {description ? (
          <span className="block break-words text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </button>
  )
}
