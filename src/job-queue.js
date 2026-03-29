export function createSerialJobQueue(worker) {
  let tail = Promise.resolve();

  return function enqueue(job) {
    const runJob = () => worker(job);
    const result = tail.then(runJob, runJob);

    tail = result.catch(() => {});

    return result;
  };
}
