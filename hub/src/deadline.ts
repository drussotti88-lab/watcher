/**
 * Answering late is worse than answering badly.
 *
 * A serverless function that runs past its limit does not get to write the
 * error. Vercel writes it, as a plain-text page:
 *
 *   An error occurred with your deployment
 *   FUNCTION_INVOCATION_TIMEOUT
 *
 * That arrives at the Watcher with a 504 and no JSON, which is how a wedged
 * database connection got read as a parse error three layers away from its
 * cause. Getting in front of the platform's timeout means the Hub keeps the
 * pen: it can say what went wrong, in the shape the caller expects, and clean
 * up the connection on the way out.
 */

export interface DeadlineOptions {
  ms: number;
  /** Called once, on timeout only. Where the connection gets dropped. */
  onTimeout?: () => void;
  /** The answer to give instead. Built lazily so nothing is allocated in vain. */
  late: () => Response;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * Race real work against the clock.
 *
 * The work is not cancelled — there is nothing to cancel a query with here,
 * and pretending otherwise would be worse than admitting it. It is abandoned:
 * the caller gets an answer, and `onTimeout` throws away the connection it was
 * using so the next request does not inherit the problem.
 */
export async function withDeadline(work: Promise<Response>, opts: DeadlineOptions): Promise<Response> {
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let firedLate = false;

  const late = new Promise<Response>((resolve) => {
    timer = setTimer(() => {
      firedLate = true;
      opts.onTimeout?.();
      resolve(opts.late());
    }, opts.ms);
  });

  try {
    return await Promise.race([work, late]);
  } finally {
    if (!firedLate) clearTimer(timer as never);
    // An abandoned query still rejects eventually. Swallow it here rather than
    // letting it surface as an unhandled rejection and take the instance down.
    void work.catch(() => {});
  }
}
