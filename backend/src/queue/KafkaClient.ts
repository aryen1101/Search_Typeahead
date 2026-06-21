import { Kafka,logLevel } from "kafkajs";
import { log } from "../logger";

export function createKafkaClient(clientId: string, brokers: string[]): Kafka {
    return new Kafka({
        clientId,
        brokers,
        logLevel: logLevel.NOTHING,
        retry: {initialRetryTime: 300, retries:12}
    })
}

export async function ensureTopic(
  kafka: Kafka,
  topic: string,
  partitions: number
): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    if (!existing.includes(topic)) {
      await admin.createTopics({
        topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }],
      });
      log.info(`Kafka: created topic "${topic}" (${partitions} partitions)`);
    } else {
      log.info(`Kafka: topic "${topic}" already exists`);
    }
  } finally {
    await admin.disconnect();
  }
}