/**
 * The error a promise rejects with, as a value to assert on (its class, its
 * status, its `cause`). Unlike `.catch((e) => e)`, a promise that RESOLVES fails
 * here with a message saying so, instead of handing the caller a result and
 * letting a later assertion fail for a reason that hides it.
 */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}
