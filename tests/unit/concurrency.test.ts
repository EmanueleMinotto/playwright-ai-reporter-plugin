import { mapWithConcurrency } from '../../src/concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves the order of the results', async () => {
    const results = await mapWithConcurrency([3, 1, 2], 2, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 10;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return null;
    });

    expect(peak).toBe(2);
  });

  it('handles an empty list and a limit below one', async () => {
    expect(await mapWithConcurrency([], 4, async () => null)).toEqual([]);
    expect(await mapWithConcurrency([1], 0, async (item) => item)).toEqual([1]);
  });
});
