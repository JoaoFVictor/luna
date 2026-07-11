import type { FastifyReply, FastifyRequest } from "fastify";

export async function withStudioRequestAbort<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("Studio HTTP client disconnected"));
    }
  };
  const abortIfResponseIncomplete = () => {
    if (!reply.raw.writableEnded) {
      abort();
    }
  };

  request.raw.once("aborted", abort);
  reply.raw.once("close", abortIfResponseIncomplete);
  try {
    if (request.raw.aborted) {
      abort();
    }
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abortIfResponseIncomplete);
  }
}
