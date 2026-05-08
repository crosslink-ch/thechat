export function toBullMqQueueName(queueName: string): string {
  return queueName.replace(/:/g, "__");
}

export function toBullMqJobId(jobId: string): string {
  return jobId.replace(/:/g, "__");
}
