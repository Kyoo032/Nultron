/**
 * Which Chat send is the newest one.
 *
 * Each send takes a number from the shared counter and gets back a check that is true only while no
 * later send has started. A run's tail (reload the thread, clear the live reply, free Send) asks it
 * first, so a run that finished late cannot undo the one that began after it.
 */
export function startRun(generation: { current: number }): () => boolean {
  generation.current += 1;
  const mine = generation.current;
  return () => generation.current === mine;
}
