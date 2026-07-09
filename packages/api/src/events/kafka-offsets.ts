export interface KafkaSourceOffset {
  topic: string;
  partition: number;
  offset: string;
}

export interface KafkaOffsetCommit {
  topic: string;
  partition: number;
  offset: string;
}

export async function processKafkaMessageAndCommit(
  source: KafkaSourceOffset,
  processMessage: () => Promise<void>,
  commitOffsets: (offsets: KafkaOffsetCommit[]) => Promise<void>,
): Promise<void> {
  await processMessage();
  await commitOffsets([
    {
      topic: source.topic,
      partition: source.partition,
      offset: (BigInt(source.offset) + 1n).toString(),
    },
  ]);
}
