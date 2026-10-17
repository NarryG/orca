// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionCapabilities } from '../../../../shared/agent-session-capabilities'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session-wire'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

const CAPABILITIES: AgentSessionCapabilities = {
  rewind: false,
  compact: false,
  threadGoal: false,
  contextUsage: false,
  imagePrompts: true,
  steering: 'queue',
  approvalEnforcement: 'orca'
}

// A local chat names no paired runtime.
vi.mock('@/store', () => ({ useAppStore: () => null }))
// The host's agent list says Grok takes images; one list, as the store keeps it.
const LISTED = [{ agent: 'grok', capabilities: CAPABILITIES }]
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgentsForRuntime: () => LISTED,
  subscribeHostStructuredAgents: () => () => {}
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

import { useNativeChatStructuredComposerTransport } from './use-native-chat-structured-composer-transport'
import type { useStructuredAgentSession } from './use-structured-agent-session'

function composerAcceptsImages(reported: boolean | undefined): boolean | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building the transport reads only these members; nothing is sent.
  const controller = { acceptsImages: reported } as unknown as ReturnType<
    typeof useStructuredAgentSession
  >
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerTransport({
      props: { agent: 'grok', sessionId: 'session-1', target: { kind: 'local' } },
      controller,
      sendThroughLaunch: () => false,
      starting: false,
      worktreeId: undefined,
      optionPickerRequest: null,
      setOptionPickerRequest: () => {},
      onError: () => {},
      onSubmitted: () => {}
    })
  )
  return result.current.acceptsImages
}

describe('the structured composer image gate', () => {
  it("follows the session's options answer over the host's agent list", () => {
    expect(composerAcceptsImages(false)).toBe(false)
    expect(composerAcceptsImages(true)).toBe(true)
    // No answer yet, or an older host: the agent list decides.
    expect(composerAcceptsImages(undefined)).toBe(true)
  })
})

describe('a command advertised by the running session', () => {
  it.each([false, true])(
    'sends the /fast menu choice with attachments=%s',
    async (withAttachment) => {
      const sessionCommands: AgentSessionSlashCommand[] = [
        {
          name: 'fast',
          kind: 'command',
          description: 'Toggle fast mode',
          argumentHint: '[on|ultra|off|status]'
        }
      ]
      const send = vi.fn(() => true)
      const onError = vi.fn()
      const attachments: NativeChatComposerImageAttachment[] = withAttachment
        ? [{ id: 'shot', path: '/tmp/shot.png' }]
        : []
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exercised transport reads only these controller members.
      const controller = { sessionCommands, optionSnapshot: [], send } as unknown as Parameters<
        typeof useNativeChatStructuredComposerTransport
      >[0]['controller']
      const { result } = renderHook(() => {
        const transport = useNativeChatStructuredComposerTransport({
          props: { agent: 'omp', sessionId: 'session-fast', target: { kind: 'local' } },
          controller,
          sendThroughLaunch: (_text, _withImages, submit) => submit(),
          starting: false,
          worktreeId: undefined,
          optionPickerRequest: null,
          setOptionPickerRequest: () => {},
          onError,
          onSubmitted: () => {}
        })
        const catalog = useNativeChatComposerCatalog('omp', transport)
        const submit = useNativeChatStructuredComposerSend({
          agent: 'omp',
          draftScopeKey: 'session-fast:pane',
          imageAttachments: attachments,
          structuredTransport: transport,
          isComposing: () => false,
          clearSkillOrigin: vi.fn(),
          setDraft: vi.fn(),
          setCaret: vi.fn()
        })
        return { catalog, submit }
      })
      const command = result.current.catalog.agentCommands.find((entry) => entry.name === 'fast')
      expect(command).toBeDefined()
      await result.current.submit(`/${command?.name} status`)
      expect(onError).toHaveBeenCalledWith(null, undefined)
      expect(send).toHaveBeenCalledWith(
        '/fast status',
        withAttachment ? [{ path: '/tmp/shot.png', previewUri: '/tmp/shot.png' }] : []
      )
    }
  )
})
