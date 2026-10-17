import { z } from 'zod'
import { AcpAgentError, AcpAuthRequiredError, AcpInvalidResponseError } from './acp-errors'
import type { AcpJsonRpcPeer } from './acp-json-rpc-peer'

const idSchema = z.union([z.string(), z.number(), z.null()])
const errorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional()
})
export const acpRpcEnvelopeSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: idSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional()
})
export type AcpJsonRpcMessage = z.infer<typeof acpRpcEnvelopeSchema>

export function invalidAcpResponseEnvelope(raw: unknown): () => Error {
  return () => new AcpInvalidResponseError('Invalid ACP response envelope', raw)
}

export function settleAcpResponse(
  frame: AcpJsonRpcMessage,
  pending: { resolve: (value: unknown) => void; reject: (error: Error) => void },
  diagnose: (message: string) => void
): void {
  if ('error' in frame) {
    const parsed = errorSchema.safeParse(frame.error)
    if (!parsed.success) {
      diagnose('Invalid ACP error response')
      pending.reject(new AcpInvalidResponseError('Invalid ACP error response', frame.error))
    } else {
      const error = parsed.data
      pending.reject(new AcpAgentError(error.code, error.message, error.data))
    }
  } else {
    pending.resolve(frame.result)
  }
}

export async function requestAcpResponse<T>(
  peer: Pick<AcpJsonRpcPeer, 'request'>,
  method: string,
  params: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const result = await peer.request(method, params, { timeoutMs: null }).catch((error) => {
    if (error instanceof AcpAgentError && error.code === -32000) {
      throw new AcpAuthRequiredError(error.message, error.data)
    }
    throw error
  })
  const parsed = schema.safeParse(result)
  if (!parsed.success) {
    throw new AcpInvalidResponseError(
      `Invalid ACP response: ${method}`,
      result,
      parsed.error.issues
    )
  }
  return parsed.data
}
